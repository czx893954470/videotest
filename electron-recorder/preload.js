const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getDevices: () => ipcRenderer.invoke('get-devices'),
  startRecording: (deviceId) => ipcRenderer.invoke('start-recording', deviceId),
  stopRecording: () => ipcRenderer.invoke('stop-recording'),
  onRecordingStopped: (cb) => {
    const handler = (e, payload) => cb(payload);
    ipcRenderer.on('recording-stopped', handler);
    return () => ipcRenderer.removeListener('recording-stopped', handler);
  },
});
