// SPDX-License-Identifier: GPL-3.0-or-later

class HachidoriCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.batch = new Float32Array(2048);
    this.length = 0;
    this.startFrame = 0;
    this.nextFrame = null;
    this.interrupted = false;
  }

  inputInterrupted(frameCount) {
    if (this.nextFrame !== null && (frameCount === 0 || currentFrame !== this.nextFrame)) {
      this.interrupted = true;
      this.length = 0;
      this.port.postMessage({ error: "The captured audio clock was interrupted. Start capture again." });
      return true;
    }
    this.nextFrame = frameCount ? currentFrame + frameCount : null;
    return false;
  }

  // Empty input can precede the first active quantum. Returning false allows
  // Chrome to permanently retire this processor before the source is ready.
  process(inputs) { // NOSONAR -- S3516: the AudioWorklet lifetime contract requires true.
    if (this.interrupted) return true;
    const channels = inputs[0];
    const frameCount = channels?.[0]?.length ?? 0;
    if (this.inputInterrupted(frameCount) || frameCount === 0) return true;
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
