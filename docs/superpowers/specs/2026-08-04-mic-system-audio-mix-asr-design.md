# Microphone + System Audio Mixing & ASR — Design

**Date:** 2026-08-04
**Target:** Extend `electron-recorder/` to mix microphone + system audio and stream the mixed PCM to an ASR WebSocket backend, with simultaneous WAV backup.

## Goal

Build a recording feature that captures both the microphone and the system (loopback) audio, mixes them in real time, and sends the mixed audio to the ASR backend for recognition — matching the UX of `asr_demo.html` (real-time pass1/pass2 transcripts) but adding system audio capture that a browser alone cannot do.

## Non-Goals

- Adjustable per-source volume / AGC.
- Multi-device or hot-plug support.
- ASR result persistence (no DB, no file).
- Re-architecting capture.exe beyond adding the `stream` mode.
- Keeping the original "save raw system audio WAV" flow. The WAV backup records the **mixed** audio.

## Context

- `asr_demo.html` proves the path: `getUserMedia` (mic, 16kHz mono) → `AudioWorklet` → WebSocket (`ws://192.168.4.58:8080/ws/asr`) → ASR pass1/pass2 + translation display.
- `electron-recorder/capture.exe` (C#, NAudio) can already enumerate output devices and capture WASAPI loopback to a WAV file. It does **not** stream.
- Browsers cannot capture system loopback audio on Windows; Electron + capture.exe is the only viable path here.

## Decisions (confirmed with user)

1. Build inside `electron-recorder/` (extend, not fork).
2. Real-time streaming ASR (not record-then-send).
3. Equal-weight mix: `0.5 * mic + 0.5 * system` in the AudioWorklet.
4. Save the **mixed** audio to WAV simultaneously with streaming.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ capture.exe (C#, modified — adds "stream" subcommand)       │
│  - WasapiLoopbackCapture on chosen render device            │
│  - resample device mix format -> 16kHz mono float32         │
│    (NAudio WdlResamplingStream / MediaFoundationResampler)  │
│  - write raw float32 bytes to stdout (binary)               │
│  - "READY\n" -> stderr (keeps stdout pure binary)           │
│  - reads "stop\n" from stdin, then exits cleanly            │
└──────────────────────┬──────────────────────────────────────┘
                       │ stdout (binary float32 PCM, 16kHz mono)
┌──────────────────────▼──────────────────────────────────────┐
│ main.js (Electron main)                                     │
│  - start-system-audio(deviceId): spawn capture.exe stream   │
│      • wait for "READY" on stderr                           │
│      • on stdout data: Float32Array -> webContents.send     │
│        'system-audio-chunk'                                 │
│  - stop-system-audio(): write "stop\n" to stdin, wait exit  │
│  - start-wav-save(): showSaveDialog, open write stream,     │
│      write 44-byte WAV header with size = 0 placeholders    │
│  - mixed-audio-chunk(Float32Array): convert to s16 PCM,     │
│      append to file                                         │
│  - stop-wav-save(): seek to header, patch size fields, close│
└──────────────────────┬──────────────────────────────────────┘
                       │ IPC (both directions)
┌──────────────────────▼──────────────────────────────────────┐
│ renderer.js + index.html (browser context)                  │
│  - getUserMedia(mic, 16kHz mono, AEC/NS/AGC on)             │
│  - AudioWorklet "mixer-processor":                          │
│      • input 0 = mic (128 samples/block @ 16kHz)            │
│      • ring buffer fed by port messages (system audio)      │
│      • process(): out = 0.5*mic + 0.5*system_ring           │
│        (underflow -> silence; overflow -> drop oldest)      │
│      • posts mixed 128-sample Float32Array back via port    │
│  - on mixed chunk from worklet:                             │
│      • ws.send(mixed.buffer)              -> ASR backend    │
│      • api.sendMixedChunk(mixed)          -> WAV backup     │
│  - WebSocket (port from asr_demo.html):                     │
│      • session_start {language, prompt, target_language}    │
│      • wait session_started                                 │
│      • stream audio binary frames                           │
│      • on stop: send {type:'end_input'} then close          │
│      • receive asr (pass1/2) + trans -> render transcript   │
└─────────────────────────────────────────────────────────────┘
```

## Components

### 1. `capture/Program.cs` — add `stream` subcommand

- New branch `if (command == "stream")` taking `<deviceId>`.
- Use `WasapiLoopbackCapture(device)`; capture.WaveFormat is the device mix format (typically 48kHz stereo float32).
- Build a resampler to 16kHz mono float32 using NAudio's `MediaFoundationResampler` (lower latency on Windows, simpler API than `WdlResamplingStream`). Input = `capture.WaveFormat` (device mix format, typically 48kHz stereo float32), output = `WaveFormat.CreateIeeeFloatWaveFormat(16000, 1)`. The resampler handles channel downmix and sample rate conversion in one step.
- In `DataAvailable`: push captured bytes through the resampler, write resampled float32 bytes to `Console.OpenStandardOutput()` via a `BinaryWriter`.
- Print `"READY\n"` to `Console.Error` once `StartRecording()` returns.
- Read `Console.In` for `"stop"`; on receipt, `StopRecording()`, wait for `RecordingStopped`, flush, exit 0.
- Existing `list` and `record` commands unchanged.

### 2. `main.js` — new IPC handlers

- `ipcMain.handle('start-system-audio', (event, deviceId) => ...)`: spawn `capture.exe stream <deviceId>`; on stderr "READY" resolve; pipe stdout to a buffer that emits `system-audio-chunk` events with `Float32Array` (copy bytes into a new ArrayBuffer to avoid referencing a shared Buffer). Track the child in a module-level `captureProcess`.
- `ipcMain.handle('stop-system-audio', ...)`: write `"stop\n"` to stdin, wait for `close` (5s timeout, then kill).
- `ipcMain.handle('start-wav-save', ...)`: `dialog.showSaveDialog`, create write stream, write 44-byte canonical WAV header with `chunkSize = 0`, `dataChunkSize = 0` (patched later). Store `wavFile` descriptor.
- `ipcMain.on('mixed-audio-chunk', (event, float32Array) => ...)`: convert Float32 → S16 LE PCM, append to `wavFile`. Track total bytes for size patching.
- `ipcMain.handle('stop-wav-save', ...)`: compute `dataChunkSize = totalBytes`, `chunkSize = 36 + dataChunkSize`, patch bytes 4–7 and 40–43 of the file (open r+b, write, close). Resolve with the saved path.
- On `before-quit`: if recording, run `stop-system-audio` and `stop-wav-save` first (reuse the existing `isQuitting` guard).

### 3. `preload.js` — extend `window.api`

```js
contextBridge.exposeInMainWorld('api', {
  // existing
  getDevices: () => ipcRenderer.invoke('get-devices'),
  // new
  startSystemAudio: (deviceId) => ipcRenderer.invoke('start-system-audio', deviceId),
  stopSystemAudio: () => ipcRenderer.invoke('stop-system-audio'),
  onSystemAudioChunk: (cb) => { /* ipcRenderer.on('system-audio-chunk', ...) */ },
  startWavSave: () => ipcRenderer.invoke('start-wav-save'),
  sendMixedChunk: (f32) => ipcRenderer.send('mixed-audio-chunk', f32),
  stopWavSave: () => ipcRenderer.invoke('stop-wav-save'),
  onRecordingStopped: (cb) => { /* unchanged */ },
});
```

### 4. `renderer.js` + `index.html` — port from `asr_demo.html` + add mixer

**UI (index.html):** rebuild to match `asr_demo.html`:
- Device `<select>` for system audio output device (refresh button).
- Start / Stop buttons.
- ASR language + target translation language selects.
- Server URL input (default `ws://192.168.4.58:8080/ws/asr`).
- Status badge (connected/disconnected).
- Transcript panel (final + interim styling, like asr_demo.html).
- Optional: live VU meter or "system audio active" indicator.

**AudioWorklet (`mixer-processor.js`, separate file loaded via `audioWorklet.addModule`):**
- 16384-sample ring buffer (Float32Array) for system audio.
- `process(inputs)`:
  - `mic = inputs[0][0]` (128 samples) or zeros if absent.
  - Read 128 samples from ring (zero-fill if underflow).
  - `out = 0.5*mic + 0.5*sys`.
  - `this.port.postMessage({type:'mixed', samples: out})`.
- `port.onmessage`: append incoming system-audio Float32Array to ring; if it would overflow, advance write head by the overflow amount (drop oldest).

**renderer.js flow:**
1. On load: `api.getDevices()` → populate device select.
2. Start button (order matters - worklet must be ready before system audio chunks arrive):
   - `await connectWebSocket()` → wait `session_started` (fail-fast on backend down).
   - `await api.startWavSave()` → get path (fail-fast on user cancel / disk error).
   - `getUserMedia({audio:{sampleRate:16000,channelCount:1,echoCancellation:true,noiseSuppression:true,autoGainControl:true}})`.
   - `new AudioContext({sampleRate:16000})`.
   - `audioContext.audioWorklet.addModule('mixer-processor.js')`.
   - Create `AudioWorkletNode` (1 in, 1 out, mono).
   - `createMediaStreamSource(micStream).connect(worklet)`.
   - Subscribe `worklet.port.onmessage`:
     - On `mixed`: `ws.send(mixed.buffer)` and `api.sendMixedChunk(mixed)`.
   - Subscribe `api.onSystemAudioChunk(f32 => worklet.port.postMessage({type:'system', samples: f32}))`.
   - `await api.startSystemAudio(deviceId)` → capture.exe ready (last step - chunks start flowing immediately after).
3. Stop button:
   - Set `isRecording = false`.
   - Disconnect worklet, close AudioContext, stop mic tracks.
   - `ws.send({type:'end_input'})`, then `ws.close()` after 500ms.
   - `await api.stopSystemAudio()`.
   - `await api.stopWavSave()` → show "saved to {path}".
4. WebSocket message handling: copy verbatim from `asr_demo.html` (pass1/pass2 accumulation, translation accumulation, `updateDisplay`).

## Data Flow

| Stream            | Source → Sink                                                                                  |
| ----------------- | ---------------------------------------------------------------------------------------------- |
| System audio PCM  | capture.exe stdout → main `system-audio-chunk` IPC → renderer → AudioWorklet ring buffer       |
| Microphone PCM    | getUserMedia → MediaStreamSource → AudioWorklet input 0                                        |
| Mixed PCM (ASR)   | AudioWorklet `process()` output → renderer `ws.send` → ASR backend                             |
| Mixed PCM (WAV)   | AudioWorklet `process()` output → renderer `api.sendMixedChunk` → main appends S16 to WAV file |
| ASR results       | ASR backend → renderer WebSocket `onmessage` → transcript panel                                |

## Audio Format

- **Mic capture:** 16kHz, mono, float32 (Web Audio native).
- **System audio capture (post-resample in C#):** 16kHz, mono, float32.
- **Mixed output to ASR:** 16kHz, mono, float32 (raw bytes of the Float32Array).
- **Mixed output to WAV:** 16kHz, mono, 16-bit signed PCM (LE). Conversion at write time in main.

## Error Handling

| Scenario                                    | Behavior                                                                                          |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| capture.exe fails to start / "READY" never arrives | Reject `start-system-audio`, show error, keep Start button enabled, do not open WS or mic.        |
| capture.exe exits mid-stream                | Emit `recording-error` to renderer; renderer stops recording (close WS, mic, worklet) and shows error. |
| Mic permission denied                       | Catch `getUserMedia` error; stop capture.exe + close WS; show error.                              |
| WebSocket fails to connect                  | Stop capture.exe (already started? if so, stop); show error.                                      |
| WebSocket closes mid-recording              | Stop mic + capture.exe + worklet; show disconnected status.                                       |
| Ring buffer underflow (system audio slow)   | Output zeros for missing samples — does not block process().                                      |
| Ring buffer overflow (system audio fast)    | Drop oldest samples by advancing write head.                                                      |
| WAV file write fails (disk full, etc.)      | Log error; continue ASR streaming; show non-fatal warning.                                        |
| App quit during recording                   | `before-quit` handler stops capture.exe and finalizes WAV before quitting.                        |

## Testing

- **capture.exe unit:** `capture.exe stream <deviceId> > out.bin` for 3s, send `stop`. Verify file is float32 PCM (every 4 bytes a finite float), sample rate ~16k (file size ≈ 16000*4*3 = 192000 bytes).
- **main IPC:** Start/stop system audio; verify `system-audio-chunk` events fire with Float32Arrays of nonzero length. Start/stop WAV save; verify produced file plays in a media player and is ~16kHz mono.
- **renderer mixing:** With mic + system audio, play a tone through speakers and speak into mic; verify mixed output contains both (audible in the saved WAV). Verify ASR returns text for both sources.
- **Edge cases:**
  - Deny mic permission → error shown, capture.exe not left running.
  - Disconnect WebSocket mid-record → recording stops cleanly, capture.exe exits, WAV still finalized.
  - Quit app mid-record → no orphan capture.exe, WAV playable.
  - No system audio (silent device) → still streams silence, ASR may return nothing, no crash.
  - Device unplugged mid-record → capture.exe exits; handled as "exits mid-stream".

## Risks

- **NAudio resampler latency** could add ~50–200ms to system audio path. Acceptable for ASR (pass1 is incremental, pass2 corrects). If problematic, switch to `MediaFoundationResampler` with lower latency.
- **AudioWorklet 128-block size @ 16kHz = 8ms/block** → IPC throughput is ~125 chunks/sec for system audio and ~125 chunks/sec for mixed → 250 IPC msgs/sec. Within Electron's comfort zone but worth watching.
- **WAV header patching** requires r+b seek; on Windows file locking, ensure stream is fully closed before reopening to patch.
- **ASR backend expects continuous float32** — confirm the mixed 128-sample frames are acceptable (asr_demo.html sent them, so yes).
