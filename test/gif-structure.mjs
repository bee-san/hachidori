// SPDX-License-Identifier: GPL-3.0-or-later
//
// The block structure of a GIF89a file, for the Node GIF tests: its screen size,
// whether it has a global colour table, the NETSCAPE loop count, and each
// image's delay (from the graphic control extension before it) and whether it
// carries a local colour table. It walks the blocks rather than searching for
// marker bytes, which palettes and LZW data contain too.
export function readGif(bytes) {
  const buffer = Buffer.from(bytes);
  if (buffer.toString("ascii", 0, 6) !== "GIF89a") throw new Error("Not a GIF89a file.");
  const tableBytes = packed => (packed & 0x80 ? 3 * 2 ** ((packed & 7) + 1) : 0);
  const gif = { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8),
    globalColorTable: (buffer[10] & 0x80) !== 0, loop: null, frames: [] };
  let offset = 13 + tableBytes(buffer[10]);
  let delayCs = null;
  const skipSubBlocks = () => {
    while (offset < buffer.length && buffer[offset] !== 0) offset += buffer[offset] + 1;
    if (offset >= buffer.length) throw new Error("The GIF ends inside a block.");
    offset += 1;
  };
  for (;;) {
    const introducer = buffer[offset];
    if (introducer === 0x3b) return gif;
    if (introducer === 0x21) {
      const label = buffer[offset + 1];
      if (label === 0xf9) delayCs = buffer.readUInt16LE(offset + 4);
      if (label === 0xff && buffer.toString("ascii", offset + 3, offset + 14) === "NETSCAPE2.0") {
        gif.loop = buffer.readUInt16LE(offset + 16);
      }
      offset += 2;
      skipSubBlocks();
    } else if (introducer === 0x2c) {
      const packed = buffer[offset + 9];
      gif.frames.push({ delayCs, localColorTable: (packed & 0x80) !== 0 });
      delayCs = null;
      // The image descriptor, its local colour table, then the LZW code size.
      offset += 10 + tableBytes(packed) + 1;
      skipSubBlocks();
    } else {
      throw new Error(`Unexpected GIF block ${introducer} at byte ${offset}.`);
    }
  }
}
