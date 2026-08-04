// Pure helpers for WAV file writing. Used by main process.
// 16-bit PCM mono format at arbitrary sample rate.

// Returns the canonical 44-byte WAV header for the given data size.
function createWavHeader(sampleRate, numChannels, dataChunkSize) {
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * bitsPerSample / 8;
  const blockAlign = numChannels * bitsPerSample / 8;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataChunkSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);                    // PCM
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataChunkSize, 40);
  return header;
}

// Converts Float32 samples (-1.0..1.0) to 16-bit signed little-endian PCM bytes.
// Out-of-range values are clamped.
function float32ToInt16Pcm(float32Array) {
  const out = Buffer.alloc(float32Array.length * 2);
  for (let i = 0; i < float32Array.length; i++) {
    let s = Math.max(-1, Math.min(1, float32Array[i]));
    // Asymmetric int16 range: positive max 32767, negative max -32768.
    s = s < 0 ? s * 0x8000 : s * 0x7FFF;
    out.writeInt16LE(Math.round(s), i * 2);
  }
  return out;
}

module.exports = { createWavHeader, float32ToInt16Pcm };
