const test = require('node:test');
const assert = require('node:assert');
const { createWavHeader, float32ToInt16Pcm } = require('../wav-utils.js');

test('createWavHeader writes canonical 44-byte PCM header', () => {
  const header = createWavHeader(16000, 1, 16000); // 1s of 16kHz mono 16-bit PCM
  assert.equal(header.length, 44);
  assert.equal(header.toString('ascii', 0, 4), 'RIFF');
  assert.equal(header.toString('ascii', 8, 12), 'WAVE');
  assert.equal(header.toString('ascii', 12, 16), 'fmt ');
  assert.equal(header.readUInt32LE(16), 16);        // fmt chunk size
  assert.equal(header.readUInt16LE(20), 1);         // PCM format
  assert.equal(header.readUInt16LE(22), 1);         // mono
  assert.equal(header.readUInt32LE(24), 16000);     // sample rate
  assert.equal(header.readUInt32LE(28), 32000);     // byte rate = 16000*1*2
  assert.equal(header.readUInt16LE(32), 2);         // block align = 1*2
  assert.equal(header.readUInt16LE(34), 16);        // bits per sample
  assert.equal(header.toString('ascii', 36, 40), 'data');
  assert.equal(header.readUInt32LE(40), 16000);     // data chunk size
  // RIFF chunk size = 36 + data size
  assert.equal(header.readUInt32LE(4), 36 + 16000);
});

test('float32ToInt16Pcm converts float samples to int16 LE', () => {
  const input = new Float32Array([0, 0.5, -0.5, 1.0, -1.0]);
  const out = float32ToInt16Pcm(input);
  assert.equal(out.length, 10); // 5 samples * 2 bytes
  assert.equal(out.readInt16LE(0), 0);
  assert.equal(out.readInt16LE(2), 16384);       // 0.5 * 32767 ≈ 16384
  assert.equal(out.readInt16LE(4), -16384);      // -0.5 * 32767 ≈ -16384
  assert.equal(out.readInt16LE(6), 32767);       // 1.0 clamped
  assert.equal(out.readInt16LE(8), -32768);      // -1.0 clamped
});

test('float32ToInt16Pcm clamps out-of-range floats', () => {
  const input = new Float32Array([2.0, -2.0]);
  const out = float32ToInt16Pcm(input);
  assert.equal(out.readInt16LE(0), 32767);
  assert.equal(out.readInt16LE(2), -32768);
});
