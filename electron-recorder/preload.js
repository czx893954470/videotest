const { contextBridge, ipcRenderer } = require('electron');

// 通过 contextBridge 把受限的 API 暴露到 window.api
// 渲染进程只能调用这里列出的方法，无法直接访问 ipcRenderer 或 Node 能力
contextBridge.exposeInMainWorld('api', {
  // ─── 设备枚举 ───
  getDevices: () => ipcRenderer.invoke('get-devices'),

  // ─── 系统音频流（送给 ASR）───
  startSystemAudio: () => ipcRenderer.invoke('start-system-audio'),
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

  // ─── 混音 WAV 备份 ───
  startWavSave: () => ipcRenderer.invoke('start-wav-save'),
  sendMixedChunk: (f32) => ipcRenderer.send('mixed-audio-chunk', f32),
  stopWavSave: () => ipcRenderer.invoke('stop-wav-save'),

  // ─── 旧版文件录制接口（保留，新流程不用）───
  startRecording: (deviceId) => ipcRenderer.invoke('start-recording', deviceId),
  stopRecording: () => ipcRenderer.invoke('stop-recording'),
  onRecordingStopped: (cb) => {
    const handler = (e, payload) => cb(payload);
    ipcRenderer.on('recording-stopped', handler);
    return () => ipcRenderer.removeListener('recording-stopped', handler);
  },
});
