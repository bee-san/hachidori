import { createAnkiConnectClient } from "./anki-connect.js";
import { normaliseAnkiConfig } from "./anki-config.js";

/*
 * Service worker for Hachidori.
 *
 * The worker holds no engine state: it only guarantees that the offscreen
 * document exists and relays requests to it. The engine lives in the offscreen
 * document because a service worker is torn down after 30 s idle, which would
 * throw away the loaded dictionaries.
 *
 * It does own one thing on the engine's behalf: the `dictionaries` key in
 * chrome.storage.local. An offscreen document is granted chrome.runtime and
 * nothing else -- no chrome.storage -- so every read and write the engine needs
 * arrives here as a message.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

const OFFSCREEN_DOCUMENT = "offscreen.html";
const TARGET = "hoshidicts-offscreen";

// Requests the worker answers itself. A second target is what keeps them out of
// the relay below: a message from the offscreen document carrying TARGET is
// indistinguishable from one sent by an extension page, so it would be stamped
// `relayed` and handed straight back to the offscreen document, where the
// engine's own request queue would then wait on itself.
const WORKER_TARGET = "hoshidicts-worker";
const ANKI_CONFIG_KEY = "ankiConfig";
const ankiConnect = createAnkiConnectClient();

const DICTIONARIES_KEY = "dictionaries";

// A relayed request can arrive in the window between createDocument() resolving
// and offscreen.js running its module body, where nothing is listening yet.
const RELAY_ATTEMPTS = 5;
const RELAY_BACKOFF_MS = 40;
const NOT_LISTENING = /Receiving end does not exist|Could not establish connection/i;

let creating = null;

function describe(error) {
  if (error instanceof Error) {
    return error.message || String(error);
  }
  return typeof error === "string" ? error : JSON.stringify(error);
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function offscreenExists() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOCUMENT)],
  });
  return contexts.length > 0;
}

async function createOffscreen() {
  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT,
      reasons: ["DOM_SCRAPING"],
      justification:
        "Runs the WebAssembly dictionary engine and parses imported Yomitan archives in a DOM context that outlives the service worker.",
    });
  } catch (error) {
    // Another extension context may have won the race; only a genuine absence
    // is a failure.
    if (!(await offscreenExists())) {
      throw error;
    }
  } finally {
    creating = null;
  }
}

// createDocument() rejects when called while another call is in flight, so every
// caller waits on the same promise.
async function ensureOffscreen() {
  if (await offscreenExists()) {
    return;
  }
  if (creating === null) {
    creating = createOffscreen();
  }
  await creating;
}

async function relay(message) {
  let failure = null;
  for (let attempt = 0; attempt < RELAY_ATTEMPTS; attempt += 1) {
    await ensureOffscreen();
    try {
      // `relayed` is what lets offscreen.js ignore the copy of this message that
      // chrome.runtime.sendMessage also delivers to it directly, so a request
      // from an extension page runs on the engine exactly once.
      const reply = await chrome.runtime.sendMessage({ ...message, relayed: true });
      if (reply !== undefined) {
        return reply;
      }
      failure = new Error("offscreen document sent no reply");
    } catch (error) {
      if (!NOT_LISTENING.test(describe(error))) {
        throw error;
      }
      failure = error;
    }
    await sleep(RELAY_BACKOFF_MS * (attempt + 1));
  }
  throw failure ?? new Error("offscreen document unreachable");
}

async function readDictionaries() {
  const stored = await chrome.storage.local.get(DICTIONARIES_KEY);
  return Array.isArray(stored?.[DICTIONARIES_KEY]) ? stored[DICTIONARIES_KEY] : [];
}

// The engine reads this key, changes it, and sends it back a message round trip
// later. Another context can write in between -- the settings page writes it
// directly -- and a blind set would drop that change, so a caller that read the
// key first sends what it read and the write is refused if it no longer matches.
const WORKER_HANDLERS = {
  async hd_dicts_read() {
    return { dictionaries: await readDictionaries() };
  },

  async hd_dicts_write(message) {
    if (!Array.isArray(message?.dictionaries)) {
      throw new Error("the dictionary write request carried no list");
    }
    if (message.base !== undefined) {
      const current = await readDictionaries();
      if (JSON.stringify(message.base) !== JSON.stringify(current)) {
        return {
          ok: false,
          conflict: true,
          error: "the dictionary list changed while it was being written",
          dictionaries: current,
        };
      }
    }
    await chrome.storage.local.set({ [DICTIONARIES_KEY]: message.dictionaries });
    return {};
  },

  async hd_anki_config_read() {
    const stored = await chrome.storage.local.get(ANKI_CONFIG_KEY);
    return { config: normaliseAnkiConfig(stored[ANKI_CONFIG_KEY]) };
  },

  async hd_anki_config_write(message) {
    const config = normaliseAnkiConfig(message?.config);
    await chrome.storage.local.set({ [ANKI_CONFIG_KEY]: config });
    return { config };
  },

  async hd_anki_discover(message) {
    const config = normaliseAnkiConfig(message?.config);
    if (!config.url) throw new Error("Enter a valid HTTP or HTTPS AnkiConnect URL.");
    return { discovery: await ankiConnect.discover(config) };
  },
};

// One read-then-write at a time, so the check above cannot be overtaken by
// another worker-mediated write between its get and its set.
let storageTail = Promise.resolve();

function serialiseStorage(job) {
  const run = storageTail.then(job, job);
  storageTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function failureReply(message, error) {
  return {
    type: `${message?.type ?? "hd_unknown"}_result`,
    requestId: message?.requestId ?? null,
    ok: false,
    error: describe(error),
    generation: 0,
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target !== TARGET || message.relayed === true) {
    return false;
  }
  relay(message).then(sendResponse, (error) => {
    sendResponse(failureReply(message, error));
  });
  return true;
});

// Never relay(): a WORKER_TARGET request must be answered here, or the engine's
// storage reads would re-enter the offscreen document.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target !== WORKER_TARGET) {
    return false;
  }
  const type = typeof message.type === "string" ? message.type : "";
  if (!Object.prototype.hasOwnProperty.call(WORKER_HANDLERS, type)) {
    sendResponse(failureReply(message, new Error(`unknown worker request type ${JSON.stringify(type)}`)));
    return false;
  }
  serialiseStorage(() => WORKER_HANDLERS[type](message)).then(
    (result) => {
      const { ok = true, error = null, ...payload } = result ?? {};
      sendResponse({ type: `${type}_result`, requestId: message.requestId ?? null, ok, error, ...payload });
    },
    (error) => {
      sendResponse(failureReply(message, error));
    },
  );
  return true;
});

function warmUp() {
  ensureOffscreen().catch((error) => {
    console.error("hoshidicts: could not create the offscreen document:", describe(error));
  });
}

// Load the dictionaries before the first hover asks for them.
chrome.runtime.onInstalled.addListener(warmUp);
chrome.runtime.onStartup.addListener(warmUp);
