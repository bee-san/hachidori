// SPDX-License-Identifier: GPL-3.0-or-later
import { ankiAvailability, ankiFieldNames } from "./anki.js";

export function createAnkiSettingsController({ document, readConfig, editConfig, send }) {
  const { ANKI_FIELDS } = document.defaultView.HDReaderOptions;
  const element = id => document.getElementById(id);
  const selects = new WeakMap();
  let discovery = null;
  let requestSequence = 0;
  let requestedKey = null;
  let loading = false;
  const connectionKey = config => JSON.stringify([config.model, config.apiKey]);

  function change(patch) {
    editConfig({ ...readConfig(), ...patch });
    render();
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
    const message = loading ? "Checking AnkiConnect…" : [discovery?.connected
      ? errors.length ? "Connected · configuration needs attention" : "Connected · configuration ready"
      : "Not connected", ...errors].join("\n");
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
      fields: Object.fromEntries(ANKI_FIELDS.map(key => [key, ""])) });
  });
  for (const [key, id] of controls) {
    element(id).addEventListener("change", event => {
      const value = event.target.type === "checkbox" ? event.target.checked : event.target.value;
      change({ [key]: key === "tags" ? value.split(/\s+/u).filter(Boolean) : value });
    });
  }
  element("anki").addEventListener("focusout", () => queueMicrotask(render));
  element("anki-refresh").addEventListener("click", () => { void refresh(); });
  return { render, refresh };
}
