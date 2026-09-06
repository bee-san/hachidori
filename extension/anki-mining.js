// SPDX-License-Identifier: GPL-3.0-or-later
import { ankiAvailability } from "./anki.js";
import { resolveAnkiTemplates } from "./anki-templates.js";
import { ankiBrowseQuery, ankiNoteOptions, checkAnkiDuplicate, findAnkiOverwriteTarget,
  isAnkiDuplicateError, overwriteAnkiFields } from "./anki-duplicates.js";

const CONFIG_CHANGED = "Anki configuration changed. Refresh this result before adding a note.";

function fieldsForExistingNote(note, templates, existing) {
  const names = new Map(Object.keys(existing).map(name => [name.toLowerCase(), name]));
  const canonicalTemplates = [], incoming = [];
  for (const [field, template] of Object.entries(templates)) {
    const name = Object.hasOwn(existing, field) ? field : names.get(field.toLowerCase());
    if (name === undefined) throw new Error("Anki model fields changed. Refresh before overwriting this note.");
    canonicalTemplates.push([name, template]);
    incoming.push([name, note.fields[field]]);
  }
  return overwriteAnkiFields(Object.fromEntries(incoming), existing, Object.fromEntries(canonicalTemplates));
}

export function createAnkiMiningService({ gateway, readConfig, buildFields, enrich, now = Date.now }) {
  let cached = null;
  let mutations = Promise.resolve();
  const invokeFor = config => (action, params, timeoutMs) => gateway.invoke(action, params, config.apiKey, timeoutMs);

  async function configuration(fresh = false) {
    const config = await readConfig();
    const configKey = JSON.stringify(config);
    if (!fresh && cached?.key === configKey && now() < cached.expires) return cached.promise;
    const promise = (async () => {
      if (!config.model) return { config, configKey, errors: ["Choose an Anki note type in Settings."] };
      const discovery = await gateway.discover(config);
      const resolved = resolveAnkiTemplates(config, discovery.fields);
      return { config, configKey, discovery, resolved, errors: ankiAvailability(config, discovery, resolved) };
    })();
    // GSM's two-second status cache, sharing concurrent callers as well. Only
    // read-only preparation may use it; each submission refreshes discovery.
    cached = { key: configKey, expires: now() + 2000, promise };
    return promise;
  }

  async function status() {
    const current = await configuration();
    return { available: current.errors.length === 0, configKey: current.configKey, error: current.errors.join("\n") };
  }

  async function prepare(request, fresh) {
    const current = await configuration(fresh);
    if (request.configKey !== current.configKey) throw new Error(CONFIG_CHANGED);
    if (current.errors.length) throw new Error(current.errors.join("\n"));
    const fields = await buildFields(request, current);
    const firstField = current.discovery.fields[0];
    if (!fields[firstField]?.trim()) throw new Error(`The first Anki field, “${firstField}”, is empty for this result.`);
    const note = { deckName: current.config.deck, modelName: current.config.model, fields,
      options: ankiNoteOptions(current.config), tags: [...new Set(current.config.tags)] };
    return { ...current, note, firstField, invoke: invokeFor(current.config) };
  }

  async function decision(prepared) {
    const { invoke, note, config, firstField } = prepared;
    const check = await checkAnkiDuplicate(invoke, note, config);
    if (!check.duplicate) return { state: check.addable ? "addable" : "invalid", canAdd: check.addable, error: check.error };
    if (config.duplicateBehavior === "overwrite") {
      const target = await findAnkiOverwriteTarget(invoke, note, firstField, config);
      return { state: "duplicate", canAdd: target !== null, action: "overwrite", target,
        error: target ? null : "A duplicate exists, but no matching note type is inside the selected deck scope." };
    }
    return { state: "duplicate", canAdd: config.duplicateBehavior === "new", error: null };
  }

  async function preflight(request) {
    const result = await decision(await prepare(request, false));
    return { state: result.state, canAdd: result.canAdd, error: result.error, action: result.action };
  }

  async function verifyFields(invoke, noteId, expected) {
    const infos = await invoke("notesInfo", { notes: [noteId] });
    const info = Array.isArray(infos) ? infos.find(value => value.noteId === noteId) : null;
    for (const [field, value] of Object.entries(expected)) {
      const actual = info?.fields?.[field]?.value;
      if (typeof actual !== "string" || actual.normalize("NFC") !== value.normalize("NFC")) {
        throw new Error("Anki's saved fields differ from the submitted values. Inspect the note in Anki.");
      }
    }
  }

  async function write(request) {
    const prepared = await prepare(request, true);
    const checked = await decision(prepared);
    if (!checked.canAdd) return { state: checked.state, error: checked.error };
    const { configKey, note, resolved, invoke } = prepared;
    const target = checked.target;
    const fields = target ? fieldsForExistingNote(note, resolved.templates, target.fields) : note.fields;
    if (JSON.stringify(await readConfig()) !== configKey) throw new Error(CONFIG_CHANGED);
    let noteId;
    try {
      if (target) {
        const reply = await invoke("updateNoteFields", { note: { id: target.noteId, fields } }, 10_000);
        if (reply !== null) throw new Error("Anki returned an invalid field-update acknowledgement.");
        noteId = target.noteId;
      } else {
        noteId = await invoke("addNote", { note }, 10_000);
      }
      if (!Number.isSafeInteger(noteId) || noteId <= 0) throw new Error("Anki did not return a valid note ID.");
    } catch (error) {
      if (isAnkiDuplicateError(error.message)) return { state: "duplicate", error: "This note already exists in Anki." };
      // A lost acknowledgement may follow a completed write. Neither this
      // worker nor the reader retries it automatically, including append modes.
      return { state: "uncertain", error: `The write could not be confirmed. Use View in Anki before trying again. ${error.message}` };
    }
    const warnings = [];
    try {
      await verifyFields(invoke, noteId, fields);
      warnings.push(...await enrich({ request, ...prepared, noteId, existingFields: target?.fields, appliedFields: fields }));
    } catch (error) { warnings.push(error.message); }
    cached = null;
    return { state: target ? "updated" : "added", noteId, warnings };
  }

  function submit(request) {
    const operation = mutations.then(() => write(request));
    mutations = operation.catch(() => {});
    return operation;
  }

  async function browse(expression) {
    const config = await readConfig();
    await invokeFor(config)("guiBrowse", { query: ankiBrowseQuery(expression) });
    return { opened: true };
  }

  return { status, preflight, submit, browse };
}
