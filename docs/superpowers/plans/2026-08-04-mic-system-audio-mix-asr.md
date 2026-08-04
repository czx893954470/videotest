# Mic + System Audio Mixing ASR Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `electron-recorder/` to capture microphone + system (loopback) audio, mix them in real time, stream the mixed PCM to the ASR WebSocket backend, and save the mixed audio as a WAV file simultaneously.

**Architecture:** capture.exe gains a `stream` subcommand that resamples WASAPI loopback to 16kHz mono float32 and writes it to stdout. Electron main spawns capture.exe, forwards stdout chunks to the renderer via IPC. The renderer captures the mic via `getUserMedia`, mixes mic + system audio in an AudioWorklet, sends mixed PCM to the ASR WebSocket (port from `asr_demo.html`), and streams mixed PCM back to main for WAV backup.

**Tech Stack:** Electron 31, Node 22, C#/.NET 8 + NAudio 2.2.1, Web Audio API (AudioWorklet), WebSocket.

**Spec:** [docs/superpowers/specs/2026-08-04-mic-system-audio-mix-asr-design.md](../specs/2026-08-04-mic-system-audio-mix-asr-design.md)

---

## File Structure

| File | Responsibility | New/Modified |
|------|---------------|--------------|
| `electron-recorder/capture/Program.cs` | C# entry; adds `stream` subcommand | Modified |
| `electron-recorder/wav-utils.js` | Pure WAV header + float32→int16 PCM conversion (Node, used by main) | New |
| `electron-recorder/test/wav-utils.test.js` | Node tests for wav-utils | New |
| `electron-recorder/main.js` | Electron main; adds system-audio + WAV save IPC handlers | Modified |
| `electron-recorder/preload.js` | contextBridge; exposes new IPC to renderer | Modified |
| `electron-recorder/mixer-processor.js` | AudioWorklet processor: ring buffer + mix mic+system | New |
| `electron-recorder/index.html` | UI: device select, ASR controls, transcript panel | Modified |
| `electron-recorder/renderer.js` | Renderer: getUserMedia, WebSocket, mixer orchestration | Modified |
| `electron-recorder/test-system-audio.js` | Manual test script for system-audio IPC (like test-protocol.js) | New |

---

### Task 1: capture.exe `stream` subcommand (C#)

**Files:**
- Modify: `electron-recorder/capture/Program.cs`

- [ ] **Step 1: Add `stream` branch to Program.cs**

Open `electron-recorder/capture/Program.cs` and insert this branch **before** the final `Console.Error.WriteLine($"Unknown command: {command}")` line (i.e., after the `record` block closes at line 80):

```csharp
if (command == "stream")
{
    if (args.Length < 2)
    {
        Console.Error.WriteLine("Usage: capture.exe stream <deviceId>");
        return 1;
    }

    var deviceId = args[1];
    var enumerator = new MMDeviceEnumerator();
    MMDevice? device;
    try
    {
        device = enumerator.GetDevice(deviceId);
    }
    catch (Exception ex)
    {
        Console.Error.WriteLine($"Device not found: {deviceId}. {ex.Message}");
        return 1;
    }

    // WASAPI loopback captures at the device's mix format (typically 48kHz stereo float32).
    // We resample to 16kHz mono float32 for the ASR backend.
    var capture = new WasapiLoopbackCapture(device);
    var outFormat = WaveFormat.CreateIeeeFloatWaveFormat(16000, 1);

    // BufferedWaveProvider bridges the push-based capture to the pull-based resampler.
    var bufferProvider = new BufferedWaveProvider(capture.WaveFormat)
    {
        BufferDuration = TimeSpan.FromSeconds(2),
        DiscardOnBufferOverflow = true
    };
    var resampler = new MediaFoundationResampler(bufferProvider, outFormat);

    // Binary stdout - keep this stream pure, no text writes to stdout.
    var stdout = Console.OpenStandardOutput();
    var stopRequested = false;
    var captureDone = new ManualResetEventSlim(false);
    var pumpDone = new ManualResetEventSlim(false);

    capture.DataAvailable += (s, e) =>
    {
        if (e.BytesRecorded > 0)
        {
            bufferProvider.AddSamples(e.Buffer, 0, e.BytesRecorded);
        }
    };
    capture.RecordingStopped += (s, e) => captureDone.Set();

    capture.StartRecording();
    // READY goes to stderr so stdout stays pure binary.
    Console.Error.WriteLine("READY");
    Console.Error.Flush();

    // Background thread pulls resampled float32 PCM and writes to stdout.
    var readBuffer = new byte[6400]; // 100ms @ 16kHz mono float32 = 1600 samples * 4 bytes
    var pumpThread = new Thread(() =>
    {
        while (true)
        {
            // On stop, drain resampler tail then exit.
            if (stopRequested && bufferProvider.BufferedBytes == 0)
            {
                int r;
                while ((r = resampler.Read(readBuffer, 0, readBuffer.Length)) > 0)
                {
                    stdout.Write(readBuffer, 0, r);
                }
                break;
            }

            int read = resampler.Read(readBuffer, 0, readBuffer.Length);
            if (read > 0)
            {
                stdout.Write(readBuffer, 0, read);
                stdout.Flush();
            }
            else if (!stopRequested)
            {
                Thread.Sleep(10); // No data yet; avoid busy-looping.
            }
        }
        pumpDone.Set();
    });
    pumpThread.IsBackground = true;
    pumpThread.Start();

    // Wait for "stop" on stdin.
    string? line;
    while ((line = Console.In.ReadLine()) != null)
    {
        if (line.Trim().Equals("stop", StringComparison.OrdinalIgnoreCase))
        {
            stopRequested = true;
            break;
        }
    }

    capture.StopRecording();
    captureDone.Wait(5000);
    pumpDone.Wait(5000);
    stdout.Flush();
    return 0;
}
```

- [ ] **Step 2: Add `using NAudio.MediaFoundation;` if missing**

