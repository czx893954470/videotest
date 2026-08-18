# 设计：抓取所有输出设备并混音

日期：2026-08-18
范围：`electron-recorder/` 内的 C# 采集程序、main.js / preload.js / renderer.js / index.html

## 目标

录音时自动抓取所有 ACTIVE 状态的 WASAPI render endpoints（扬声器、HDMI、蓝牙耳机、虚拟声卡等）的 loopback，在 C# 采集程序内部混成一条 16kHz mono float32 流后送给渲染进程混音器。

用户明确要求：
- 不在 UI 上让用户选择设备（"减少用户操作"）
- 启动时枚举一次，全程不动；录音中新插设备不抓、拔掉设备那一路跳过
- 失败的路不报错、不退出，仅 stderr 记录

## 非目标

- 不改 main.js 中 stdout 二进制 PCM → Float32Array → `system-audio-chunk` IPC 的协议
- 不改 preload.js 中除 `startSystemAudio` 签名外的其他暴露项
- 不改 `mixer-processor.js`（worklet 对"系统音频是一条 ring buffer"的抽象保持不变）
- 不改 `wav-utils.js` / WAV 落盘 IPC / ASR WebSocket 协议
- 不改 `capture/Program.cs` 的 `list` / `record` / `stream <deviceId>` 子命令（保留单设备能力，向后兼容）
- 不持久化设备列表
- 不做电平表 / 削波检测 / 自动增益 / 单路音量
- 不做热插拔响应
- 不做单元测试或集成测试（用户明确不需要）

## 数据流架构

```
扬声器 ┐
HDMI    │  WasapiLoopbackCapture(每路一)   MediaFoundationResampler(每路一)
蓝牙    ├───────────────────────────>  ────────────────────────────────────>  ┐
虚拟卡 ┘                                                                      │
                                                                              ▼
                                                                       C# 内部求和
                                                                       (1.0 增益相加)
                                                                              │
                                                                              ▼
                                                                       16kHz mono float32
                                                                       (单条 stdout 二进制流)
                                                                              │
                                                                       ┌──────┴──────┐
                                                                       ▼             ▼
                                                              main.js 透传      (与现在一致)
                                                              system-audio-chunk IPC
                                                                              │
                                                              ┌───────────────┘
                                                              ▼
                                          mixer-processor.js ring buffer (单条，不动)
                                                              │
                                                              ▼
                                                  mic + system(单条) 混音
                                                              │
                                                              ▼
                                                    Float32 PCM 给 ASR/WAV
```

关键不变量：**从 main.js 往下看的协议完全不变**——仍是"一条 16kHz mono float32 流"。复杂度全压在 C# 内部，mixer-processor.js 一行不动。

## 改动

### 1. C# `capture/Program.cs`：新增 `stream-all` 子命令

保留现有 `stream <deviceId>` 不动，新增 `stream-all`。

#### 子命令签名

```
capture.exe stream-all
  stdout -- 16kHz mono float32 PCM（与 stream 完全相同的二进制协议）
  stderr -- "READY" / "Capturing N device(s): ..." / "Device X failed: ..." / 错误信息
  stdin  -- "stop" 触发停止；EOF 也算停止
```

#### 内部结构

对每个 ACTIVE render endpoint 起一条独立"采集 → 缓冲 → 重采样"链：

```
设备 A  WasapiLoopbackCapture  ->  BufferedWaveProvider  ->  MediaFoundationResampler  ─┐
设备 B  WasapiLoopbackCapture  ->  BufferedWaveProvider  ->  MediaFoundationResampler  ─┤
设备 C  WasapiLoopbackCapture  ->  BufferedWaveProvider  ->  MediaFoundationResampler  ─┤
                                                                                       ▼
                                                                            单 pump 线程：
                                                                            每路读 N 样本，
                                                                            缺数据的路补 0，
                                                                            逐点相加，写 stdout
```

每条链的配置与现有 `stream` 子命令完全一致：

