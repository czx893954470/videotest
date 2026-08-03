const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const CAPTURE = path.join(__dirname, 'bin', 'capture', 'capture.exe');
const DEVICE_ID = '{0.0.0.00000000}.{9ee7208c-7a78-4006-8984-c07fe0ead143}';
const OUT = path.join(__dirname, 'test-recording.wav');

if (fs.existsSync(OUT)) fs.unlinkSync(OUT);

const t0 = Date.now();
const child = spawn(CAPTURE, ['record', DEVICE_ID, OUT]);
let ready = false;
let stderr = '';

child.stdout.on('data', d => {
  const text = d.toString();
  console.log(`[+${Date.now()-t0}ms] stdout: ${JSON.stringify(text)}`);
  if (!ready && text.includes('READY')) {
    ready = true;
    console.log(`[+${Date.now()-t0}ms] READY received, recording 2s...`);
    setTimeout(() => {
      console.log(`[+${Date.now()-t0}ms] sending stop...`);
      child.stdin.write('stop\n');
      child.stdin.end();
    }, 2000);
  }
});

child.stderr.on('data', d => { stderr += d.toString(); });

child.on('close', code => {
  console.log(`[+${Date.now()-t0}ms] process exited, code=${code}`);
  if (stderr) console.log('stderr:', stderr);
  if (fs.existsSync(OUT)) {
    const stat = fs.statSync(OUT);
    console.log(`file size: ${stat.size} bytes`);
    const fd = fs.openSync(OUT, 'r');
    const buf = Buffer.alloc(12);
    fs.readSync(fd, buf, 0, 12, 0);
    fs.closeSync(fd);
    console.log(`header: ${buf.toString('ascii', 0, 4)} ${buf.toString('ascii', 8, 12)}`);
  } else {
    console.log('file not created');
  }
});

child.on('error', err => console.log('error:', err));