At the top of `Program.cs`, ensure the using directives include:

```csharp
using System.Threading;
using NAudio.CoreAudioApi;
using NAudio.MediaFoundation;
using NAudio.Wave;
```

(`MediaFoundationResampler` lives in `NAudio.MediaFoundation`.)

- [ ] **Step 3: Build capture.exe**

Run from `electron-recorder/`:

```bash
npm run build:capture
```

Expected: `bin/capture/capture.exe` is created/updated, exit code 0.

- [ ] **Step 4: Manually verify `stream` mode produces float32 PCM**

Get a device ID first (note one from the output):

```bash
node -e "const {spawn}=require('child_process');const c=spawn('bin/capture/capture.exe',['list']);c.stdout.on('data',d=>process.stdout.write(d));c.stderr.on('data',d=>process.stderr.write(d));"
```

Expected: lines like `{0.0.0.00000000}.{guid}|Speaker Name`. Copy one device ID.

Then run stream mode for 3 seconds (replace `<deviceId>`):

```bash
node -e "const {spawn}=require('child_process');const c=spawn('bin/capture/capture.exe',['stream','<deviceId>']);let chunks=0;c.stdout.on('data',d=>{chunks++;if(chunks<=2)console.log('chunk bytes:',d.length)});c.stderr.on('data',d=>process.stderr.write('stderr: '+d));c.on('close',code=>console.log('exit',code,'chunks',chunks));setTimeout(()=>{c.stdin.write('stop\n');c.stdin.end()},3000);"
```

Expected: stderr contains `READY`; stdout emits chunks of float32 bytes (multiples of 4); total bytes over 3s is roughly `16000 * 4 * 3 = 192000` (±20%); exit code 0.

- [ ] **Step 5: Commit**

```bash
git add electron-recorder/capture/Program.cs
git commit -m "feat(capture): add stream subcommand for real-time 16kHz mono float32 output

Streams WASAPI loopback audio resampled to 16kHz mono float32 via stdout,
ready for real-time ASR. READY signal goes to stderr to keep stdout pure binary."
```

---

### Task 2: wav-utils.js (TDD)

**Files:**
- Create: `electron-recorder/wav-utils.js`
- Create: `electron-recorder/test/wav-utils.test.js`

- [ ] **Step 1: Write failing test for `createWavHeader`**

Create `electron-recorder/test/wav-utils.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert');
const { createWavHeader, float32ToInt16Pcm } = require('../wav-utils.js');

test('createWavHeader writes canonical 44-byte PCM header', () => {
  const header = createWavHeader(16000, 1, 16000); // 1s of 16kHz mono 16-bit PCM
  assert.equal(header.length, 44);
  assert.equal(header.toString('ascii', 0, 4), 'RIFF');
  assert.equal(header.toString('ascii', 8, 12), 'WAVE');
  assert.equal(header.toString('ascii', 12, 16), 'fmt ');
  assert.equal(header.readUInt32LE(16), 16);        // fmt chunk size
  assert.equal(header.readUInt16LE(20), 1);         // PCM format
  assert.equal(header.readUInt16LE(22), 1);         // mono
  assert.equal(header.readUInt32LE(24), 16000);     // sample rate
  assert.equal(header.readUInt32LE(28), 32000);     // byte rate = 16000*1*2
  assert.equal(header.readUInt16LE(32), 2);         // block align = 1*2
  assert.equal(header.readUInt16LE(34), 16);        // bits per sample
  assert.equal(header.toString('ascii', 36, 40), 'data');
  assert.equal(header.readUInt32LE(40), 16000);     // data chunk size
  // RIFF chunk size = 36 + data size
  assert.equal(header.readUInt32LE(4), 36 + 16000);
});

test('float32ToInt16Pcm converts float samples to int16 LE', () => {
  const input = new Float32Array([0, 0.5, -0.5, 1.0, -1.0]);
  const out = float32ToInt16Pcm(input);
  assert.equal(out.length, 10); // 5 samples * 2 bytes
  assert.equal(out.readInt16LE(0), 0);
  assert.equal(out.readInt16LE(2), 16384);       // 0.5 * 32767 ≈ 16384
  assert.equal(out.readInt16LE(4), -16384);      // -0.5 * 32767 ≈ -16384
  assert.equal(out.readInt16LE(6), 32767);       // 1.0 clamped
  assert.equal(out.readInt16LE(8), -32768);      // -1.0 clamped
});

test('float32ToInt16Pcm clamps out-of-range floats', () => {
  const input = new Float32Array([2.0, -2.0]);
  const out = float32ToInt16Pcm(input);
  assert.equal(out.readInt16LE(0), 32767);
  assert.equal(out.readInt16LE(2), -32768);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run from `electron-recorder/`:

```bash
node --test test/wav-utils.test.js
```

Expected: 3 tests FAIL with `Cannot find module '../wav-utils.js'`.

- [ ] **Step 3: Implement wav-utils.js**

Create `electron-recorder/wav-utils.js`:

```js
// Pure helpers for WAV file writing. Used by main process.
// 16-bit PCM mono format at arbitrary sample rate.

// Returns the canonical 44-byte WAV header for the given data size.
function createWavHeader(sampleRate, numChannels, dataChunkSize) {
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * bitsPerSample / 8;
  const blockAlign = numChannels * bitsPerSample / 8;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataChunkSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);                    // PCM
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataChunkSize, 40);
  return header;
}

// Converts Float32 samples (-1.0..1.0) to 16-bit signed little-endian PCM bytes.
// Out-of-range values are clamped.
function float32ToInt16Pcm(float32Array) {
  const out = Buffer.alloc(float32Array.length * 2);
  for (let i = 0; i < float32Array.length; i++) {
    let s = Math.max(-1, Math.min(1, float32Array[i]));
    // Asymmetric int16 range: positive max 32767, negative max -32768.
    s = s < 0 ? s * 0x8000 : s * 0x7FFF;
    out.writeInt16LE(Math.round(s), i * 2);
  }
  return out;
}

