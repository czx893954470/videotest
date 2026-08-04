// 渲染进程：负责 UI 交互，通过 window.api 与主进程通信
// 自身不接触文件系统或 capture.exe，所有操作都走 IPC

const deviceSelect = document.getElementById('device');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const refreshBtn = document.getElementById('refreshBtn');
const statusEl = document.getElementById('status');

// 更新状态栏文字，kind 控制颜色样式：error / success / 无（默认灰）
function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.className = 'status' + (kind ? ' ' + kind : '');
}

// 切换"录制中/已停止"两套 UI：按钮显隐、控件禁用状态
function setRecordingUI(isRecording) {
  startBtn.classList.toggle('hidden', isRecording);
  stopBtn.classList.toggle('hidden', !isRecording);
  deviceSelect.disabled = isRecording;
  refreshBtn.disabled = isRecording;
}

// 拉取设备列表并填充下拉框
async function loadDevices() {
  // 加载期间禁用所有控件，避免重复请求
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

// 点击"开始录制"：选好设备后请求主进程启动 capture.exe
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

// 点击"停止录制"：发送停止命令，UI 状态等 onRecordingStopped 回调再切换
stopBtn.addEventListener('click', async () => {
  stopBtn.disabled = true;
  setStatus('正在停止…');
  try {
    await window.api.stopRecording();
  } catch (e) {
    setStatus(`停止失败：${e.message}`, 'error');
  }
});

// 主进程在 capture.exe 真正退出后触发此回调
// code === 0 表示正常结束，其他值表示异常退出
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

// 页面加载完成后立即拉一次设备列表
loadDevices();
