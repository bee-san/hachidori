// SPDX-License-Identifier: GPL-3.0-or-later

export function createAnkiConnectClient({ fetch = globalThis.fetch, timeoutMs = 1250 } = {}) {
  let mining = Promise.resolve();
  function escapeQueryValue(value) {
    let escaped = String(value).replaceAll("\\", "\\\\");
    for (const character of ['"', "*", "_", ":"]) escaped = escaped.replaceAll(character, `\\${character}`);
    return escaped;
  }
  async function invoke(action, params, config) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(config.url, {
        method: "POST",
        credentials: "omit",
        redirect: "error",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          action,
          version: 6,
          params,
          ...(config.apiKey ? { key: config.apiKey } : {}),
        }),
      });
      if (!response.ok) throw new Error(`AnkiConnect returned HTTP ${response.status}.`);
      const payload = await response.json();
      if (!payload || Object.keys(payload).length !== 2 || !Object.hasOwn(payload, "result")
          || !Object.hasOwn(payload, "error") || (payload.error !== null && typeof payload.error !== "string")) {
        throw new Error("AnkiConnect returned an invalid response.");
      }
      if (payload.error !== null) throw new Error(`AnkiConnect: ${payload.error}`);
      return payload.result;
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error("AnkiConnect timed out. Check its URL, open Anki and retry.");
      }
      if (error instanceof SyntaxError) {
        throw new Error("AnkiConnect returned an invalid response.");
      }
      if (error instanceof Error && error.message.startsWith("AnkiConnect")) {
        throw error;
      }
      throw new Error("Open Anki with the AnkiConnect add-on installed, then retry.");
    } finally {
      clearTimeout(timer);
    }
  }

  async function discover(config) {
    const version = await invoke("version", {}, config);
    if (!Number.isInteger(version) || version < 6) throw new Error("AnkiConnect API version 6 is required.");
    async function names(action, params = {}) {
      const result = await invoke(action, params, config);
      if (!Array.isArray(result) || result.some(name => typeof name !== "string" || name.trim() === "")) {
        throw new Error(`AnkiConnect returned an invalid ${action} list.`);
      }
      return [...new Set(result)];
    }
    const decks = await names("deckNames");
    const models = await names("modelNames");
    const fields = config.model && models.includes(config.model)
      ? await names("modelFieldNames", { modelName: config.model })
      : [];
    return { version, decks, models, model: config.model, fields };
  }

  async function addNote(note, config) {
    const query = `"expression:${escapeQueryValue(note.expression)}"`;
    const matches = await invoke("findNotes", { query }, config);
    if (!Array.isArray(matches) || matches.some(noteId => !Number.isInteger(noteId))) {
      throw new Error("AnkiConnect returned an invalid findNotes list.");
    }
    if (matches.length > 0) return { added: false, noteId: matches[0] };
    const noteId = await invoke("addNote", {
      note: {
        deckName: config.deck,
        modelName: config.model,
        fields: {
          Expression: note.expression,
          Reading: note.reading,
          Sentence: note.sentence,
          Definition: note.definition,
        },
        options: { allowDuplicate: false },
        tags: ["hachidori"],
      },
    }, config);
    if (!Number.isInteger(noteId)) throw new Error("AnkiConnect returned an invalid note identifier.");
    return { added: true, noteId };
  }

  function add(note, config) {
    const operation = mining.then(() => addNote(note, config));
    mining = operation.catch(() => {});
    return operation;
  }

  async function view(noteId, config) {
    await invoke("guiBrowse", { query: `nid:${noteId}` }, config);
  }

  return { add, discover, invoke, view };
}
