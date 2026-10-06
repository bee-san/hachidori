// SPDX-License-Identifier: GPL-3.0-or-later

// Mono PCM for a Netflix sentence clip, numbered by AudioContext frame so
// netflix-capture.js can place every sample on the wall clock. Revived from
// the removed media recorder's capture-audio-worklet.js.
class HachidoriNetflixAudio extends AudioWorkletProcessor {
  constructor() {
    super();
    this.batch = new Float32Array(4096);
    this.length = 0;
    this.startFrame = 0;
    this.port.onmessage = ({ data }) => {
      if (data?.flush !== true) return;
      this.send();
      this.port.postMessage({ flushed: true });
    };
  }

  send() {
    if (this.length === 0) return;
    const samples = this.batch.slice(0, this.length);
    this.port.postMessage({ startFrame: this.startFrame, samples: samples.buffer }, [samples.buffer]);
    this.length = 0;
  }

  // Returning false would let Chrome retire the processor before the stream's
  // first samples arrive.
  process(inputs) { // NOSONAR -- S3516: the AudioWorklet lifetime contract requires true.
    const channels = inputs[0];
    const frames = channels?.[0]?.length ?? 0;
    // A gap in the input starts a new batch, so frame numbers stay exact.
    if (this.length > 0 && currentFrame !== this.startFrame + this.length) this.send();
    for (let frame = 0; frame < frames; frame += 1) {
      if (this.length === 0) this.startFrame = currentFrame + frame;
      let sum = 0;
      for (const channel of channels) sum += channel[frame] ?? 0;
      this.batch[this.length] = sum / channels.length;
      this.length += 1;
      if (this.length === this.batch.length) this.send();
    }
    return true;
  }
}

registerProcessor("hachidori-netflix-audio", HachidoriNetflixAudio);
