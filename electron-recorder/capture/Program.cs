// capture.exe -- 由 Electron 主进程作为子进程拉起，用 WASAPI loopback 采集系统输出音频。
//
// 三个子命令：
//   list                 枚举当前激活的输出设备，每行输出 "ID|名称"
//   record <id> <path>   采集并直接落 WAV 文件
//   stream <id>          采集并重采样为 16kHz 单声道 float32 PCM，从 stdout 二进制流式输出
//
// stream 模式下的流协议（三流分离）：
//   stdout -- 纯二进制 PCM，绝对不能写任何文本（会污染数据）
//   stderr -- 状态信号，如 "READY"
//   stdin  -- 控制信号，目前只认一行 "stop" 触发停止；EOF（父进程关 stdin）也视为停止

using System.Threading;
using NAudio.CoreAudioApi;
using NAudio.MediaFoundation;
using NAudio.Wave;

if (args.Length == 0)
{
    Console.Error.WriteLine("Usage: capture.exe list | record <deviceId> <outputPath>");
    return 1;
}

var command = args[0].ToLowerInvariant();

// ---- list：枚举输出设备 ----
if (command == "list")
{
    var enumerator = new MMDeviceEnumerator();
    // DataFlow.Render = 输出端点（扬声器/耳机），DeviceState.Active = 当前可用
    foreach (var device in enumerator.EnumerateAudioEndPoints(DataFlow.Render, DeviceState.Active))
    {
        Console.WriteLine($"{device.ID}|{device.FriendlyName}");
    }
    return 0;
}

// ---- record：采集到 WAV 文件 ----
if (command == "record")
{
    if (args.Length < 3)
    {
        Console.Error.WriteLine("Usage: capture.exe record <deviceId> <outputPath>");
        return 1;
    }

    var deviceId = args[1];
    var outputPath = args[2];

    var enumerator = new MMDeviceEnumerator();
    MMDevice? device;
    try
    {
        device = enumerator.GetDevice(deviceId);
    }
    catch (Exception ex)
    {
        Console.Error.WriteLine($"Device not found: {deviceId}. {ex.Message}");
        return 1;
    }

    // WasapiLoopbackCapture：抓取该设备"正在播放"的混音流（系统声音），不是 mic 输入
    var capture = new WasapiLoopbackCapture(device);
    var writer = new WaveFileWriter(outputPath, capture.WaveFormat);
    var stopped = new ManualResetEventSlim(false);  // 等 RecordingStopped 事件

    // 采集到数据就追加写盘。NAudio 在内部线程上触发此回调。
    capture.DataAvailable += (s, e) =>
    {
        if (e.BytesRecorded > 0)
        {
            writer.Write(e.Buffer, 0, e.BytesRecorded);
        }
    };

    // StopRecording 是异步的：触发后等此事件，确保 writer 安全 Dispose（写完 WAV 尾部）
    capture.RecordingStopped += (s, e) =>
    {
        try { writer.Dispose(); } catch { }
        stopped.Set();
    };

    capture.StartRecording();
    // READY 行通知父进程：从此刻起 stdin 可以发 "stop" 了
    Console.Out.WriteLine("READY");
    Console.Out.Flush();

    // 阻塞等 stdin 的 "stop" 指令；EOF（父进程关 stdin）也会退出循环
    string? line;
    while ((line = Console.In.ReadLine()) != null)
    {
        if (line.Trim().Equals("stop", StringComparison.OrdinalIgnoreCase))
        {
            break;
        }
    }

    capture.StopRecording();
    stopped.Wait(5000);  // 最多等 5s，防止 RecordingStopped 不触发卡死
    return 0;
}