module.exports = { createWavHeader, float32ToInt16Pcm };
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
node --test test/wav-utils.test.js
```

Expected: 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add electron-recorder/wav-utils.js electron-recorder/test/wav-utils.test.js
git commit -m "feat(wav-utils): add WAV header + float32→int16 PCM helpers with tests"
```

---

### Task 3: main.js - system-audio IPC handlers

**Files:**
- Modify: `electron-recorder/main.js`

- [ ] **Step 1: Add `start-system-audio` handler**

In `electron-recorder/main.js`, after the existing `stop-recording` handler (end of file), add:

```js
// ─── System audio streaming (for ASR) ───────────────────────────────
// Spawns capture.exe in stream mode, forwards stdout float32 PCM to renderer.

ipcMain.handle('start-system-audio', async (event, deviceId) => {
  if (captureProcess) {
    throw new Error('capture.exe already running');
  }
  if (!deviceId) {
    throw new Error('deviceId required');
  }

  return new Promise((resolve, reject) => {
    const child = spawn(CAPTURE_EXE, ['stream', deviceId]);
    let ready = false;
    let stderr = '';

    child.stderr.on('data', d => {
      const text = d.toString();
      stderr += text;
      if (!ready && text.includes('READY')) {
        ready = true;
        captureProcess = child;
        resolve({ ok: true });
      }
    });

    // Forward stdout binary chunks to renderer as Float32Array.
    child.stdout.on('data', buf => {
      if (!ready) return; // Don't send before READY (shouldn't happen, but guard).
      if (mainWindow && !mainWindow.isDestroyed()) {
        // Slice to a fresh ArrayBuffer (the underlying Buffer may be reused).
        const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        mainWindow.webContents.send('system-audio-chunk', new Float32Array(ab));
      }
    });

    child.on('error', err => {
      if (!ready) reject(new Error(`无法启动 capture.exe：${err.message}`));
    });

    child.on('close', code => {
      captureProcess = null;
      if (!ready) {
        reject(new Error(`capture.exe stream 启动失败（exit ${code}）：${stderr}`));
        return;
      }
      // Notify renderer that the stream ended (may be unexpected if mid-recording).
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('system-audio-stopped', { code });
      }
    });
  });
});

// Stop system audio capture: send "stop\n" and let close event fire.
ipcMain.handle('stop-system-audio', async () => {
  if (!captureProcess) return { ok: false };
  try {
    captureProcess.stdin.write('stop\n');
    captureProcess.stdin.end();
  } catch {}
  return { ok: true };
});
```

- [ ] **Step 2: Manually verify with a test script**

Create `electron-recorder/test-system-audio.js`:

```js
// Standalone test: spawn capture.exe stream mode, count chunks, verify float32.
// Usage: node test-system-audio.js <deviceId>
const { spawn } = require('child_process');
const path = require('path');

const deviceId = process.argv[2];
if (!deviceId) {
  console.error('Usage: node test-system-audio.js <deviceId>');
  process.exit(1);
}

const CAPTURE = path.join(__dirname, 'bin', 'capture', 'capture.exe');
const child = spawn(CAPTURE, ['stream', deviceId]);
let ready = false;
let totalBytes = 0;
let chunks = 0;
let badFloats = 0;

child.stderr.on('data', d => {
  const text = d.toString();
  process.stderr.write('stderr: ' + text);
  if (!ready && text.includes('READY')) {
    ready = true;
    console.log('READY received, recording 3s...');
    setTimeout(() => {
      console.log('sending stop...');
      child.stdin.write('stop\n');
      child.stdin.end();
    }, 3000);
  }
});

child.stdout.on('data', buf => {
  chunks++;
  totalBytes += buf.length;
  // Spot-check first chunk: every 4 bytes should be a finite float in [-1, 1].
  if (chunks === 1 && buf.length >= 16) {
    const f32 = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + Math.min(buf.length, 64)));
    for (let i = 0; i < f32.length; i++) {
      if (!Number.isFinite(f32[i]) || Math.abs(f32[i]) > 1.5) badFloats++;
    }
    console.log('first chunk samples:', Array.from(f32.slice(0, 4)));
  }
});

child.on('close', code => {
  console.log(`exit=${code}, chunks=${chunks}, totalBytes=${totalBytes}, badFloats=${badFloats}`);
  console.log(`expected ~${16000 * 4 * 3} bytes for 3s @ 16kHz mono float32`);
});
```

Run (replace `<deviceId>` with one from `capture.exe list`):

```bash
cd electron-recorder
node test-system-audio.js "<deviceId>"
```

Expected: stderr `READY`; 3s later `sending stop...`; exit code 0; `totalBytes` within ±30% of 192000; `badFloats` is 0.

- [ ] **Step 3: Commit**

```bash
git add electron-recorder/main.js electron-recorder/test-system-audio.js
git commit -m "feat(main): add start/stop-system-audio IPC handlers for capture.exe stream mode"
```

---

### Task 4: main.js - WAV save IPC handlers

**Files:**
- Modify: `electron-recorder/main.js`

- [ ] **Step 1: Add requires and module-level state at top of main.js**

At the top of `electron-recorder/main.js`, after the existing `const { spawn } = require('child_process');` line, add:

```js
const fs = require('fs');
const { createWavHeader, float32ToInt16Pcm } = require('./wav-utils.js');
```

Then, near the existing module-level variables (`let mainWindow = null;` etc.), add:

```js
let wavFd = null;        // file descriptor for the open WAV file
let wavPath = null;      // path to the WAV file (returned to renderer on stop)
let wavDataBytes = 0;    // running total of PCM data bytes written
```

- [ ] **Step 2: Add WAV save handlers at end of main.js**

Append to `electron-recorder/main.js` (after the system-audio handlers):

