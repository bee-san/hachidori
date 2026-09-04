/*
 * Trusted starter dictionaries shared by Settings and the engine worker.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

(() => {
  const entries = [
    {
      sourceId: "jitendex",
      name: "Jitendex",
      description: "Japanese–English terms",
      publisherUrl: "https://jitendex.org/",
      downloadUrl:
        "https://github.com/stephenmk/stephenmk.github.io/releases/latest/download/jitendex-yomitan.zip",
      indexUrl: "https://jitendex.org/static/yomitan.json",
      archiveName: "jitendex-yomitan.zip",
      githubRepository: "stephenmk/stephenmk.github.io",
      githubRepositoryId: "744330420",
      titlePattern: "^Jitendex\\.org \\[\\d{4}-\\d{2}-\\d{2}\\]$",
      capabilities: ["term", "media"],
    },
    {
      sourceId: "jmnedict",
      name: "JMnedict for Yomitan",
      description: "Japanese proper names",
      publisherUrl: "https://github.com/yomidevs/jmdict-yomitan",
      downloadUrl:
        "https://github.com/yomidevs/jmdict-yomitan/releases/latest/download/JMnedict.zip",
      indexUrl:
        "https://github.com/yomidevs/jmdict-yomitan/releases/latest/download/JMnedict.json",
      archiveName: "JMnedict.zip",
      githubRepository: "yomidevs/jmdict-yomitan",
      githubRepositoryId: "696075636",
      titlePattern: "^JMnedict \\[\\d{4}-\\d{2}-\\d{2}\\]$",
      capabilities: ["term"],
    },
    {
      sourceId: "bees-ultimate-kanji-dictionary",
      name: "Bee's Ultimate Kanji Dictionary",
      description: "Rich single-kanji definitions",
      publisherUrl: "https://github.com/bee-san/bees-ultimate-kanji-dictionary",
      downloadUrl:
        "https://github.com/bee-san/bees-ultimate-kanji-dictionary/releases/latest/download/bees-ultimate-kanji-dictionary.zip",
      indexUrl:
        "https://raw.githubusercontent.com/bee-san/bees-ultimate-kanji-dictionary/main/dist/index.json",
      archiveName: "bees-ultimate-kanji-dictionary.zip",
      githubRepository: "bee-san/bees-ultimate-kanji-dictionary",
      githubRepositoryId: "1335822804",
      titlePattern: "^Bee's Ultimate Kanji Dictionary$",
      capabilities: ["term", "freq", "media"],
    },
    {
      sourceId: "jiten",
      name: "Jiten Frequency Dictionary",
      description: "Global word frequency ranks",
      publisherUrl: "https://jiten.moe/frequency-dictionaries",
      downloadUrl:
        "https://api.jiten.moe/api/frequency-list/download?downloadType=yomitan",
      indexUrl: "https://api.jiten.moe/api/frequency-list/index",
      archiveName: "jiten-frequency.zip",
      githubRepository: null,
      githubRepositoryId: null,
      titlePattern: "^Jiten$",
      capabilities: ["freq"],
    },
  ].map((entry) => Object.freeze({
    ...entry,
    capabilities: Object.freeze(entry.capabilities),
  }));

  Object.defineProperty(globalThis, "HD_RECOMMENDED_DICTIONARIES", {
    value: Object.freeze(entries),
    writable: false,
    configurable: false,
  });
})();