// ---- stream：采集 -> 重采样 -> stdout 二进制 PCM ----
if (command == "stream")
{
    if (args.Length < 2)
    {
        Console.Error.WriteLine("Usage: capture.exe stream <deviceId>");
        return 1;
    }

    var deviceId = args[1];
    var enumerator = new MMDeviceEnumerator();
    MMDevice? device;
    try
    {
        device = enumerator.GetDevice(deviceId);
    }
    catch (Exception ex)
    {
        Console.Error.WriteLine($"Device not found: {deviceId}. {ex.Message}");
        return 1;
    }

    // WASAPI loopback 的采样率由设备 mix format 决定（通常 48kHz 立体声 float32）。
    // ASR 后端要 16kHz 单声道 float32，所以这里必须重采样。
    var capture = new WasapiLoopbackCapture(device);
    var outFormat = WaveFormat.CreateIeeeFloatWaveFormat(16000, 1);

    // BufferedWaveProvider 把"推式"的采集回调桥接到"拉式"的重采样器：
    //   采集线程 push 进来 -> pump 线程 pull 出去重采样。
    // ReadFully=false 让缓冲为空时 Read 直接返回 0（而不是用静音填充），
    //   这样 pump 线程能 sleep 节流，使输出节奏跟随实时音频。
    // BufferDuration=2s + DiscardOnBufferOverflow=true：pump 跟不上时丢数据保活，不阻塞采集。
    var bufferProvider = new BufferedWaveProvider(capture.WaveFormat)
    {
        BufferDuration = TimeSpan.FromSeconds(2),
        DiscardOnBufferOverflow = true,
        ReadFully = false
    };
    var resampler = new MediaFoundationResampler(bufferProvider, outFormat);

    // stdout 是纯二进制 PCM 流，任何文本输出都会污染数据 -- 下面 READY 走 stderr。
    var stdout = Console.OpenStandardOutput();
    var stopRequested = false;
    var captureDone = new ManualResetEventSlim(false);  // 采集已彻底停止
    var pumpDone = new ManualResetEventSlim(false);     // pump 线程已退出

    // 采集回调：把原始字节塞进缓冲提供者
    capture.DataAvailable += (s, e) =>
    {
        if (e.BytesRecorded > 0)
        {
            bufferProvider.AddSamples(e.Buffer, 0, e.BytesRecorded);
        }
    };
    capture.RecordingStopped += (s, e) => captureDone.Set();

    capture.StartRecording();
    // READY 走 stderr，避免污染 stdout 的二进制 PCM
    Console.Error.WriteLine("READY");
    Console.Error.Flush();

    // pump 线程：循环从重采样器拉数据写 stdout。
    // readBuffer = 6400 字节 = 100ms 音频（16kHz * 1ch * 4byte * 100ms）
    var readBuffer = new byte[6400];
    var pumpThread = new Thread(() =>
    {
        while (true)
        {
            // 收到停止信号且源缓冲已空：把重采样器内部尾包读干净就退出
            if (stopRequested && bufferProvider.BufferedBytes == 0)
            {
                int r;
                while ((r = resampler.Read(readBuffer, 0, readBuffer.Length)) > 0)
                {
                    stdout.Write(readBuffer, 0, r);
                }
                break;
            }

            int read = resampler.Read(readBuffer, 0, readBuffer.Length);
            if (read > 0)
            {
                stdout.Write(readBuffer, 0, read);
                stdout.Flush();
            }
            else if (!stopRequested)
            {
                Thread.Sleep(10);  // 暂时没数据，sleep 10ms 等下一批，避免空转
            }
        }
        pumpDone.Set();
    });
    pumpThread.IsBackground = true;
    pumpThread.Start();

    // 主线程阻塞等 stdin 的 "stop" 指令；EOF 也算停止
    string? line;
    while ((line = Console.In.ReadLine()) != null)
    {
        if (line.Trim().Equals("stop", StringComparison.OrdinalIgnoreCase))
        {
            stopRequested = true;
            break;
        }
    }

    capture.StopRecording();
    captureDone.Wait(5000);  // 等采集彻底停（保证 DataAvailable 都触发完）
    pumpDone.Wait(5000);     // 等 pump 线程排干尾包并退出
    stdout.Flush();
    return 0;
}

Console.Error.WriteLine($"Unknown command: {command}");
return 1;
