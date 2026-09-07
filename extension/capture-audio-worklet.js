// SPDX-License-Identifier: GPL-3.0-or-later

class HachidoriCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.batch = new Float32Array(2048);
    this.length = 0;
    this.startFrame = 0;
  }

  process(inputs) {
    const channels = inputs[0];
    if (!channels?.length || !channels[0]?.length) return true;
    const frameCount = channels[0].length;
    for (let frame = 0; frame < frameCount; frame += 1) {
      if (this.length === 0) this.startFrame = currentFrame + frame;
      let sample = 0;
      for (const channel of channels) sample += channel[frame] ?? 0;
      this.batch[this.length] = sample / channels.length;
      this.length += 1;
      if (this.length === this.batch.length) {
        const samples = this.batch;
        this.port.postMessage({ startFrame: this.startFrame, samples: samples.buffer }, [samples.buffer]);
        this.batch = new Float32Array(2048);
        this.length = 0;
      }
    }
    return true;
  }
}

registerProcessor("hachidori-capture-audio", HachidoriCaptureProcessor);
