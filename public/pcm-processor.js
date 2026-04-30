// AudioWorklet that converts mic audio (Float32, -1..1) to 16-bit signed PCM
// and posts each frame back to the main thread for base64-encoding and
// WebSocket transmission.
//
// Loaded by audioCtx.audioWorklet.addModule("pcm-processor.js"). Runs at
// whatever rate the AudioContext was created with — we force 24000 Hz on the
// main thread to match the Voice Agent API default (audio/pcm @ 24 kHz).

class PCMProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;

    const channel = input[0]; // mono
    const pcm = new Int16Array(channel.length);
    for (let i = 0; i < channel.length; i++) {
      const s = Math.max(-1, Math.min(1, channel[i]));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }

    this.port.postMessage(pcm.buffer, [pcm.buffer]);
    return true;
  }
}

registerProcessor("pcm-processor", PCMProcessor);
