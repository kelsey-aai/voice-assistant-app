// public/pcm-worklet.js: converts mic audio to 16 kHz, 16-bit PCM for speech-to-text.
// Runs off the main thread. Resamples from whatever rate the browser uses
// (Safari ignores a requested sampleRate; Firefox loses echo cancellation with one).
const TARGET_RATE = 16000;

class PCMWorklet extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = sampleRate / TARGET_RATE; // `sampleRate` is a global in worklet scope
    this.pos = 0;                         // fractional read position
    this.carry = new Float32Array(0);
  }

  process(inputs) {
    const input = inputs[0][0];
    if (!input) return true;

    // Join leftover samples from the previous block with the new block.
    const buf = new Float32Array(this.carry.length + input.length);
    buf.set(this.carry);
    buf.set(input, this.carry.length);

    // Linear-interpolation resample, then clip and convert to Int16.
    const out = [];
    while (this.pos + 1 < buf.length) {
      const i = Math.floor(this.pos);
      const frac = this.pos - i;
      const s = Math.max(-1, Math.min(1, buf[i] * (1 - frac) + buf[i + 1] * frac));
      out.push(s < 0 ? s * 0x8000 : s * 0x7fff);
      this.pos += this.step;
    }

    const used = Math.floor(this.pos);
    this.carry = buf.slice(used);
    this.pos -= used;

    if (out.length) {
      const pcm = Int16Array.from(out);
      this.port.postMessage(pcm.buffer, [pcm.buffer]); // transfer, don't copy
    }
    return true;
  }
}

registerProcessor("pcm-worklet", PCMWorklet);
