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

if (command == "list")
{
    var enumerator = new MMDeviceEnumerator();
    foreach (var device in enumerator.EnumerateAudioEndPoints(DataFlow.Render, DeviceState.Active))
    {
        Console.WriteLine($"{device.ID}|{device.FriendlyName}");
    }
    return 0;
}

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

    var capture = new WasapiLoopbackCapture(device);
    var writer = new WaveFileWriter(outputPath, capture.WaveFormat);
    var stopped = new ManualResetEventSlim(false);

    capture.DataAvailable += (s, e) =>
    {
        if (e.BytesRecorded > 0)
        {
            writer.Write(e.Buffer, 0, e.BytesRecorded);
        }
    };

    capture.RecordingStopped += (s, e) =>
    {
        try { writer.Dispose(); } catch { }
        stopped.Set();
    };

    capture.StartRecording();
    Console.Out.WriteLine("READY");
    Console.Out.Flush();

    string? line;
    while ((line = Console.In.ReadLine()) != null)
    {
        if (line.Trim().Equals("stop", StringComparison.OrdinalIgnoreCase))
        {
            break;
        }
    }

    capture.StopRecording();
    stopped.Wait(5000);
    return 0;
}

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

    // WASAPI loopback captures at the device's mix format (typically 48kHz stereo float32).
    // We resample to 16kHz mono float32 for the ASR backend.
    var capture = new WasapiLoopbackCapture(device);
    var outFormat = WaveFormat.CreateIeeeFloatWaveFormat(16000, 1);

    // BufferedWaveProvider bridges the push-based capture to the pull-based resampler.
    // ReadFully=false so Read returns 0 when empty (instead of padding with silence),
    // which lets the pump thread sleep and pace output to real-time.
    var bufferProvider = new BufferedWaveProvider(capture.WaveFormat)
    {
        BufferDuration = TimeSpan.FromSeconds(2),
        DiscardOnBufferOverflow = true,
        ReadFully = false
    };
    var resampler = new MediaFoundationResampler(bufferProvider, outFormat);

    // Binary stdout - keep this stream pure, no text writes to stdout.
    var stdout = Console.OpenStandardOutput();
    var stopRequested = false;
    var captureDone = new ManualResetEventSlim(false);
    var pumpDone = new ManualResetEventSlim(false);

    capture.DataAvailable += (s, e) =>
    {
        if (e.BytesRecorded > 0)
        {
            bufferProvider.AddSamples(e.Buffer, 0, e.BytesRecorded);
        }
    };
    capture.RecordingStopped += (s, e) => captureDone.Set();

    capture.StartRecording();
    // READY goes to stderr so stdout stays pure binary.
    Console.Error.WriteLine("READY");
    Console.Error.Flush();

    // Background thread pulls resampled float32 PCM and writes to stdout.
    var readBuffer = new byte[6400]; // 100ms @ 16kHz mono float32 = 1600 samples * 4 bytes
    var pumpThread = new Thread(() =>
    {
        while (true)
        {
            // On stop, drain resampler tail then exit.
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
                Thread.Sleep(10); // No data yet; avoid busy-looping.
            }
        }
        pumpDone.Set();
    });
    pumpThread.IsBackground = true;
    pumpThread.Start();

    // Wait for "stop" on stdin.
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
    captureDone.Wait(5000);
    pumpDone.Wait(5000);
    stdout.Flush();
    return 0;
}

Console.Error.WriteLine($"Unknown command: {command}");
return 1;
