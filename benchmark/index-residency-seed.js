// SPDX-License-Identifier: GPL-3.0-or-later
// Benchmark setup only: persist the native importer's files before starting
// the measured engine. Sync access avoids per-chunk writable-stream IPC.
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
        const access = await handle.createSyncAccessHandle();
        try {
          if (access.write(bytes, { at: 0 }) !== bytes.length) throw new Error("short fixture write");
          access.truncate(bytes.length);
          access.flush();
        } finally { access.close(); }
      }
    }
    self.postMessage({ ok: true });
  } catch (error) { self.postMessage({ ok: false, error: String(error) }); }
};
