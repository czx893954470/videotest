# 设计：麦克风 / 系统音频复选框

日期：2026-08-06
范围：`electron-recorder/` 内的 UI 与混音流水线

## 目标

录音前让用户勾选是否启用麦克风、是否启用系统音频。当前实现强制两个源都开；本次改动让用户可任选其一或两者。

用户明确要求：所有启用的源统一以 1.0 增益（满音量）输出，不衰减。两源都开时直接相加（不回退到 0.5/0.5）。

## 非目标

- 不改 main.js / preload.js / WAV 落盘流程 / ASR WebSocket 协议
- 不改系统音频采集的 C# 程序
- 不持久化复选框状态（每次启动默认都勾选）
- 不做电平表 / 削波检测 / 自动增益

## 改动

### 1. UI — `electron-recorder/index.html`

在"系统音频设备"行上方新增一行：

```html
<div class="row">
  <label><input type="checkbox" id="useMic" checked> 麦克风</label>
  <label><input type="checkbox" id="useSystem" checked> 系统音频</label>
</div>
```

复选框默认勾选，保持与现有行为一致。

### 2. Worklet — `electron-recorder/mixer-processor.js`

- 构造函数中接收 `{ type: 'config', mic: boolean, system: boolean }` 消息，保存到 `this.micEnabled` / `this.systemEnabled`（默认都为 `true`，与旧行为一致，避免漏发 config 时静音）。
- `process()` 的混音改为：

```js
const mic = (this.micEnabled && micCh) ? micCh[i] : 0;
const sys = this.systemEnabled ? this._sysTemp[i] : 0;
out[i] = mic + sys;
```

1.0 增益，两源都开时直接相加。系统音频环形缓冲读取保持现状（不读也不影响——只是写不入而已），仅在 `systemEnabled=false` 时跳过 `_readRing` 的结果使用。

### 3. Renderer — `electron-recorder/renderer.js`

#### 新增 DOM 引用

```js
const useMicCheckbox = document.getElementById('useMic');
const useSystemCheckbox = document.getElementById('useSystem');
```

#### `startRecording()` 开头的校验

```js
const useMic = useMicCheckbox.checked;
const useSystem = useSystemCheckbox.checked;
if (!useMic && !useSystem) {
  setInfo('请至少选择一个音频源。');
  return;
}
if (useSystem && !deviceId) {
  setInfo('请先选择系统音频设备。');
  return;
}
```

#### 条件化采集步骤

- 麦克风步骤（原第 3、8 步）：`if (useMic) { micStream = await getUserMedia(...); micSource.connect(workletNode); }`
- 系统音频步骤（原第 6、7、9 步）：`if (useSystem) { 订阅 onSystemAudioChunk; 订阅 onSystemAudioStopped; await startSystemAudio(deviceId); }`
- worklet 创建后立即发送配置：`workletNode.port.postMessage({ type: 'config', mic: useMic, system: useSystem });`

#### `cleanupPartial()` 和 `stopRecording()` 的清理

无需改动——已有的 `if (micStream)` / `if (unsubscribeSystemAudio)` / `if (unsubscribeSystemStopped)` / `stopSystemAudio()` 的 try-catch 都能容忍对应步骤被跳过的情况。

#### 启用状态管理

新增函数：

```js
function updateControlsEnabled() {
  const useMic = useMicCheckbox.checked;
  const useSystem = useSystemCheckbox.checked;
  const devicesLoaded = deviceSelect.options.length > 0
    && !deviceSelect.options[0]?.textContent?.includes('加载中');
  // 录音中全部锁死（含两个 checkbox）
  if (isRecording) {
    useMicCheckbox.disabled = true;
    useSystemCheckbox.disabled = true;
    deviceSelect.disabled = true;
    refreshBtn.disabled = true;
    startBtn.disabled = true;
    return;
  }
  useMicCheckbox.disabled = false;
  useSystemCheckbox.disabled = false;
  // 系统音频未勾选时，设备下拉框和刷新按钮变灰
  deviceSelect.disabled = !useSystem || !devicesLoaded;
  refreshBtn.disabled = !useSystem;
  // 开始按钮：至少一个源 + (系统音频要求设备已选)
  startBtn.disabled = (!useMic && !useSystem) || (useSystem && !deviceSelect.value);
}
```

调用时机：
- 两个 checkbox 的 `change` 事件
- `loadDevices()` 末尾（成功 / 失败两个分支都调）
- `startRecording()` 成功路径末尾（进入录音态）
- `stopRecording()` 末尾（退出录音态）
- `cleanupPartial()` 末尾（启动失败回滚后）

`loadDevices()` 开头那段"加载中…"的禁用（`deviceSelect.disabled = true; startBtn.disabled = true; refreshBtn.disabled = true;`）保留，那是进入加载态的瞬时禁用，加载完成后由 `updateControlsEnabled()` 统一收口。`loadDevices()` 末尾原来直接操作这些 disabled 的语句删除，改为调用 `updateControlsEnabled()`。

## 数据流（不变）

```
麦克风 ─┐
        ├─> mixer-processor (worklet) ─> Float32 PCM ─┬─> WebSocket (ASR)
系统音频 ┘                                            └─> IPC (WAV 落盘)
```

仅是"麦克风"和"系统音频"两条入边各自可被复选框切断。切断后 worklet 仍以 128 样本/帧的节奏产出（静音或单源），WS 和 WAV 落盘无感知。

## 边界情况

- **两源都关**：`startRecording()` 开头拦截，提示"请至少选择一个音频源"。
- **只勾系统音频，未选设备**：`startRecording()` 拦截，提示"请先选择系统音频设备"。
- **录音中切换复选框**：录音中两个 checkbox 与其他控件一起被禁用（见 `updateControlsEnabled()` 的 `isRecording` 分支），无法切换。停止录音后恢复可操作。
- **loadDevices 失败但用户取消系统音频**：startBtn 仍可启用（只要麦克风勾选）。

## 测试要点

1. 两个都勾：行为与改动前一致（除增益从 0.5/0.5 变 1.0/1.0，音量略增大）。
2. 只勾麦克风：能录音，WAV/ASR 都正常，无系统音频相关的 IPC 调用。
3. 只勾系统音频：能录音，无 getUserMedia 弹窗。
4. 两个都不勾：开始按钮禁用；若强行调用则提示。
5. 取消系统音频勾选：设备下拉框 + 刷新按钮变灰，开始按钮仍可用（麦克风勾选时）。
6. 录音中：控件状态不乱跳；停止后恢复可操作。