```js
// ─── Mixed-audio WAV backup ────────────────────────────────────────
// Renderer sends mixed float32 chunks; main writes 16-bit PCM WAV.
// Header is written with size=0 placeholder and patched on stop.

// Internal: finalize WAV (patch header, close fd). Returns saved path or null.
// Called from the IPC handler AND before-quit. Safe to call when not open.
function stopWavSaveInternal() {
  if (wavFd === null) return null;
  // Patch RIFF chunk size (offset 4) and data chunk size (offset 40).
  const sizeBuf = Buffer.alloc(4);
  sizeBuf.writeUInt32LE(36 + wavDataBytes, 0);
  fs.writeSync(wavFd, sizeBuf, 0, 4, 4);
  sizeBuf.writeUInt32LE(wavDataBytes, 0);
  fs.writeSync(wavFd, sizeBuf, 0, 4, 40);
  fs.closeSync(wavFd);
  const savedPath = wavPath;
  wavFd = null;
  wavPath = null;
  wavDataBytes = 0;
  return savedPath;
}

ipcMain.handle('start-wav-save', async () => {
  if (wavFd !== null) {
    throw new Error('WAV file already open');
  }
  const result = await dialog.showSaveDialog(mainWindow, {
    title: '保存录音',
    defaultPath: `recording-${Date.now()}.wav`,
    filters: [{ name: 'WAV', extensions: ['wav'] }],
  });
  if (result.canceled || !result.filePath) {
    return { ok: false, canceled: true };
  }
  wavPath = result.filePath;
  wavDataBytes = 0;
  // 'w' creates/truncates; fs.writeSync with explicit position seeks, so we
  // can patch the header later without reopening.
  wavFd = fs.openSync(wavPath, 'w');
  // Placeholder header (data size = 0); patched on stop.
  const header = createWavHeader(16000, 1, 0);
  fs.writeSync(wavFd, header, 0, 44, 0);
  return { ok: true, path: wavPath };
});

// Renderer pushes mixed float32 chunks; convert to int16 and append.
ipcMain.on('mixed-audio-chunk', (event, float32Array) => {
  if (wavFd === null) return;
  const pcm = float32ToInt16Pcm(float32Array);
  fs.writeSync(wavFd, pcm, 0, pcm.length, null); // null position = append
  wavDataBytes += pcm.length;
});

ipcMain.handle('stop-wav-save', async () => {
  const savedPath = stopWavSaveInternal();
  if (savedPath === null) return { ok: false };
  return { ok: true, path: savedPath };
});
```

- [ ] **Step 3: Update `before-quit` handler to also finalize WAV**

Find the existing `app.on('before-quit', ...)` block in `main.js` and replace it with this version that also finalizes the WAV file:

```js
app.on('before-quit', (event) => {
  if (isQuitting) return;
  const needsCaptureStop = captureProcess && !captureProcess.killed;
  const needsWavStop = wavFd !== null;
  if (needsCaptureStop || needsWavStop) {
    event.preventDefault();
    isQuitting = true;
    Promise.resolve()
      .then(() => needsCaptureStop ? stopCaptureProcess() : null)
      .then(() => {
        if (needsWavStop) {
          try { stopWavSaveInternal(); } catch {}
        }
      })
      .then(() => app.quit());
  }
});
```

- [ ] **Step 4: Manually verify WAV save works**

Quick smoke test from a Node REPL (not a full Electron run):

```bash
cd electron-recorder
node -e "
const fs = require('fs');
const { createWavHeader, float32ToInt16Pcm } = require('./wav-utils.js');
const fd = fs.openSync('test-wav.wav', 'w');
fs.writeSync(fd, createWavHeader(16000, 1, 0), 0, 44, 0);
// Write 1 second of 440Hz sine wave as float32
const samples = new Float32Array(16000);
for (let i = 0; i < samples.length; i++) samples[i] = Math.sin(2*Math.PI*440*i/16000) * 0.3;
const pcm = float32ToInt16Pcm(samples);
fs.writeSync(fd, pcm, 0, pcm.length, null);
// Patch sizes
const sizeBuf = Buffer.alloc(4);
sizeBuf.writeUInt32LE(36 + pcm.length, 0);
fs.writeSync(fd, sizeBuf, 0, 4, 4);
sizeBuf.writeUInt32LE(pcm.length, 0);
fs.writeSync(fd, sizeBuf, 0, 4, 40);
fs.closeSync(fd);
console.log('wrote test-wav.wav, size:', fs.statSync('test-wav.wav').size);
"
```

Expected: `wrote test-wav.wav, size: 32044` (44 header + 32000 PCM). The file should play in any media player as a 1-second 440Hz tone.

- [ ] **Step 5: Commit**

```bash
git add electron-recorder/main.js
git commit -m "feat(main): add WAV save IPC handlers (start-wav-save, mixed-audio-chunk, stop-wav-save)"
```

---

### Task 5: Extend preload.js

**Files:**
- Modify: `electron-recorder/preload.js`

- [ ] **Step 1: Add new IPC bridges to window.api**

Replace the entire contents of `electron-recorder/preload.js` with:

