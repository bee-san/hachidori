// SPDX-License-Identifier: GPL-3.0-or-later
// AVIF image-sequence metadata around Mediabunny's AV1 track. The library
// owns AV1 encoding, timing and MP4 sample tables; AVIF adds a primary image,
// the pict handler and a repeating edit list (AVIF 1.2 §3, §7; HEIF §9.6.3).
import { BufferTarget, Mp4OutputFormat, Output, VideoSample, VideoSampleSource, Quality } from "./vendor/mediabunny/mediabunny.js";

const text = value => new TextEncoder().encode(value);
const number = (value, bytes = 4) => {
  const out = new Uint8Array(bytes);
  for (let index = bytes - 1; index >= 0; index -= 1) { out[index] = value & 255; value = Math.floor(value / 256); }
  return out;
};
const join = parts => {
  const out = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
};
const box = (type, ...parts) => join([number(8 + parts.reduce((size, part) => size + part.length, 0)), text(type), ...parts]);
const full = (type, version, flags, ...parts) => box(type, number(version, 1), number(flags, 3), ...parts);
const uint = (data, offset) => new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(offset);

function boxes(data, start = 0) {
  const result = [];
  for (let offset = start; offset < data.length;) {
    const shortSize = uint(data, offset);
    const size = shortSize === 1 ? uint(data, offset + 8) * 2 ** 32 + uint(data, offset + 12)
      : shortSize || data.length - offset;
    result.push({ type: new TextDecoder().decode(data.subarray(offset + 4, offset + 8)),
      data: data.slice(offset, offset + size), offset });
    offset += size;
  }
  return result;
}

function primaryImage(sample, config, width, height) {
  const properties = box("iprp", box("ipco",
    full("ispe", 0, 0, number(width), number(height)),
    full("pixi", 0, 0, new Uint8Array([3, 8, 8, 8])), config),
  full("ipma", 0, 0, number(1), number(1, 2), new Uint8Array([3, 1, 2, 0x83])));
  return full("meta", 0, 0,
    full("hdlr", 0, 0, number(0), text("pict"), new Uint8Array(13)),
    full("pitm", 0, 0, number(1, 2)),
    // construction_method=1: the extent is relative to idat, not file offsets.
    full("iloc", 1, 0, new Uint8Array([0x44, 0]), number(1, 2), number(1, 2), number(1, 2),
      number(0, 2), number(1, 2), number(0), number(sample.length)),
    full("iinf", 0, 0, number(1, 2), full("infe", 2, 0, number(1, 2), number(0, 2), text("av01"), new Uint8Array(1))),
    properties, box("idat", sample));
}

function indefiniteHeader(type, data, durationOffset) {
  // Use the 64-bit indefinite duration. Older Chromium AVIF decoders treat
  // the 32-bit all-one value as a finite duration rather than as indefinite.
  return full(type, 1, uint(data, 8) & 0xffffff,
    number(uint(data, 12), 8), number(uint(data, 16), 8), data.subarray(20, durationOffset),
    new Uint8Array(8).fill(255), data.subarray(durationOffset + 4));
}

export async function encodeAvif(entries, width, height, quality) {
  const target = new BufferTarget();
  let first = null;
  const output = new Output({ target, format: new Mp4OutputFormat({ fastStart: false }) });
  const source = new VideoSampleSource({ codec: "av1", quality: new Quality(quality / 100),
    onEncodedPacket: packet => { first ??= packet.data.slice(); } });
  output.addVideoTrack(source);
  await output.start();
  const canvas = new OffscreenCanvas(width, height), context = canvas.getContext("2d");
  let timestamp = 0;
  try {
    for (const { data, delayMs } of entries) {
      context.putImageData(new ImageData(new Uint8ClampedArray(data), width, height), 0, 0);
      const sample = new VideoSample(canvas, { timestamp, duration: delayMs / 1000 });
      try { await source.add(sample); } finally { sample.close(); } // NOSONAR: Mediabunny requires ordered samples and encoder backpressure before reusing the canvas
      timestamp += delayMs / 1000;
    }
    await output.finalize();
  } catch (error) {
    await output.cancel();
    throw error;
  }
  const parts = boxes(new Uint8Array(target.buffer));
  const ftyp = box("ftyp", text("avis"), number(0), text("avisavifmsf1mif1"));
  const shift = ftyp.length - parts[0].data.length;
  let config;
  let timescale;
  function rewrite({ type, data }) {
    if (["moov", "trak", "mdia", "minf", "stbl"].includes(type)) {
      const children = boxes(data, 8).filter(child => child.type !== "edts").map(rewrite);
      if (type === "trak") children.push(box("edts", full("elst", 0, 1, number(1),
        number(Math.round(timestamp * timescale)), number(0), number(1, 2), number(0, 2))));
      return box(type, ...children);
    }
    switch (type) {
      case "stsd": {
        const entry = boxes(data, 16)[0];
        config = boxes(entry.data, 86).find(child => child.type === "av1C")?.data;
        break;
      }
      case "hdlr":
        // MP4 accepts QuickTime's mhlr component type; AVIF requires zero.
        data.fill(0, 12, 16);
        data.set(text("pict"), 16);
        break;
      case "stco":
        for (let offset = 16; offset < data.length; offset += 4) data.set(number(uint(data, offset) + shift), offset);
        break;
      case "co64": {
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        for (let offset = 16; offset < data.length; offset += 8) view.setBigUint64(offset, view.getBigUint64(offset) + BigInt(shift));
        break;
      }
      // All-one duration denotes an indefinitely repeating sequence.
      case "mvhd": timescale = uint(data, 20); return indefiniteHeader(type, data, 24);
      case "tkhd": return indefiniteHeader(type, data, 28);
      default: break;
    }
    return data;
  }
  const movie = parts.slice(1).map(rewrite);
  if (!first || !config) throw new Error("The AV1 encoder produced no AVIF image sequence.");
  return join([ftyp, ...movie, primaryImage(first, config, width, height)]);
}
