// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";

// MPEG-1's sample rates by a frame header's rate bits.
const MPEG1_RATES = [44_100, 48_000, 32_000];
// An MP3 begins with its encoder's delay and pads its last frame, so a line's
// decoded sound runs this much longer than its cut at most.
export const MP3_SLACK_MS = 60;

// A line's {sentence-audio} MP3, as the fake AnkiConnect stored it, decoded by
// Chrome's own MP3 decoder in `page` at the MP3's sample rate: the rate its
// first frame names, whether that frame is mono, and the decoded samples.
export async function decodeSentenceAudio(page, base64) {
  const head = Buffer.from(base64.slice(0, 8), "base64");
  assert.ok(head[0] === 0xff && head[1] >> 3 === 0b11111 && ((head[1] >> 1) & 0b11) === 0b01,
    "the line's audio begins with an MPEG-1 Layer III frame");
  const rate = MPEG1_RATES[(head[2] >> 2) & 0b11];
  const decoded = await page.evaluate(async (data, sampleRate) => {
    const bytes = Uint8Array.from(atob(data), character => character.charCodeAt(0));
    const buffer = await new globalThis.OfflineAudioContext(1, 1, sampleRate).decodeAudioData(bytes.buffer);
    const channel = buffer.getChannelData(0);
    const raw = new Uint8Array(channel.buffer, channel.byteOffset, channel.byteLength);
    let binary = "";
    for (let index = 0; index < raw.length; index += 0x8000) binary += String.fromCharCode(...raw.subarray(index, index + 0x8000));
    return btoa(binary);
  }, base64, rate);
  const raw = Buffer.from(decoded, "base64");
  return { rate, mono: head[3] >> 6 === 0b11,
    samples: new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)) };
}