- `WasapiLoopbackCapture(device)`
- `BufferedWaveProvider(capture.WaveFormat) { BufferDuration=2s, DiscardOnBufferOverflow=true, ReadFully=false }`
- `MediaFoundationResampler(bufferProvider, WaveFormat.CreateIeeeFloatWaveFormat(16000, 1))`
- `capture.DataAvailable += (s, e) => bufferProvider.AddSamples(e.Buffer, 0, e.BytesRecorded);`

#### pump 线程的求和逻辑

每轮 100ms（CHUNK = 1600 个 float = 6400 字节，对齐现有 stream 节奏）：

```csharp
const int CHUNK_SAMPLES = 1600;
const int CHUNK_BYTES = CHUNK_SAMPLES * 4;
float[] acc = new float[CHUNK_SAMPLES];
byte[] tmpBytes = new byte[CHUNK_BYTES];
byte[] outBytes = new byte[CHUNK_BYTES];

while (true) {
  Array.Clear(acc, 0, CHUNK_SAMPLES);

  foreach (var chain in activeChains) {
    if (!chain.Active) continue;
    int read = chain.Resampler.Read(tmpBytes, 0, CHUNK_BYTES);
    int readSamples = read / 4;
    // 不足 CHUNK_SAMPLES 的剩余位 acc 保持 0，等价于"该路这一帧没数据 = 静音"
    for (int i = 0; i < readSamples; i++) {
      acc[i] += BitConverter.ToSingle(tmpBytes, i * 4);
    }
  }

  Buffer.BlockCopy(acc, 0, outBytes, 0, CHUNK_BYTES);
  stdout.Write(outBytes, 0, CHUNK_BYTES);
  stdout.Flush();

  if (stopRequested && AllBuffersEmpty()) {
    DrainResamplersAndSum();  // 把每路 resampler 内部尾包读干净，最后一次求和输出
    break;
  }
  if (!stopRequested && NoDataAnywhere()) Thread.Sleep(10);
}
```

注意点：
- **缺数据的路自然补 0**：若某路 `Resampler.Read` 返回 0（设备没在播放），acc 在那几位保持 0，等价于静音，不报错、不退出
- **求和会削波**：与现有"1.0 增益直接相加"一致，用户明确接受过
- **字节边界**：NAudio resampler 输出可能不是完整 6400 字节，按实际 `read / 4` 累加；acc 始终 1600 个 float（剩余位补 0）

#### 失败与边界处理

- **零个 ACTIVE render endpoint**：stderr 输出 `No active render endpoints`，退出码非 0，不发 READY
- **某路 `WasapiLoopbackCapture.StartRecording` 抛异常**：stderr 记录 `Device <name> failed: <msg>`，该路不进 activeChains，继续起其他路
- **所有路都启动失败**：stderr 输出汇总错误，退出码非 0，不发 READY
- **某路录音中 `RecordingStopped` 异常触发**（设备被拔）：该路标记 `Active = false`，pump 跳过它；其余路继续；不退出
- **所有路都中途失败**：pump 输出全 0（acc 一直 0），不退出；退出条件仍是 stdin 收到 stop 或 EOF——main.js 现有"录音中 capture.exe 死了"的检测路径不变

#### READY 信号

至少一路成功 `StartRecording` 后写 `READY\n` 到 stderr。main.js 现有逻辑就是等 stderr 的 READY 再认为启动成功，完全复用。

#### 启动日志

READY 之前，stderr 输出一行：

```
Capturing N device(s): 扬声器(Realtek), HDMI 1, 蓝牙耳机, ...
```

main.js 把这行透传到主进程控制台（见 §3）。

### 2. `electron-recorder/main.js`

#### `start-system-audio` handler

```js
// before
ipcMain.handle('start-system-audio', async (event, deviceId) => {
  ...
  const child = spawn(CAPTURE_EXE, ['stream', deviceId]);
  ...
});

// after
ipcMain.handle('start-system-audio', async (event) => {
  ...
  const child = spawn(CAPTURE_EXE, ['stream-all']);
  ...
});
```

