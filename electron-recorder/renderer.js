// 渲染进程：协调麦克风采集、系统音频 IPC、AudioWorklet 混音、
// ASR WebSocket 和 WAV 备份。UI 在 index.html。
//
// 数据流概览：
//   麦克风 ─┐
//          ├─> mixer-processor (worklet) ─> Float32 PCM ─┬─> WebSocket (ASR)
//   系统音频 ┘                                            └─> IPC (WAV 落盘)


// ---- DOM 引用 ----
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const statusSpan = document.getElementById('status');
const infoEl = document.getElementById('info');
const transcriptDiv = document.getElementById('transcript');
const asrLangSelect = document.getElementById('asrLang');
const targetLangSelect = document.getElementById('targetLang');
const serverUrlInput = document.getElementById('serverUrl');
const useMicCheckbox = document.getElementById('useMic');
const useSystemCheckbox = document.getElementById('useSystem');

// ---- 运行时状态（跨事件处理器共享，所以放模块作用域）----
let ws = null;                      // ASR WebSocket
let audioContext = null;            // 16kHz AudioContext
let micStream = null;               // 麦克风 MediaStream
let workletNode = null;             // mixer-processor 节点，负责 mic+system 混音
let isRecording = false;            // 是否处于录音态；ws.onclose 据此判断是否要联动 stop
let unsubscribeSystemAudio = null;  // 系统音频 chunk IPC 的取消订阅句柄
let unsubscribeSystemStopped = null;// 系统音频意外退出 IPC 的取消订阅句柄

// ---- ASR 句子状态（从 asr_demo.html 移植）----
// ASR 协议（来自服务端）：
//   pass=1：流式实时识别，同一 sentence_id 的 text 会不断更新（前缀增长或后缀追加）
//   pass=2：句子终稿，text 为该 sentence_id 的最终识别结果
//   trans ：翻译结果，与对应 sentence_id 的识别文本对齐，is_final 标识是否终稿
const sentences = new Map();      // sentenceId -> { text, isFinal }
const translations = new Map();   // sentenceId -> { text, isFinal }
let latestSentenceId = 0;         // 当前正在更新的句子，用于 UI 高亮"临时态"那一行

function setStatus(text, kind) {
  statusSpan.textContent = text;
  statusSpan.className = 'status' + (kind ? ' ' + kind : '');
}

function setInfo(text) {
  infoEl.textContent = text;
}

// 根据复选框状态、是否录音中，统一更新各控件的 disabled。
// 取代原先散落在 startRecording / stopRecording 里的直接赋值。
function updateControlsEnabled() {
  if (isRecording) {
    useMicCheckbox.disabled = true;
    useSystemCheckbox.disabled = true;
    startBtn.disabled = true;
    stopBtn.disabled = false;
    return;
  }
  const useMic = useMicCheckbox.checked;
  const useSystem = useSystemCheckbox.checked;
  useMicCheckbox.disabled = false;
  useSystemCheckbox.disabled = false;
  // 开始按钮：至少勾一个源
  startBtn.disabled = (!useMic && !useSystem);
  stopBtn.disabled = true;
}

// 转义文本，安全地拼进 innerHTML（识别/翻译结果来自外部，必须防 XSS）。
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// 重新渲染整个 transcript 区。
//   - 终稿句（isFinal）：显示终稿样式
//   - 当前临时句（== latestSentenceId 且未 final）：显示临时态样式
//   - 其他历史临时句：跳过（已被终稿或下一句临时态覆盖）
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

// 处理 pass=1（流式实时识别）。
// 服务端两种行为都兼容：发整句越来越长的前缀，或发增量后缀。
function handlePass1(sentenceId, text) {
  latestSentenceId = sentenceId;
  if (!sentences.has(sentenceId)) {
    sentences.set(sentenceId, { text, isFinal: false });
    return;
  }
  const s = sentences.get(sentenceId);
  if (s.isFinal) return;  // 已终稿，忽略迟到的 pass1
  if (text !== s.text) {
    if (text.startsWith(s.text)) s.text = text;  // 前缀增长：直接替换
    else s.text = s.text + text;                  // 后缀追加：拼接
  }
}

// 处理 pass=2（终稿）。把该句锁死为 final，并把 latestSentenceId 推到下一句，
// 这样 UI 不再把后续 pass1 当成"临时态"高亮。
function handlePass2(sentenceId, text) {
  sentences.set(sentenceId, { text, isFinal: true });
  if (sentenceId >= latestSentenceId) latestSentenceId = sentenceId + 1;
}

// 处理翻译结果。合并策略与 handlePass1 相同：前缀增长替换，后缀追加拼接。
function handleTrans(sentenceId, text, isFinal) {
  if (!translations.has(sentenceId)) {
    translations.set(sentenceId, { text, isFinal });
    return;
  }
  const t = translations.get(sentenceId);
  if (t.isFinal) return;  // 已终稿，忽略后续更新
  if (text !== t.text) {
    if (text.startsWith(t.text)) t.text = text;
    else t.text = t.text + text;
  }
  t.isFinal = isFinal;
}

// 建立 ASR WebSocket 并等 session_started 握手。
// onopen 时发 session_start（识别语言、目标翻译语言、场景提示词），
// 收到 session_started 才 resolve；其他消息按 type 分发到 handlePass1/2 / handleTrans。
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
      // 服务端主动断开或网络异常时，若还在录音则联动停止整套流水线
      if (isRecording) stopRecording();
      setStatus('未连接', 'disconnected');
    };
  });
}

