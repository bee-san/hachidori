// SPDX-License-Identifier: GPL-3.0-or-later
import { ankiAvailability } from "./anki.js";
import { ankiFieldNames, applyAnkiPreset, resolveAnkiTemplates } from "./anki-templates.js";

export function createAnkiSettingsController({ document, readConfig, editConfig, send }) {
  const { ANKI_FIELDS, ANKI_OVERWRITE_MODES } = document.defaultView.HDReaderOptions;
  const element = id => document.getElementById(id);
  const selects = new WeakMap();
  let discovery = null;
  let requestSequence = 0;
  let requestedKey = null;
  let loading = false;
  const templateRows = new Map();
  let nextTemplateId = 0;
  const connectionKey = config => JSON.stringify([config.model, config.apiKey]);

  function change(patch) {
    editConfig({ ...readConfig(), ...patch });
    render();
  }

  function currentFields() {
    return discovery?.model === readConfig().model ? discovery.fields : [];
  }

  function materializeTemplates() {
    const config = readConfig();
    const resolved = resolveAnkiTemplates(config, currentFields());
    return Object.fromEntries([...Object.entries(resolved.templates),
      ...resolved.staleFields.map(field => [field, { ...config.fieldTemplates[field] }])]);
  }

  function editTemplate(field, patch) {
    const templates = materializeTemplates();
    templates[field] = { ...templates[field], ...patch };
    change({ fieldTemplates: templates });
  }

  function createTemplateRow(field) {
    const row = document.createElement("div");
    row.className = "anki-template-row";
    row.innerHTML = `<div class="anki-template-heading"><label class="field-label"></label><button type="button" class="ghost">Remove unavailable field</button></div>
      <textarea rows="2" spellcheck="false" placeholder="Blank disables this field"></textarea>
      <label class="anki-template-mode"><span>On overwrite</span><select></select></label>`;
    const label = row.querySelector(".field-label"), editor = row.querySelector("textarea"), mode = row.querySelector("select");
    editor.id = `opt-anki-template-${++nextTemplateId}`;
    label.htmlFor = editor.id;
    label.textContent = field;
    mode.id = `${editor.id}-mode`;
    mode.setAttribute("aria-label", `On overwrite: ${field}`);
    const names = { coalesce: "Keep existing, fill empty", "coalesce-new": "Use new, keep if empty", skip: "Keep existing",
      append: "Append", prepend: "Prepend", overwrite: "Replace" };
    for (const value of ANKI_OVERWRITE_MODES) mode.add(new document.defaultView.Option(names[value], value));
    const remove = row.querySelector("button");
    const record = { field, row, label, editor, mode, remove };
    editor.addEventListener("input", () => editTemplate(record.field, { value: editor.value }));
    mode.addEventListener("change", () => editTemplate(record.field, { overwriteMode: mode.value }));
    remove.addEventListener("click", () => {
      const templates = materializeTemplates();
      delete templates[record.field];
      change({ fieldTemplates: templates });
      element("opt-anki-advanced").focus();
    });
    return record;
  }

  function renderTemplates(config) {
    const resolved = resolveAnkiTemplates(config, currentFields());
    const templates = [...Object.entries(resolved.templates),
      ...resolved.staleFields.map(field => [field, config.fieldTemplates[field]])];
    const retained = new Set(templates.map(([field]) => field));
    const advanced = config.fieldTemplates !== null;
    const renamedRows = new Map([...templateRows].filter(([field]) => !retained.has(field))
      .map(([field, row]) => [field.toLowerCase(), row]));
    const container = element("anki-templates");
    let index = 0;
    for (const [field, template] of templates) {
      if (!templateRows.has(field)) {
        const previous = renamedRows.get(field.toLowerCase());
        if (previous) {
          templateRows.delete(previous.field);
          renamedRows.delete(field.toLowerCase());
          previous.field = field;
          previous.label.textContent = field;
          previous.mode.setAttribute("aria-label", `On overwrite: ${field}`);
        }
        templateRows.set(field, previous || createTemplateRow(field));
      }
      const row = templateRows.get(field);
      if (row.editor !== document.activeElement && row.editor.value !== template.value) row.editor.value = template.value;
      if (row.mode !== document.activeElement && row.mode.value !== template.overwriteMode) row.mode.value = template.overwriteMode;
      if (row.editor.readOnly === advanced) row.editor.readOnly = !advanced;
      if (row.mode.disabled === advanced) row.mode.disabled = !advanced;
      const unavailable = resolved.staleFields.includes(field);
      if (row.remove.hidden === unavailable) row.remove.hidden = !unavailable;
      if (container.children[index] !== row.row) container.insertBefore(row.row, container.children[index] || null);
      index += 1;
    }
    for (const [field, row] of templateRows) {
      if (!retained.has(field)) { row.row.remove(); templateRows.delete(field); }
    }
    if (element("anki-fields").hidden !== advanced) element("anki-fields").hidden = advanced;
    element("opt-anki-advanced").checked = advanced;
    const canApply = !loading && currentFields().length > 0;
    if (element("anki-apply-preset").disabled === canApply) element("anki-apply-preset").disabled = !canApply;
  }

  function selectChoices(id, names, value, placeholder, canonical = "") {
    const select = element(id);
    if (select === document.activeElement) return;
    const key = JSON.stringify([names, value, canonical]);
    if (selects.get(select) === key) return;
    const choices = [["", placeholder], ...names.filter(name => name !== canonical || name === value).map(name => [name, name])];
    if (value && !names.includes(value)) choices.push([value, canonical || `${value} (unavailable)`]);
    select.replaceChildren(...choices.map(([name, label]) => new document.defaultView.Option(label, name)));
    select.value = value;
    selects.set(select, key);
  }

  function renderStatus(config) {
    const status = element("anki-status");
    const errors = ankiAvailability(config, discovery);
    let state = "Not connected";
    if (discovery?.connected) state = errors.length ? "Connected · configuration needs attention" : "Connected · configuration ready";
    const message = loading ? "Checking AnkiConnect…" : [state, ...errors].join("\n");
    if (status.textContent !== message) status.textContent = message;
    const invalid = !loading && errors.length > 0;
    if (status.classList.contains("is-error") !== invalid) status.classList.toggle("is-error", invalid);
    if (element("anki-refresh").disabled !== loading) element("anki-refresh").disabled = loading;
  }

  async function refresh() {
    const config = readConfig();
    const key = connectionKey(config);
    requestedKey = key;
    const sequence = ++requestSequence;
    loading = true;
    renderStatus(config);
    element("anki-apply-preset").disabled = true;
    try {
      const reply = await send("hd_anki_discover", { model: config.model, apiKey: config.apiKey });
      if (sequence !== requestSequence || key !== connectionKey(readConfig())) return;
      if (!reply.ok) throw new Error(reply.error);
      discovery = reply;
    } catch (error) {
      if (sequence !== requestSequence || key !== connectionKey(readConfig())) return;
      discovery = { connected: false, model: config.model, decks: [], models: [], fields: [], errors: [error.message] };
    } finally {
      if (sequence === requestSequence && key === connectionKey(readConfig())) {
        loading = false;
        render();
      }
    }
  }

  const controls = [
    ["tags", "opt-anki-tags"], ["apiKey", "opt-anki-api-key"],
    ["duplicateScope", "opt-anki-duplicate-scope"], ["duplicateBehavior", "opt-anki-duplicate-behavior"],
    ["checkForDuplicates", "opt-anki-check-duplicates"], ["duplicateScopeCheckAllModels", "opt-anki-check-all-models"],
  ];
  function render() {
    const config = readConfig();
    selectChoices("opt-anki-deck", discovery?.decks || [], config.deck, "Choose a deck");
    selectChoices("opt-anki-model", discovery?.models || [], config.model, "Choose a note type");
    const fields = discovery?.model === config.model ? discovery.fields : [];
    const fieldNames = ankiFieldNames(fields);
    for (const key of ANKI_FIELDS) selectChoices(`opt-anki-field-${key}`, fields, config.fields[key], "Disabled",
      fieldNames.get(config.fields[key].toLowerCase()));
    for (const [key, id] of controls) {
      const control = element(id);
      if (control === document.activeElement) continue;
      if (control.type === "checkbox") control.checked = config[key];
      else control.value = key === "tags" ? config.tags.join(" ") : config[key];
    }
    for (const id of ["opt-anki-duplicate-scope", "opt-anki-duplicate-behavior", "opt-anki-check-all-models"]) {
      const control = element(id);
      if (control.disabled === config.checkForDuplicates) control.disabled = !config.checkForDuplicates;
    }
    renderStatus(config);
    renderTemplates(config);
    if (connectionKey(config) !== requestedKey) void refresh();
  }

  for (const key of ANKI_FIELDS) {
    const label = document.createElement("label");
    label.className = "field";
    const text = document.createElement("span");
    text.className = "field-label";
    text.textContent = key[0].toUpperCase() + key.slice(1);
    const select = document.createElement("select");
    select.id = `opt-anki-field-${key}`;
    select.addEventListener("change", () => change({ fields: { ...readConfig().fields, [key]: select.value } }));
    label.append(text, select);
    element("anki-fields").append(label);
  }
  element("opt-anki-deck").addEventListener("change", event => change({ deck: event.target.value }));
  element("opt-anki-model").addEventListener("change", event => {
    if (event.target.value !== readConfig().model) change({ model: event.target.value,
      fields: Object.fromEntries(ANKI_FIELDS.map(key => [key, ""])), fieldTemplates: null });
  });
  for (const [key, id] of controls) {
    element(id).addEventListener("change", event => {
      const value = event.target.type === "checkbox" ? event.target.checked : event.target.value;
      change({ [key]: key === "tags" ? value.split(/\s+/u).filter(Boolean) : value });
    });
  }
  element("anki").addEventListener("focusout", () => queueMicrotask(render));
  element("anki-refresh").addEventListener("click", () => { void refresh(); });
  element("anki-apply-preset").addEventListener("click", () => {
    editConfig(applyAnkiPreset(readConfig(), currentFields(), element("anki-preset").value));
    render();
  });
  element("opt-anki-advanced").addEventListener("change", event => {
    change({ fieldTemplates: event.target.checked ? materializeTemplates() : null });
  });
  return { render, refresh };
}
