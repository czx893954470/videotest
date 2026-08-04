// Electron 主进程：负责窗口管理、文件保存对话框、与 capture.exe 子进程通信
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const { spawn } = require('child_process');

// capture.exe 是独立编译的音频采集程序，负责枚举设备与实际录制
// 开发环境从源码目录加载，打包后从 resources 目录加载
const CAPTURE_EXE = app.isPackaged
  ? path.join(process.resourcesPath, 'bin', 'capture', 'capture.exe')
  : path.join(__dirname, 'bin', 'capture', 'capture.exe');

let mainWindow = null;        // 主窗口引用，关闭后置 null
let captureProcess = null;    // 当前录制中的 capture.exe 子进程；为 null 表示未在录制
let currentOutputPath = null; // 当前录制文件保存路径，停止后用于通知渲染进程

// 创建应用主窗口，加载 index.html，并配置安全相关的 webPreferences
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 640,
    height: 480,
    webPreferences: {
      // 通过 preload.js 把受限的 IPC 接口注入渲染进程
      preload: path.join(__dirname, 'preload.js'),
      // 开启上下文隔离，阻止渲染进程直接访问 Node API
      contextIsolation: true,
      // 关闭 Node 集成，渲染进程只能通过 preload 暴露的接口与主进程通信
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile('index.html');
  // 窗口关闭时清空引用，避免持有已销毁对象
  mainWindow.on('closed', () => { mainWindow = null; });
}

// 应用就绪后创建窗口；macOS 点击 dock 图标且无窗口时也需重新创建
app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// 非 macOS 平台关闭所有窗口时退出应用（macOS 习惯是保留进程）
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

let isQuitting = false; // 防止 before-quit 事件反复触发导致重复退出流程

// 优雅停止 capture.exe：先发 'stop\n' 让它正常收尾，5 秒还没退出就强杀
function stopCaptureProcess() {
  if (!captureProcess || captureProcess.killed) return Promise.resolve();
  // 通过 stdin 发送 stop 命令，capture.exe 收到后停止采集并把 WAV 文件头写完整
  try {
    captureProcess.stdin.write('stop\n');
    captureProcess.stdin.end();
  } catch {}
  return new Promise(resolve => {
    const onExit = () => resolve();
    captureProcess.once('close', onExit);
    // 兜底：5 秒未退出则直接 kill，避免一直挂住退出流程
    setTimeout(() => {
      captureProcess.removeListener('close', onExit);
      try { captureProcess.kill(); } catch {}
      resolve();
    }, 5000);
  });
}

// 退出前先停掉录制子进程，否则 capture.exe 会变成孤儿进程继续写文件
app.on('before-quit', (event) => {
  if (isQuitting) return;
  if (captureProcess && !captureProcess.killed) {
    // 阻止默认退出，等子进程清理完再调用 app.quit() 完成退出
    event.preventDefault();
    isQuitting = true;
    stopCaptureProcess().then(() => app.quit());
  }
});

// IPC: 渲染进程请求枚举输出设备
// 调用 capture.exe list，输出格式为每行 "设备ID|设备名称"
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
      // 解析 "ID|Name" 格式的设备列表
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

// IPC: 开始录制
// 流程：弹保存对话框 -> 启动 capture.exe record -> 等它输出 READY 表示采集已就绪
ipcMain.handle('start-recording', async (event, deviceId) => {
  if (captureProcess) {
    throw new Error('已经在录制中');
  }
  // 让用户选择保存位置，默认文件名带时间戳避免覆盖
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
    // capture.exe record <deviceId> <outputPath>：启动后开始采集并写 WAV
    const child = spawn(CAPTURE_EXE, ['record', deviceId, result.filePath]);
    let ready = false; // 收到 READY 之前都视为启动阶段
    let stderr = '';

    child.stderr.on('data', d => { stderr += d.toString(); });
    child.stdout.on('data', d => {
      const text = d.toString();
      // capture.exe 初始化完成后会输出 READY，此时才认为录制真正开始
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
      // 还没 READY 就退出，说明启动失败
      if (!ready) {
        reject(new Error(`capture.exe 启动失败（exit ${code}）：${stderr}`));
        return;
      }
      // 正常停止后通知渲染进程，刷新 UI 和状态
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('recording-stopped', { path: currentOutputPath, code });
      }
    });
  });
});

// IPC: 停止录制
// 只发停止命令，真正的"已停止"通知由子进程 close 事件触发（见 start-recording）
ipcMain.handle('stop-recording', async () => {
  if (!captureProcess) return { ok: false };
  try {
    captureProcess.stdin.write('stop\n');
    captureProcess.stdin.end();
  } catch {}
  return { ok: true };
});
