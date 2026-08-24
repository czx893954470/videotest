// Electron 主进程：负责窗口管理、文件保存对话框、与 capture.exe 子进程通信
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const { createWavHeader, float32ToInt16Pcm } = require('./wav-utils.js');

// capture.exe 是独立编译的音频采集程序，负责枚举设备与实际录制
// 开发环境从源码目录加载，打包后从 resources 目录加载
const CAPTURE_EXE = app.isPackaged
  ? path.join(process.resourcesPath, 'bin', 'capture', 'capture.exe')
  : path.join(__dirname, 'bin', 'capture', 'capture.exe');

let mainWindow = null;        // 主窗口引用，关闭后置 null
let captureProcess = null;    // 当前录制中的 capture.exe 子进程；为 null 表示未在录制
let currentOutputPath = null; // 当前录制文件保存路径，停止后用于通知渲染进程

let wavFd = null;        // 混音 WAV 文件描述符，null 表示未打开
let wavPath = null;      // WAV 文件路径，停止后返回给渲染进程
let wavDataBytes = 0;    // 已写入的 PCM 数据字节数，停止时用于回填 WAV 头

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
  mainWindow.webContents.openDevTools();
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

// 退出前先停掉录制子进程并收尾 WAV 文件，否则 capture.exe 会变孤儿、WAV 头不完整
function stopWavSaveInternal() {
  if (wavFd === null) return null;
  // 回填 RIFF chunk size（偏移 4）和 data chunk size（偏移 40）
  const sizeBuf = Buffer.alloc(4);
  sizeBuf.writeUInt32LE(36 + wavDataBytes, 0);
  fs.writeSync(wavFd, sizeBuf, 0, 4, 4);
  sizeBuf.writeUInt32LE(wavDataBytes, 0);
  fs.writeSync(wavFd, sizeBuf, 0, 4, 40);
  fs.closeSync(wavFd);
  const savedPath = wavPath;
  wavFd = null;
  wavPath = null;
  wavDataBytes = 0;
  return savedPath;
}

// 退出前先停掉录制子进程，否则 capture.exe 会变成孤儿进程继续写文件
app.on('before-quit', (event) => {
  if (isQuitting) return;
  const needsCaptureStop = captureProcess && !captureProcess.killed;
  const needsWavStop = wavFd !== null;
  if (needsCaptureStop || needsWavStop) {
    // 阻止默认退出，等子进程清理完再调用 app.quit() 完成退出
    event.preventDefault();
    isQuitting = true;
    Promise.resolve()
      .then(() => needsCaptureStop ? stopCaptureProcess() : null)
      .then(() => {
        if (needsWavStop) {
          try { stopWavSaveInternal(); } catch {}
        }
      })
      .then(() => app.quit());
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

// ─── System audio streaming (for ASR) ───────────────────────────────
// Spawns capture.exe in stream-all mode, forwards stdout float32 PCM to renderer.
// capture.exe stream-all 枚举所有 ACTIVE render endpoints，各自重采样后内部混音，
// 输出 16kHz mono float32 PCM 到 stdout；READY 信号走 stderr。主进程把 stdout 二进制
// 块转发给渲染进程；stderr 每行透传到主进程控制台（开发者可见抓了几台、哪台失败）。

ipcMain.handle('start-system-audio', async (event) => {
  if (captureProcess) {
    throw new Error('capture.exe already running');
  }

  return new Promise((resolve, reject) => {
    const child = spawn(CAPTURE_EXE, ['stream-all']);
    let ready = false;
    let stderr = '';

    child.stderr.on('data', d => {
      const text = d.toString();
      stderr += text;
      // 把每行 stderr 透传到主进程控制台：开发者能看到抓了几台、哪台失败
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (trimmed) console.log('[capture]', trimmed);
      }
      // capture.exe 初始化完成后在 stderr 输出 READY
      if (!ready && text.includes('READY')) {
        ready = true;
        captureProcess = child;
        resolve({ ok: true });
      }
    });

    // 把 stdout 二进制块作为 Float32Array 转发给渲染进程
    let systemChunkCount = 0;
    child.stdout.on('data', buf => {
      if (!ready) return; // READY 之前不应有数据，保险起见过滤
      const f32 = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
      // 调试：每 10 块打印一次系统音频振幅（0=静音，>0.01 基本能听到）
      systemChunkCount++;
      if (systemChunkCount % 10 === 0) {
        let max = 0;
        for (let i = 0; i < f32.length; i++) { const v = Math.abs(f32[i]); if (v > max) max = v; }
        console.log(`[main] system audio chunk #${systemChunkCount} samples=${f32.length} maxAmp=${max.toFixed(4)}`);
      }
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('system-audio-chunk', f32);
      }
    });

    child.on('error', err => {
      if (!ready) reject(new Error(`无法启动 capture.exe：${err.message}`));
    });

    child.on('close', code => {
      captureProcess = null;
      if (!ready) {
        reject(new Error(`capture.exe stream-all 启动失败（exit ${code}）：${stderr}`));
        return;
      }
      // 通知渲染进程流已结束（录音中途结束可能是设备被拔）
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('system-audio-stopped', { code });
      }
    });
  });
});

// 停止系统音频采集：发 stop 命令，真正退出由 close 事件触发
ipcMain.handle('stop-system-audio', async () => {
  if (!captureProcess) return { ok: false };
  try {
    captureProcess.stdin.write('stop\n');
    captureProcess.stdin.end();
  } catch {}
  return { ok: true };
});

// ─── Mixed-audio WAV backup ────────────────────────────────────────
// 渲染进程发来混音后的 float32 块，主进程转 16-bit PCM 写入 WAV。
// 开始时写占位 WAV 头（size=0），停止时回填真实 size。

ipcMain.handle('start-wav-save', async () => {
  if (wavFd !== null) {
    throw new Error('WAV file already open');
  }
  const result = await dialog.showSaveDialog(mainWindow, {
    title: '保存录音',
    defaultPath: `recording-${Date.now()}.wav`,
    filters: [{ name: 'WAV', extensions: ['wav'] }],
  });
  if (result.canceled || !result.filePath) {
    return { ok: false, canceled: true };
  }
  wavPath = result.filePath;
  wavDataBytes = 0;
  // 'w' 创建/截断。注意：用 null position 写入让文件指针正常推进，
  // 后续数据块也用 null position 追加；停止时用显式 position 回填头。
  wavFd = fs.openSync(wavPath, 'w');
  // 占位头（data size = 0），停止时回填
  const header = createWavHeader(16000, 1, 0);
  fs.writeSync(wavFd, header, 0, 44, null);
  return { ok: true, path: wavPath };
});

// 渲染进程推送混音 float32 块；转 int16 追加到文件
ipcMain.on('mixed-audio-chunk', (event, float32Array) => {
  if (wavFd === null) return;
  const pcm = float32ToInt16Pcm(float32Array);
  fs.writeSync(wavFd, pcm, 0, pcm.length, null); // null position = 追加
  wavDataBytes += pcm.length;
});

ipcMain.handle('stop-wav-save', async () => {
  const savedPath = stopWavSaveInternal();
  if (savedPath === null) return { ok: false };
  return { ok: true, path: savedPath };
});
