const { contextBridge, ipcRenderer } = require('electron');

// 通过 contextBridge 把受限的 API 暴露到 window.api
// 渲染进程只能调用这里列出的方法，无法直接访问 ipcRenderer 或 Node 能力
contextBridge.exposeInMainWorld('api', {
  // 枚举音频输出设备
  getDevices: () => ipcRenderer.invoke('get-devices'),
  // 开始录制到指定设备
  startRecording: (deviceId) => ipcRenderer.invoke('start-recording', deviceId),
  // 停止当前录制
  stopRecording: () => ipcRenderer.invoke('stop-recording'),
  // 监听主进程发来的"录制已停止"事件，返回一个取消订阅函数
  onRecordingStopped: (cb) => {
    const handler = (e, payload) => cb(payload);
    ipcRenderer.on('recording-stopped', handler);
    return () => ipcRenderer.removeListener('recording-stopped', handler);
  },
});
