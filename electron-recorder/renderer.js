// 渲染进程：协调麦克风采集、系统音频 IPC、AudioWorklet 混音、
// ASR WebSocket 和 WAV 备份。UI 在 index.html。

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

// ASR 句子状态（从 asr_demo.html 移植）
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
      startBtn.disabled = false;
      setStatus('未连接', 'disconnected');
      return;
    }

    // 3. 麦克风采集
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

    // 5. 混音输出 -> WS + WAV
    workletNode.port.onmessage = (e) => {
      if (e.data.type !== 'mixed') return;
      const mixed = e.data.samples;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(mixed.buffer);
      }
      window.api.sendMixedChunk(mixed);
    };

    // 6. 系统音频 IPC -> worklet 环形缓冲
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

    // 8. mic -> worklet
    const micSource = audioContext.createMediaStreamSource(micStream);
    micSource.connect(workletNode);
    workletNode.connect(audioContext.destination);

    // 9. 最后启动系统音频（启动后立刻有数据流）
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
