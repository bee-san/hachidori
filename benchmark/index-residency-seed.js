// SPDX-License-Identifier: GPL-3.0-or-later
// Benchmark setup only: persist the native importer's files before starting
// the measured engine. Closing each stream persists it before startup.
self.onmessage = async ({ data: { dictionaries, files, origin } }) => {
  try {
    const root = await navigator.storage.getDirectory();
    for (const dictionary of dictionaries) {
      const folder = await root.getDirectoryHandle(dictionary.title, { create: true });
      for (const { name, bytes: size } of files) {
        self.__seedStage = { title: dictionary.title, name, step: "create" };
        const handle = await folder.getFileHandle(name, { create: true });
        // The native marker is empty; creating it is the complete setup write.
        if (size === 0) continue;
        self.__seedStage.step = "fetch";
        const response = await fetch(`${origin}/${encodeURIComponent(dictionary.title)}/${encodeURIComponent(name)}`);
        if (!response.ok) throw new Error(`fixture download ${response.status}`);
        self.__seedStage.step = "body";
        const bytes = new Uint8Array(await response.arrayBuffer());
        self.__seedStage.step = "open";
        const writable = await handle.createWritable();
        self.__seedStage.step = "write";
        await writable.write(bytes);
        self.__seedStage.step = "close";
        await writable.close();
      }
    }
    self.postMessage({ ok: true });
  } catch (error) { self.postMessage({ ok: false, error: String(error) }); }
};