```js
const { contextBridge, ipcRenderer } = require('electron');

// Expose a restricted API surface to the renderer via contextBridge.
// Renderer can only call these methods; no direct ipcRenderer or Node access.
contextBridge.exposeInMainWorld('api', {
  // ─── Device enumeration (existing) ───
  getDevices: () => ipcRenderer.invoke('get-devices'),

  // ─── System audio streaming (new) ───
  startSystemAudio: (deviceId) => ipcRenderer.invoke('start-system-audio', deviceId),
  stopSystemAudio: () => ipcRenderer.invoke('stop-system-audio'),
  onSystemAudioChunk: (cb) => {
    const handler = (e, f32) => cb(f32);
    ipcRenderer.on('system-audio-chunk', handler);
    return () => ipcRenderer.removeListener('system-audio-chunk', handler);
  },
  onSystemAudioStopped: (cb) => {
    const handler = (e, payload) => cb(payload);
    ipcRenderer.on('system-audio-stopped', handler);
    return () => ipcRenderer.removeListener('system-audio-stopped', handler);
  },

  // ─── Mixed-audio WAV backup (new) ───
  startWavSave: () => ipcRenderer.invoke('start-wav-save'),
  sendMixedChunk: (f32) => ipcRenderer.send('mixed-audio-chunk', f32),
  stopWavSave: () => ipcRenderer.invoke('stop-wav-save'),

  // ─── Legacy file-based recording (kept for reference; unused in new flow) ───
  startRecording: (deviceId) => ipcRenderer.invoke('start-recording', deviceId),
  stopRecording: () => ipcRenderer.invoke('stop-recording'),
  onRecordingStopped: (cb) => {
    const handler = (e, payload) => cb(payload);
    ipcRenderer.on('recording-stopped', handler);
    return () => ipcRenderer.removeListener('recording-stopped', handler);
  },
});
```

- [ ] **Step 2: Commit**

```bash
git add electron-recorder/preload.js
git commit -m "feat(preload): expose system-audio and WAV save IPC to renderer"
```

---

### Task 6: mixer-processor.js (AudioWorklet)

**Files:**
- Create: `electron-recorder/mixer-processor.js`

- [ ] **Step 1: Create the AudioWorklet processor**

Create `electron-recorder/mixer-processor.js`:

```js
// AudioWorklet processor: mixes microphone (input 0) with system audio
// (fed via port messages into a ring buffer) and posts the mixed 128-sample
// block back to the main thread on each process() call.
//
// Sample rate is 16kHz (set by the AudioContext in renderer). Render quantum
// is 128 samples = 8ms. Output is mono float32.
//
// Messages from main thread:
//   { type: 'system', samples: Float32Array }  -> append to ring buffer
// Messages to main thread:
//   { type: 'mixed', samples: Float32Array }   -> one 128-sample block per process()

const RING_SIZE = 16384; // ~1s at 16kHz; large enough to absorb IPC jitter

class MixerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ring = new Float32Array(RING_SIZE);
    this.readPos = 0;
    this.writePos = 0;
    this.port.onmessage = (e) => {
      if (e.data.type === 'system') {
        this._pushRing(e.data.samples);
      }
    };
  }

  // Append samples to ring; on overflow, drop oldest by advancing readPos.
  _pushRing(samples) {
    const n = samples.length;
    const free = (this.readPos - this.writePos + RING_SIZE) % RING_SIZE;
    if (n > free) {
      // Drop oldest samples to make room.
      const drop = n - free;
      this.readPos = (this.readPos + drop) % RING_SIZE;
    }
    for (let i = 0; i < n; i++) {
      this.ring[this.writePos] = samples[i];
      this.writePos = (this.writePos + 1) % RING_SIZE;
    }
  }

  // Read up to `n` samples from ring; zero-fill if underflow.
  _readRing(out, n) {
    const available = (this.writePos - this.readPos + RING_SIZE) % RING_SIZE;
    const toRead = Math.min(n, available);
    for (let i = 0; i < toRead; i++) {
      out[i] = this.ring[this.readPos];
      this.readPos = (this.readPos + 1) % RING_SIZE;
    }
    for (let i = toRead; i < n; i++) {
      out[i] = 0; // underflow -> silence
    }
  }

  process(inputs, outputs) {
    const micInput = inputs[0];
    const micCh = (micInput && micInput.length > 0) ? micInput[0] : null;
    const out = outputs[0][0];

    // Reuse a temp buffer for system samples (128 = render quantum).
    if (!this._sysTemp || this._sysTemp.length !== out.length) {
      this._sysTemp = new Float32Array(out.length);
    }
    this._readRing(this._sysTemp, out.length);

    // Equal-weight mix: 0.5 * mic + 0.5 * system.
    for (let i = 0; i < out.length; i++) {
      const mic = micCh ? micCh[i] : 0;
      out[i] = 0.5 * mic + 0.5 * this._sysTemp[i];
    }

    // Post mixed block back to main thread (copy to detach from output buffer).
    const mixed = new Float32Array(out.length);
    mixed.set(out);
    this.port.postMessage({ type: 'mixed', samples: mixed }, [mixed.buffer]);

    return true;
  }
}

registerProcessor('mixer-processor', MixerProcessor);
```

- [ ] **Step 2: Commit**

```bash
git add electron-recorder/mixer-processor.js
git commit -m "feat(worklet): add mixer-processor AudioWorklet for mic+system mixing"
```

---

### Task 7: Rewrite index.html

**Files:**
- Modify: `electron-recorder/index.html`

- [ ] **Step 1: Replace index.html with ASR-focused UI**

