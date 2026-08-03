const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const { spawn } = require('child_process');

const CAPTURE_EXE = path.join(__dirname, 'bin', 'capture', 'capture.exe');

let mainWindow = null;
let captureProcess = null;
let currentOutputPath = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 640,
    height: 480,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile('index.html');
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

let isQuitting = false;

function stopCaptureProcess() {
  if (!captureProcess || captureProcess.killed) return Promise.resolve();
  try {
    captureProcess.stdin.write('stop\n');
    captureProcess.stdin.end();
  } catch {}
  return new Promise(resolve => {
    const onExit = () => resolve();
    captureProcess.once('close', onExit);
    setTimeout(() => {
      captureProcess.removeListener('close', onExit);
      try { captureProcess.kill(); } catch {}
      resolve();
    }, 5000);
  });
}

app.on('before-quit', (event) => {
  if (isQuitting) return;
  if (captureProcess && !captureProcess.killed) {
    event.preventDefault();
    isQuitting = true;
    stopCaptureProcess().then(() => app.quit());
  }
});

ipcMain.handle('get-devices', async () => {
  return new Promise((resolve, reject) => {
    const child = spawn(CAPTURE_EXE, ['list']);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', err => reject(new Error(`无法启动 capture.exe：${err.message}`)));
    child.on('close', code => {
      if (code !== 0) {
        reject(new Error(`capture.exe list 退出码 ${code}：${stderr}`));
        return;
      }
      const devices = stdout.split('\n')
        .map(l => l.trim())
        .filter(Boolean)
        .map(l => {
          const idx = l.indexOf('|');
          if (idx < 0) return null;
          return { id: l.slice(0, idx), name: l.slice(idx + 1) };
        })
        .filter(Boolean);
      resolve(devices);
    });
  });
});

ipcMain.handle('start-recording', async (event, deviceId) => {
  if (captureProcess) {
    throw new Error('已经在录制中');
  }
  const result = await dialog.showSaveDialog(mainWindow, {
    title: '保存录音',
    defaultPath: `recording-${Date.now()}.wav`,
    filters: [{ name: 'WAV', extensions: ['wav'] }],
  });
  if (result.canceled || !result.filePath) {
    return { ok: false, canceled: true };
  }
  currentOutputPath = result.filePath;

  return new Promise((resolve, reject) => {
    const child = spawn(CAPTURE_EXE, ['record', deviceId, result.filePath]);
    let ready = false;
    let stderr = '';

    child.stderr.on('data', d => { stderr += d.toString(); });
    child.stdout.on('data', d => {
      const text = d.toString();
      if (!ready && text.includes('READY')) {
        ready = true;
        captureProcess = child;
        resolve({ ok: true, path: result.filePath });
      }
    });
    child.on('error', err => {
      if (!ready) reject(new Error(`无法启动 capture.exe：${err.message}`));
    });
    child.on('close', code => {
      captureProcess = null;
      if (!ready) {
        reject(new Error(`capture.exe 启动失败（exit ${code}）：${stderr}`));
        return;
      }
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('recording-stopped', { path: currentOutputPath, code });
      }
    });
  });
});

ipcMain.handle('stop-recording', async () => {
  if (!captureProcess) return { ok: false };
  try {
    captureProcess.stdin.write('stop\n');
    captureProcess.stdin.end();
  } catch {}
  return { ok: true };
});
