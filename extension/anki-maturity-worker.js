// SPDX-License-Identifier: GPL-3.0-or-later
import { createAnkiGateway } from "./anki.js";
import { fetchAnkiMatureWords } from "./anki-maturity.js";

self.onmessage = async ({ data: source }) => {
  try {
    self.postMessage({ words: await fetchAnkiMatureWords(createAnkiGateway(), source) });
  } catch (error) {
    self.postMessage({ error: error.message || String(error) });
  }
};
