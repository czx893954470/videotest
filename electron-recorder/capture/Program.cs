using System.Threading;
using NAudio.CoreAudioApi;
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

Console.Error.WriteLine($"Unknown command: {command}");
return 1;