其他不动：stdout 二进制 PCM → `Float32Array` → `system-audio-chunk` IPC 透传、stderr 等 READY、stdin 发 stop、子进程退出 → `system-audio-stopped`，全保持原样。

#### stderr 透传到主进程控制台

现在 stderr 仅累积成字符串用于失败时报错。**新增**：把每行 stderr 也 `console.log('[capture]', line)` 透传到主进程控制台。这样开发时能看到抓了几台、哪台失败了；生产环境 Electron 控制台日志通常不看，不会成为用户负担。

UI 不显示设备列表。开发者要查就走控制台。

### 3. `electron-recorder/preload.js`

```js
// before
startSystemAudio: (deviceId) => ipcRenderer.invoke('start-system-audio', deviceId),

// after
startSystemAudio: () => ipcRenderer.invoke('start-system-audio'),
```

其他暴露项不动。

### 4. `electron-recorder/index.html`

整行删掉"系统音频设备："那一行：

```html
<!-- 删除 -->
<div class="row">
  <label>系统音频设备：</label>
  <select id="device" disabled>
    <option>加载中…</option>
  </select>
  <button class="btn-secondary" id="refreshBtn">刷新设备</button>
</div>
```

保留 useMic / useSystem checkbox 那一行。

### 5. `electron-recorder/renderer.js`

涉及面较大但都是"减法"：

1. **删除 DOM 引用**：`deviceSelect`、`refreshBtn`
2. **删除 `loadDevices()` 整个函数**及其在启动时的调用（启动时不再枚举下拉列表）
3. **`startRecording()` 里**：
   - 删除 `if (useSystem && !deviceId) { setInfo('请先选择系统音频设备。'); return; }` 校验（不再有 deviceId 概念）
   - `await startSystemAudio(deviceId)` → `await startSystemAudio()`（不传参）
4. **`updateControlsEnabled()` 里**：删掉所有 `deviceSelect.*` / `refreshBtn.*` 相关的禁用/启用语句；保留 useMic / useSystem / startBtn 的联动；`devicesLoaded` 这个局部变量也跟着删
5. **删 `refreshBtn` 的 click 监听**（如果存在）

`stopRecording()` / `cleanupPartial()` 不动：现有 `if (unsubscribeSystemAudio)` / `stopSystemAudio()` 的 try-catch 都能容忍 system 没起的情况，与单设备时代一致。

### 6. `electron-recorder/mixer-processor.js`

**一行不动**。worklet 对"系统音频是一条 ring buffer"的抽象保持不变；C# 输出仍是单条 16kHz mono float32 流。

## 边界情况

- **两源（mic + system）都关**：`startRecording()` 开头拦截，提示"请至少选择一个音频源"（与现有行为一致）
- **只勾 mic**：不 spawn capture.exe，无 `system-audio-chunk` IPC；worklet 的 ring buffer 一直空，输出 = mic + 0
- **只勾 system**：spawn `stream-all`；无 `getUserMedia` 弹窗；输出 = 0 + system 混音
- **零 ACTIVE render endpoints**：capture.exe 退出码非 0，不发 READY，main.js reject，UI 显示"无法启动 capture.exe: No active render endpoints"
- **某路 capture 启动失败**：stderr 记录该路失败，其余路继续；READY 仍发（只要至少一路成功）；主进程控制台可见日志
- **某路 capture 录音中失败**（设备被拔）：该路在 pump 中被跳过；其余路继续；READY 不重发；输出持续不中断
- **所有路录音中失败**：pump 输出全 0；不退出；退出条件仍是 stdin 收到 stop 或 EOF——main.js 的"capture.exe 死了"检测路径不变
- **录音中插上新设备**：本次录音不抓；新设备声音不出现在输出里（已确认）
- **loadDevices 调用被删后**：启动时不再调 capture.exe list；不影响主流程
