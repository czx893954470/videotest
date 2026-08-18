// AudioWorklet 处理器：把麦克风（input 0）和系统音频（通过 port 消息塞进环形缓冲）
// 混音，每个 process() 调用产出一个 128 采样点的混音块，回传给主线程。
//
// 采样率 16kHz（由渲染进程的 AudioContext 设定），render quantum 128 样本 = 8ms，
// 输出单声道 float32。
//
// 主线程发来的消息：
//   { type: 'config', mic: boolean, system: boolean }  -> 设置启用源（默认都 true）
//   { type: 'system', samples: Float32Array }           -> 追加到环形缓冲
// 发给主线程的消息：
//   { type: 'mixed', samples: Float32Array }            -> 每次 process() 一个 128 样本块

const RING_SIZE = 16384; // ~1s @ 16kHz；足够吸收 IPC 抖动

class MixerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ring = new Float32Array(RING_SIZE);
    this.readPos = 0;
    this.writePos = 0;
    this.micEnabled = true;
    this.systemEnabled = true;
    this.port.onmessage = (e) => {
      if (e.data.type === 'config') {
        this.micEnabled = e.data.mic;
        this.systemEnabled = e.data.system;
      } else if (e.data.type === 'system') {
        this._pushRing(e.data.samples);
      }
    };
  }

  // 追加样本到环形缓冲；溢出时丢弃最旧的样本（推进 readPos）
  _pushRing(samples) {
    const n = samples.length;
    const free = (this.readPos - this.writePos + RING_SIZE) % RING_SIZE;
    if (n > free) {
      const drop = n - free;
      this.readPos = (this.readPos + drop) % RING_SIZE;
    }
    for (let i = 0; i < n; i++) {
      this.ring[this.writePos] = samples[i];
      this.writePos = (this.writePos + 1) % RING_SIZE;
    }
  }

  // 从环形缓冲读最多 n 个样本；下溢补 0
  _readRing(out, n) {
    const available = (this.writePos - this.readPos + RING_SIZE) % RING_SIZE;
    const toRead = Math.min(n, available);
    for (let i = 0; i < toRead; i++) {
      out[i] = this.ring[this.readPos];
      this.readPos = (this.readPos + 1) % RING_SIZE;
    }
    for (let i = toRead; i < n; i++) {
      out[i] = 0; // 下溢 -> 静音
    }
  }

  process(inputs, outputs) {
    const micInput = inputs[0];
    const micCh = (micInput && micInput.length > 0) ? micInput[0] : null;
    const out = outputs[0][0];

    // 复用一个临时缓冲读系统音频（128 = render quantum）
    if (!this._sysTemp || this._sysTemp.length !== out.length) {
      this._sysTemp = new Float32Array(out.length);
    }
    this._readRing(this._sysTemp, out.length);

    // 满增益混音：启用的源各以 1.0 相加。两源都开时可能削波，由用户选择。
    for (let i = 0; i < out.length; i++) {
      const mic = (this.micEnabled && micCh) ? micCh[i] : 0;
      const sys = this.systemEnabled ? this._sysTemp[i] : 0;
      out[i] = mic + sys;
    }

    // 把混音块回传主线程（复制一份，脱离输出缓冲）
    const mixed = new Float32Array(out.length);
    mixed.set(out);
    this.port.postMessage({ type: 'mixed', samples: mixed }, [mixed.buffer]);

    return true;
  }
}

registerProcessor('mixer-processor', MixerProcessor);