// 启动一次完整录音。步骤顺序刻意安排：
//   先连 WS（后端没起快速失败） → 选 WAV 路径 → 开麦克风 → 建 AudioContext+worklet
//   → 接系统音频 IPC → 最后启动系统音频采集（启动后立刻有数据流）
// 任何一步失败都走 cleanupPartial 回滚已申请的资源。
async function startRecording() {
  const useMic = useMicCheckbox.checked;
  const useSystem = useSystemCheckbox.checked;
  if (!useMic && !useSystem) {
    setInfo('请至少选择一个音频源。');
    return;
  }

  setInfo('连接 ASR 服务…');
  setStatus('连接中…', 'disconnected');
  startBtn.disabled = true;

  try {
    // 1. 先连 WebSocket（后端没起来就快速失败）
    await connectWebSocket();
    setStatus('已连接', 'connected');

    // 2. WAV 保存（用户取消或磁盘错误就快速失败）
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
      updateControlsEnabled();
      setStatus('未连接', 'disconnected');
      return;
    }

    // 3. 麦克风采集（可被复选框跳过）
    if (useMic) {
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
    }

    // 4. AudioContext + worklet
    audioContext = new AudioContext({ sampleRate: 16000 });
    await audioContext.audioWorklet.addModule('mixer-processor.js');

    workletNode = new AudioWorkletNode(audioContext, 'mixer-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
    });

    // 告诉 worklet 哪些源启用（满增益混音，见 mixer-processor.js）
    workletNode.port.postMessage({ type: 'config', mic: useMic, system: useSystem });

    // 5. 混音输出 -> WS + WAV
    // worklet 每算出一帧 Float32 混音就 postMessage 出来；这里同时喂给 ASR 和 WAV 落盘。
    // ws.send 对 ArrayBuffer 是拷贝入队（不 transfer），所以 mixed 之后还能继续给 IPC 用。
    workletNode.port.onmessage = (e) => {
      if (e.data.type !== 'mixed') return;
      const mixed = e.data.samples;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(mixed.buffer);
      }
      window.api.sendMixedChunk(mixed);
    };

    // 6. 系统音频 IPC -> worklet 环形缓冲（可被复选框跳过）
    if (useSystem) {
      unsubscribeSystemAudio = window.api.onSystemAudioChunk((f32) => {
        if (workletNode) {
          // 复制一份，脱离 IPC 持有的缓冲再 transfer
          const copy = new Float32Array(f32.length);
          copy.set(f32);
          workletNode.port.postMessage({ type: 'system', samples: copy }, [copy.buffer]);
        }
      });

      // 7. 系统音频意外结束（设备被拔等）
      unsubscribeSystemStopped = window.api.onSystemAudioStopped(({ code }) => {
        if (isRecording) {
          setInfo(`系统音频流意外结束（exit ${code}），正在停止…`);
          stopRecording();
        }
      });
    }

    // 8. mic -> worklet（仅当麦克风启用时）
    if (useMic) {
      const micSource = audioContext.createMediaStreamSource(micStream);
      micSource.connect(workletNode);
    }
    // worklet 必须接到 destination 才会被持续 pull（否则 process() 不调用，WS/WAV 拿不到数据），
    // 但直接接会外放混音 -> 接一个 gain=0 的静音节点中转，保持 pull 不出声。
    const muteGain = audioContext.createGain();
    muteGain.gain.value = 0;
    workletNode.connect(muteGain);
    muteGain.connect(audioContext.destination);

    // 9. 最后启动系统音频（启动后立刻有数据流）
    if (useSystem) {
      setInfo('启动系统音频采集…');
      await window.api.startSystemAudio();
    }

    isRecording = true;
    updateControlsEnabled();
    setStatus('录音中', 'recording');
    setInfo(`录音中。WAV 将保存到：${wavResult.path}`);
  } catch (e) {
    setInfo(`启动失败：${e.message}`);
    setStatus('未连接', 'disconnected');
    await cleanupPartial();
    updateControlsEnabled();
  }
}

// 启动失败时回滚已申请的资源。
// 与 stopRecording 的区别：不发 end_input、不等 ws.close、不弹"已保存"提示——
// 因为还没真正开始录音，只是清理半成品。
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

// 主动停止录音。流程：
//   1. 立刻拆 worklet/context/mic/IPC（停止采集）
//   2. 发 end_input 通知服务端尾包，留 500ms 收最后一段结果再关 WS
//   3. 停系统音频 + 收尾 WAV 文件
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
    // 给服务端 500ms 处理 end_input（可能回吐最后一段结果），再关连接
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
  updateControlsEnabled();
  setInfo(wavPath ? `录音完成，已保存：${wavPath}` : '录音已停止。');
}

// ---- UI 事件绑定 ----
startBtn.addEventListener('click', startRecording);
stopBtn.addEventListener('click', stopRecording);
useMicCheckbox.addEventListener('change', updateControlsEnabled);
useSystemCheckbox.addEventListener('change', updateControlsEnabled);

// 录音中切换语言：实时通知服务端，无需重连
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

// 启动时初始化控件状态（没有 loadDevices 了，直接就是就绪态）
updateControlsEnabled();
setStatus('就绪', 'disconnected');
setInfo('就绪。');
