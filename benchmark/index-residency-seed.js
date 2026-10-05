// SPDX-License-Identifier: GPL-3.0-or-later
// Benchmark setup only: persist the native importer's files before starting
// the measured engine. Closing each stream persists it before startup.
self.onmessage = async ({ data: { dictionaries, fileNames, origin } }) => {
  try {
    const root = await navigator.storage.getDirectory();
    for (const dictionary of dictionaries) {
      const folder = await root.getDirectoryHandle(dictionary.title, { create: true });
      for (const name of fileNames) {
        const response = await fetch(`${origin}/${encodeURIComponent(dictionary.title)}/${encodeURIComponent(name)}`);
        if (!response.ok) throw new Error(`fixture download ${response.status}`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        const handle = await folder.getFileHandle(name, { create: true });
        // Creating the native importer's empty marker already persists it.
        // Chrome can leave a zero-byte writable-stream write unsettled.
        if (bytes.length === 0) continue;
        const writable = await handle.createWritable();
        await writable.write(bytes);
        await writable.close();
      }
    }
    self.postMessage({ ok: true });
  } catch (error) { self.postMessage({ ok: false, error: String(error) }); }
};