Replace the entire contents of `electron-recorder/index.html` with:

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>实时语音识别（麦克风 + 系统音频）</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
      background: #1a1a2e;
      color: #eee;
      min-height: 100vh;
      padding: 20px;
    }
    .container { max-width: 900px; margin: 0 auto; }
    .header {
      display: flex; justify-content: space-between; align-items: center;
      margin-bottom: 20px;
    }
    h1 { font-size: 22px; font-weight: 500; }
    .status {
      padding: 6px 12px; border-radius: 20px; font-size: 13px; background: #333;
    }
    .status.connected { background: #2ecc71; color: #000; }
    .status.disconnected { background: #e74c3c; }
    .status.recording { background: #f39c12; color: #000; }
    .row { margin: 12px 0; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    label { font-size: 13px; color: #aaa; }
    select, input[type="text"] {
      padding: 6px 10px; font-size: 13px; background: #2a2a4e;
      color: #eee; border: 1px solid #444; border-radius: 4px;
    }
    select { min-width: 200px; }
    input[type="text"] { width: 220px; }
    button {
      padding: 10px 22px; font-size: 14px; cursor: pointer;
      border: none; border-radius: 6px; transition: background 0.2s;
    }
    .btn-start { background: #3498db; color: #fff; }
    .btn-start:hover { background: #2980b9; }
    .btn-start:disabled { background: #555; cursor: not-allowed; }
    .btn-stop { background: #e74c3c; color: #fff; }
    .btn-stop:hover { background: #c0392b; }
    .btn-stop:disabled { background: #555; cursor: not-allowed; }
    .btn-secondary { background: #5f6368; color: #fff; }
    .btn-secondary:hover { background: #3c4043; }
    .info {
      font-size: 12px; color: #888; margin-top: 6px;
    }
    .transcript {
      background: #16213e; border-radius: 12px; padding: 20px;
      margin-top: 16px; min-height: 300px; max-height: 500px; overflow-y: auto;
    }
    .transcript::-webkit-scrollbar { width: 8px; }
    .transcript::-webkit-scrollbar-track { background: #1a1a2e; }
    .transcript::-webkit-scrollbar-thumb { background: #333; border-radius: 4px; }
    .sentence { margin-bottom: 14px; line-height: 1.6; }
    .sentence.final { color: #eee; }
    .sentence.interim {
      color: #888; border-left: 3px solid #3498db; padding-left: 12px;
    }
    .empty { color: #666; text-align: center; padding: 80px 0; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>实时语音识别（麦克风 + 系统音频）</h1>
      <span class="status disconnected" id="status">未连接</span>
    </div>

    <div class="row">
      <label>系统音频设备：</label>
      <select id="device" disabled>
        <option>加载中…</option>
      </select>
      <button class="btn-secondary" id="refreshBtn">刷新设备</button>
    </div>

    <div class="row">
      <label>识别语言：</label>
      <select id="asrLang">
        <option value="zh">中文</option>
        <option value="en">English</option>
        <option value="hu">Hungarian</option>
        <option value="ms">Malay</option>
        <option value="es">Spanish</option>
      </select>
      <label>翻译：</label>
      <select id="targetLang">
        <option value="">不翻译</option>
        <option value="zh">中文</option>
        <option value="en">English</option>
      </select>
      <label>ASR 服务器：</label>
      <input type="text" id="serverUrl" value="ws://192.168.4.58:8080/ws/asr">
    </div>

    <div class="row">
      <button class="btn-start" id="startBtn" disabled>开始录音</button>
      <button class="btn-stop" id="stopBtn" disabled>停止录音</button>
    </div>

    <div class="info" id="info">就绪。</div>

    <div class="transcript" id="transcript">
      <div class="empty">点击"开始录音"开始识别</div>
    </div>
  </div>

  <script src="renderer.js"></script>
</body>
</html>
```

- [ ] **Step 2: Commit**

```bash
git add electron-recorder/index.html
git commit -m "feat(ui): rewrite index.html for ASR with device selector and transcript panel"
```

---

### Task 8: Rewrite renderer.js

**Files:**
- Modify: `electron-recorder/renderer.js`

- [ ] **Step 1: Replace renderer.js with ASR + mixer orchestration**

Replace the entire contents of `electron-recorder/renderer.js` with:

```js
// Renderer: orchestrates mic capture, system-audio IPC, AudioWorklet mixing,
// ASR WebSocket, and WAV backup. UI lives in index.html.

const deviceSelect = document.getElementById('device');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const refreshBtn = document.getElementById('refreshBtn');
const statusSpan = document.getElementById('status');
const infoEl = document.getElementById('info');
const transcriptDiv = document.getElementById('transcript');
const asrLangSelect = document.getElementById('asrLang');
const targetLangSelect = document.getElementById('targetLang');
const serverUrlInput = document.getElementById('serverUrl');

let ws = null;
let audioContext = null;
let micStream = null;
let workletNode = null;
let isRecording = false;
let unsubscribeSystemAudio = null;
let unsubscribeSystemStopped = null;

// ASR sentence state (ported from asr_demo.html)
const sentences = new Map();      // sentenceId -> { text, isFinal }
const translations = new Map();   // sentenceId -> { text, isFinal }
let latestSentenceId = 0;

function setStatus(text, kind) {
  statusSpan.textContent = text;
  statusSpan.className = 'status' + (kind ? ' ' + kind : '');
}

function setInfo(text) {
  infoEl.textContent = text;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function updateDisplay() {
  let html = '';
  const sortedIds = Array.from(sentences.keys()).sort((a, b) => a - b);
  for (const sid of sortedIds) {
    const s = sentences.get(sid);
    const t = translations.get(sid);
    const text = t ? t.text : s.text;
    if (s.isFinal) {
      html += `<div class="sentence final">${escapeHtml(text)}</div>`;
    } else if (sid === latestSentenceId && !s.isFinal) {
      html += `<div class="sentence interim">${escapeHtml(text)}</div>`;
    }
  }
  transcriptDiv.innerHTML = html || '<div class="empty">等待识别中...</div>';
  transcriptDiv.scrollTop = transcriptDiv.scrollHeight;
}

function handlePass1(sentenceId, text) {
  latestSentenceId = sentenceId;
  if (!sentences.has(sentenceId)) {
    sentences.set(sentenceId, { text, isFinal: false });
    return;
  }
  const s = sentences.get(sentenceId);
  if (s.isFinal) return;
  if (text !== s.text) {
    if (text.startsWith(s.text)) s.text = text;
    else s.text = s.text + text;
  }
}

function handlePass2(sentenceId, text) {
  sentences.set(sentenceId, { text, isFinal: true });
  if (sentenceId >= latestSentenceId) latestSentenceId = sentenceId + 1;
}

function handleTrans(sentenceId, text, isFinal) {
  if (!translations.has(sentenceId)) {
    translations.set(sentenceId, { text, isFinal });
    return;
  }
  const t = translations.get(sentenceId);
  if (t.isFinal) return;
  if (text !== t.text) {
    if (text.startsWith(t.text)) t.text = text;
    else t.text = t.text + text;
  }
  t.isFinal = isFinal;
}

function connectWebSocket() {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(serverUrlInput.value);
    ws.onopen = () => {
      ws.send(JSON.stringify({
        type: 'session_start',
        language: asrLangSelect.value,
        prompt: '会议场景',
        target_language: targetLangSelect.value,
      }));
    };
    ws.onmessage = (event) => {
      const data = typeof event.data === 'string' ? JSON.parse(event.data) : null;
      if (!data) return;
      if (data.type === 'session_started') {
        resolve();
        return;
      }
      if (data.type === 'asr') {
        if (data.pass === 1) handlePass1(data.sentence_id, data.text);
        else handlePass2(data.sentence_id, data.text);
        updateDisplay();
      } else if (data.type === 'trans') {
        handleTrans(data.sentence_id, data.text, data.is_final);
        updateDisplay();
      }
    };
    ws.onerror = (err) => reject(err);
    ws.onclose = () => {
      if (isRecording) stopRecording();
      setStatus('未连接', 'disconnected');
    };
  });
}

async function loadDevices() {
  deviceSelect.disabled = true;
  startBtn.disabled = true;
  refreshBtn.disabled = true;
  deviceSelect.innerHTML = '<option>加载中…</option>';
  setStatus('加载设备…', 'disconnected');
  try {
    const devices = await window.api.getDevices();
    deviceSelect.innerHTML = '';
    if (devices.length === 0) {
      setInfo('未发现任何输出设备。');
      return;
    }
    for (const d of devices) {
      const opt = document.createElement('option');
      opt.value = d.id;
      opt.textContent = d.name;
      deviceSelect.appendChild(opt);
    }
    deviceSelect.disabled = false;
    startBtn.disabled = false;
    refreshBtn.disabled = false;
    setStatus('就绪', 'disconnected');
    setInfo(`发现 ${devices.length} 个输出设备。`);
  } catch (e) {
    setInfo(`加载设备失败：${e.message}`);
  }
}

async function startRecording() {
  const deviceId = deviceSelect.value;
  if (!deviceId) {
    setInfo('请先选择系统音频设备。');
    return;
  }

  setInfo('连接 ASR 服务…');
  setStatus('连接中…', 'disconnected');
  startBtn.disabled = true;

  try {
    // 1. WebSocket first (fail-fast if backend down).
    await connectWebSocket();
    setStatus('已连接', 'connected');

    // 2. WAV save (fail-fast if user cancels or disk error).
    setInfo('选择保存位置…');
    const wavResult = await window.api.startWavSave();
    if (!wavResult.ok) {
      if (wavResult.canceled) {
        setInfo('已取消。');
      } else {
        setInfo('启动 WAV 保存失败。');
      }
      ws.close();
      ws = null;
      startBtn.disabled = false;
      setStatus('未连接', 'disconnected');
      return;
    }

    // 3. Mic capture.
    setInfo('请求麦克风权限…');
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        sampleRate: 16000,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    // 4. AudioContext + worklet.
    audioContext = new AudioContext({ sampleRate: 16000 });
    await audioContext.audioWorklet.addModule('mixer-processor.js');

    workletNode = new AudioWorkletNode(audioContext, 'mixer-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
    });

    // 5. Wire mixed output -> WS + WAV.
    workletNode.port.onmessage = (e) => {
      if (e.data.type !== 'mixed') return;
      const mixed = e.data.samples;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(mixed.buffer);
      }
      window.api.sendMixedChunk(mixed);
    };

    // 6. Wire system-audio IPC -> worklet ring buffer.
    unsubscribeSystemAudio = window.api.onSystemAudioChunk((f32) => {
      if (workletNode) {
        // Copy to detach from IPC-owned buffer before transfer.
        const copy = new Float32Array(f32.length);
        copy.set(f32);
        workletNode.port.postMessage({ type: 'system', samples: copy }, [copy.buffer]);
      }
    });

    // 7. Handle unexpected system-audio stop (e.g. device unplugged).
    unsubscribeSystemStopped = window.api.onSystemAudioStopped(({ code }) => {
      if (isRecording) {
        setInfo(`系统音频流意外结束（exit ${code}），正在停止…`);
        stopRecording();
      }
    });

    // 8. Connect mic -> worklet.
    const micSource = audioContext.createMediaStreamSource(micStream);
    micSource.connect(workletNode);
    workletNode.connect(audioContext.destination);

    // 9. Start system audio LAST (chunks flow immediately after).
    setInfo('启动系统音频采集…');
    await window.api.startSystemAudio(deviceId);

    isRecording = true;
    stopBtn.disabled = false;
    refreshBtn.disabled = true;
    deviceSelect.disabled = true;
    setStatus('录音中', 'recording');
    setInfo(`录音中。WAV 将保存到：${wavResult.path}`);
  } catch (e) {
    setInfo(`启动失败：${e.message}`);
    setStatus('未连接', 'disconnected');
    startBtn.disabled = false;
    // Cleanup anything partially started.
    await cleanupPartial();
  }
}

async function cleanupPartial() {
  if (workletNode) { try { workletNode.disconnect(); } catch {} workletNode = null; }
  if (audioContext) { try { await audioContext.close(); } catch {} audioContext = null; }
  if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
  if (unsubscribeSystemAudio) { unsubscribeSystemAudio(); unsubscribeSystemAudio = null; }
  if (unsubscribeSystemStopped) { unsubscribeSystemStopped(); unsubscribeSystemStopped = null; }
  try { await window.api.stopSystemAudio(); } catch {}
  try { await window.api.stopWavSave(); } catch {}
  if (ws) { try { ws.close(); } catch {} ws = null; }
}

async function stopRecording() {
  if (!isRecording) return;
  isRecording = false;
  stopBtn.disabled = true;
  setInfo('正在停止…');

  if (workletNode) { try { workletNode.disconnect(); } catch {} workletNode = null; }
  if (audioContext) { try { await audioContext.close(); } catch {} audioContext = null; }
  if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
  if (unsubscribeSystemAudio) { unsubscribeSystemAudio(); unsubscribeSystemAudio = null; }
  if (unsubscribeSystemStopped) { unsubscribeSystemStopped(); unsubscribeSystemStopped = null; }

  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify({ type: 'end_input' })); } catch {}
    setTimeout(() => { try { ws.close(); } catch {} ws = null; }, 500);
  } else {
    ws = null;
  }

  try { await window.api.stopSystemAudio(); } catch {}
  let wavPath = '';
  try {
    const r = await window.api.stopWavSave();
    if (r.ok) wavPath = r.path;
  } catch (e) {
    setInfo(`WAV 保存失败：${e.message}`);
  }

  setStatus('未连接', 'disconnected');
  startBtn.disabled = false;
  refreshBtn.disabled = false;
  deviceSelect.disabled = false;
  setInfo(wavPath ? `录音完成，已保存：${wavPath}` : '录音已停止。');
}

startBtn.addEventListener('click', startRecording);
stopBtn.addEventListener('click', stopRecording);
refreshBtn.addEventListener('click', loadDevices);

asrLangSelect.addEventListener('change', () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'change_language', language: asrLangSelect.value }));
  }
});

targetLangSelect.addEventListener('change', () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'change_target_language', target_language: targetLangSelect.value }));
  }
});

loadDevices();
```

- [ ] **Step 2: Commit**

```bash
git add electron-recorder/renderer.js
git commit -m "feat(renderer): port ASR WebSocket logic, wire mic+system mixer and WAV backup"
```

---

### Task 9: End-to-end manual verification

**Files:** (no code changes - verification only)

- [ ] **Step 1: Rebuild capture.exe with the stream subcommand**

```bash
cd electron-recorder
npm run build:capture
```

Expected: exit 0, `bin/capture/capture.exe` updated.

- [ ] **Step 2: Run unit tests**

```bash
cd electron-recorder
node --test test/wav-utils.test.js
```

Expected: 3 tests PASS.

- [ ] **Step 3: Launch the Electron app**

```bash
cd electron-recorder
npm start
```

Expected: window opens, "实时语音识别（麦克风 + 系统音频）" title, device dropdown populated, status "就绪".

- [ ] **Step 4: Verify the golden path**

In the app:
1. Select a system audio output device (the one currently playing sound).
2. Keep ASR server as `ws://192.168.4.58:8080/ws/asr` (or change to your backend).
3. Click "开始录音".
4. Accept the mic permission prompt.
5. Choose a WAV save location in the dialog.
6. Play some audio on the computer (e.g., a YouTube video) and speak into the mic.
7. Watch the transcript panel: pass1 (interim, blue) results should appear, then pass2 (final) replaces them.
8. Click "停止录音".

Expected:
- Status cycles: 未连接 → 已连接 → 录音中 → 未连接.
- Transcript shows real-time ASR results reflecting both the mic speech and the system audio content.
- Info bar shows the saved WAV path.
- The saved WAV file plays in a media player and contains both the mic and system audio.

- [ ] **Step 5: Verify edge cases**

Test each edge case by reproducing it:

1. **Deny mic permission**: Click 开始录音, deny mic in the prompt. Expected: error message shown, capture.exe not left running (check Task Manager for `capture.exe`), WAV file may be created but empty - that's acceptable.

2. **ASR server down**: Change server URL to `ws://127.0.0.1:1/ws/asr`, click 开始录音. Expected: "启动失败：…" message, no capture.exe running.

3. **WebSocket disconnects mid-record**: Start recording, then stop the ASR backend. Expected: recording stops cleanly, WAV saved, status back to 未连接.

4. **Quit app mid-record**: Start recording, close the window. Expected: no orphan `capture.exe` in Task Manager, WAV file is playable (header patched).

5. **No system audio (silent device)**: Select an unused output device, start recording, speak into mic only. Expected: ASR returns mic speech, WAV contains only mic audio, no crash.

- [ ] **Step 6: Final commit (if any cleanup needed)**

If the verification surfaced fixes, commit them. Otherwise, no commit needed.

```bash
git status
# If clean, done. If changes, commit with appropriate message.
```

---

## Notes for the implementer

- **PowerShell vs Bash:** The plan uses forward-slash paths in `cd` commands which work in both. If running `npm` commands directly in PowerShell, no changes needed. The `node -e "..."` snippets use double-quoted JS strings - in PowerShell, escape inner double quotes with backtick or use single-quoted here-strings if you hit issues.

- **capture.exe and antivirus:** Some antivirus flag WASAPI loopback capture. If `capture.exe` is blocked, add an exclusion for the `electron-recorder/bin/` folder.

- **AudioContext sample rate:** `new AudioContext({ sampleRate: 16000 })` requests 16kHz. Browsers may not honor this exactly on all hardware, but Electron/Chromium generally does. If the context's actual rate differs, the worklet still runs at 128 samples/block but the effective rate won't match ASR expectations. Verify with `audioContext.sampleRate` in the dev console.

- **IPC throughput:** At 16kHz mono, system-audio chunks arrive roughly every 50-100ms (capture.exe reads 100ms at a time). Mixed chunks leave the worklet every 8ms (128 samples). That's ~125 `mixed-audio-chunk` IPC messages/sec - well within Electron's budget, but if you see UI jank, consider batching mixed chunks (e.g., accumulate 4 blocks = 32ms before sending).

- **Memory:** The WAV file grows at 32KB/sec (16kHz * 2 bytes). A 1-hour recording is ~115MB - manageable. The ring buffer in the worklet is fixed at 64KB.

- **Testing without an ASR backend:** If you don't have the ASR backend running, you can still verify the audio path by checking the saved WAV file plays correctly with both mic and system audio audible.
