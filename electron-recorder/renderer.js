const deviceSelect = document.getElementById('device');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const refreshBtn = document.getElementById('refreshBtn');
const statusEl = document.getElementById('status');

function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.className = 'status' + (kind ? ' ' + kind : '');
}

function setRecordingUI(isRecording) {
  startBtn.classList.toggle('hidden', isRecording);
  stopBtn.classList.toggle('hidden', !isRecording);
  deviceSelect.disabled = isRecording;
  refreshBtn.disabled = isRecording;
}

async function loadDevices() {
  deviceSelect.disabled = true;
  startBtn.disabled = true;
  refreshBtn.disabled = true;
  deviceSelect.innerHTML = '<option>加载中…</option>';
  setStatus('加载设备列表…');
  try {
    const devices = await window.api.getDevices();
    deviceSelect.innerHTML = '';
    if (devices.length === 0) {
      setStatus('未发现任何输出设备。', 'error');
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
    setStatus(`发现 ${devices.length} 个输出设备。`);
  } catch (e) {
    setStatus(`加载设备失败：${e.message}`, 'error');
  }
}

startBtn.addEventListener('click', async () => {
  const deviceId = deviceSelect.value;
  if (!deviceId) {
    setStatus('请先选择设备。', 'error');
    return;
  }
  try {
    const result = await window.api.startRecording(deviceId);
    if (!result.ok) {
      if (result.canceled) setStatus('已取消。');
      else setStatus('启动录制失败。', 'error');
      return;
    }
    setRecordingUI(true);
    setStatus(`录制中… 文件将保存到：${result.path}`);
  } catch (e) {
    setStatus(`启动录制失败：${e.message}`, 'error');
  }
});

stopBtn.addEventListener('click', async () => {
  stopBtn.disabled = true;
  setStatus('正在停止…');
  try {
    await window.api.stopRecording();
  } catch (e) {
    setStatus(`停止失败：${e.message}`, 'error');
  }
});

window.api.onRecordingStopped(({ path, code }) => {
  setRecordingUI(false);
  stopBtn.disabled = false;
  if (code === 0) {
    setStatus(`录制完成：${path}`, 'success');
  } else {
    setStatus(`录制异常结束（exit ${code}）。`, 'error');
  }
});

refreshBtn.addEventListener('click', loadDevices);

loadDevices();
