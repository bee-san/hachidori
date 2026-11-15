// SPDX-License-Identifier: GPL-3.0-or-later
import "./external-links.js";
import { ankiTemplateErrors } from "./anki-templates.js";
import { KEYBIND_OPTION_LABELS } from "./keybind-settings.js";

const ICON_LABELS = {
  "book-search": "Book with magnifier", search: "Magnifier", open: "Open in new tab", add: "Plus",
  "document-add": "Card with plus", "speaker-2": "Speaker", checkmark: "Check mark", prohibited: "No entry",
  star: "Star", edit: "Pencil", "arrow-sync": "Arrows", key: "Key", settings: "Gear",
};

// The markers a Mine as kana button writes the reading for (#770).
const KANA_MARKERS = { expression: "reading", furigana: "reading", "furigana-plain": "reading" };

// More custom buttons' ready-made buttons: each fills the form, to change
// before Add button saves it.
const PRESETS = [
  { id: "view-notes", label: "View in Anki", button: { type: "action", label: "View in Anki", action: "viewNotes",
    argument: "", icon: "book-search" } },
  { id: "mine-kana", label: "Mine as kana", button: { type: "anki", label: "Mine as kana", markers: KANA_MARKERS } },
  { id: "jisho", label: "Search Jisho", button: { type: "link", label: "Jisho", url: "https://jisho.org/search/%w",
    icon: "search" } },
];

// "{from} → {to}" lines, the Other markers field's text, as a button's
// `markers`; null when blank, or the first line it cannot read.
export function parseMarkerLines(text) {
  const markers = {};
  for (const line of text.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const match = /^\s*\{([^{}]+)\}\s*(?:→|->|=>|=)\s*\{([^{}]+)\}\s*$/u.exec(line);
    if (!match) return { error: `Write each line as {marker} → {marker}: ${line.trim()}` };
    const [from, to] = [match[1].trim().toLowerCase(), match[2].trim().toLowerCase()];
    const unknown = [from, to].find(name => ankiTemplateErrors(`{${name}}`).length > 0);
    if (unknown !== undefined) return { error: `Unknown marker: {${unknown}}` };
    if (from !== to) markers[from] = to;
  }
  return { markers: Object.keys(markers).length ? markers : null };
}

export function formatMarkerLines(markers) {
  return Object.entries(markers ?? {}).map(([from, to]) => `{${from}} → {${to}}`).join("\n");
}

export function validateLinkButton(label, url) {
  if (!label || /[\u0000-\u001f\u007f]/u.test(label)) return "Enter a name for the button.";
  if (!globalThis.HDExternalLinks.expandCustomLinkUrl(url, { word: "word", reading: "reading", sentence: "sentence" })) {
    return "Enter an http:// or https:// URL. %w, %r and %s are supported.";
  }
  return "";
}

// Retained for callers that validate legacy custom-link drafts directly.
export const validateCustomLink = validateLinkButton;

export function createCustomButtonSettings({
  document,
  readButtons,
  saveButtons,
  readTemplates,
  // Settings → Advanced → Experimental features, for More custom buttons.
  readExperimental = () => ({}),
  readAudioSources = () => [],
  createId = () => document.defaultView.crypto.randomUUID(),
}) {
  const { BUTTON_ACTIONS, BUTTON_ICONS, KEYBIND_ARGUMENT_DEFAULTS, KEYBIND_TOGGLE_OPTIONS, AUDIO_SOURCE_LABELS,
    extendedCustomButton } = document.defaultView.HDReaderOptions ?? globalThis.HDReaderOptions;
  const list = document.getElementById("custom-button-list");
  const empty = document.getElementById("custom-button-empty");
  const form = document.getElementById("custom-button-form");
  const name = document.getElementById("opt-custom-button-name");
  const type = document.getElementById("opt-custom-button-type");
  const url = document.getElementById("opt-custom-button-url");
  const template = document.getElementById("opt-custom-button-template");
  const linkField = document.getElementById("custom-button-link-field");
  const ankiField = document.getElementById("custom-button-anki-field");
  const submit = document.getElementById("custom-button-submit");
  const cancel = document.getElementById("custom-button-cancel");
  const status = document.getElementById("custom-buttons-status");
  const markers = document.getElementById("opt-custom-button-markers");
  const markersField = document.getElementById("custom-button-markers-field");
  const actionSelect = document.getElementById("opt-custom-button-action");
  const actionField = document.getElementById("custom-button-action-field");
  const count = document.getElementById("opt-custom-button-count");
  const source = document.getElementById("opt-custom-button-source");
  const option = document.getElementById("opt-custom-button-option");
  const argumentFields = {
    count: document.getElementById("custom-button-count-field"),
    audioSource: document.getElementById("custom-button-source-field"),
    option: document.getElementById("custom-button-option-field"),
  };
  const scriptHelp = document.getElementById("custom-button-script-help");
  const icon = document.getElementById("opt-custom-button-icon");
  const iconField = document.getElementById("custom-button-icon-field");
  const presets = document.getElementById("custom-button-presets");
  const presetList = document.getElementById("custom-button-preset-list");
  const Option = document.defaultView.Option;
  let editing = null;
  let rendered = null;
  const extended = () => readExperimental()?.popupActions === true;
  const actionById = id => BUTTON_ACTIONS.find(action => action.id === id);

  for (const action of BUTTON_ACTIONS) actionSelect.add(new Option(action.label, action.id));
  option.add(new Option("Choose an option", ""));
  for (const key of KEYBIND_TOGGLE_OPTIONS) option.add(new Option(KEYBIND_OPTION_LABELS[key] ?? key, key));
  icon.add(new Option("None: show the name", ""));
  for (const name of BUTTON_ICONS) icon.add(new Option(ICON_LABELS[name] ?? name, name));
  for (const preset of PRESETS) {
    const node = document.createElement("button");
    node.type = "button";
    node.className = "ghost";
    node.dataset.preset = preset.id;
    node.textContent = preset.label;
    node.addEventListener("click", () => usePreset(preset));
    presetList.append(node);
  }

  const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  const templates = () => readTemplates().filter(value => value && typeof value.id === "string");
  const templateById = id => templates().find(value => value.id === id);

  function button(text, label, onClick, iconName) {
    const node = document.createElement("button");
    node.type = "button";
    node.className = "ghost";
    if (iconName) {
      const icon = document.createElement("span");
      icon.className = "hd-icon";
      icon.dataset.icon = iconName;
      icon.setAttribute("aria-hidden", "true");
      node.append(icon);
    } else {
      node.textContent = text;
    }
    node.setAttribute("aria-label", label);
    node.addEventListener("click", onClick);
    return node;
  }

  function focusRow(index, action) {
    const row = list.children[Math.min(index, list.children.length - 1)];
    (row?.querySelector(`[data-action="${action}"]:not(:disabled)`)
      ?? row?.querySelector("button:not(:disabled)") ?? name).focus();
  }

  function move(index, offset) {
    const buttons = readButtons().slice();
    [buttons[index], buttons[index + offset]] = [buttons[index + offset], buttons[index]];
    if (editing?.index === index) editing.index += offset;
    else if (editing?.index === index + offset) editing.index -= offset;
    saveButtons(buttons);
    render();
    focusRow(index + offset, offset < 0 ? "up" : "down");
  }

  function remove(index) {
    if (editing?.index === index) closeForm();
    else if (editing && editing.index > index) editing.index -= 1;
    saveButtons(readButtons().filter((_button, buttonIndex) => buttonIndex !== index));
    render();
    focusRow(index, "edit");
  }

  // The form shows a button: a saved one to edit, or a ready-made one to add.
  function fill(value) {
    name.value = value.label;
    type.value = value.type;
    url.value = value.type === "link" ? value.url : "";
    template.value = value.type === "anki" ? value.templateId ?? templates()[0]?.id ?? "" : "";
    markers.value = formatMarkerLines(value.markers);
    actionSelect.value = value.type === "action" ? value.action : BUTTON_ACTIONS[0].id;
    setArgument(value.type === "action" ? value.argument : undefined);
    icon.value = value.icon ?? "";
    status.textContent = "";
    updateForm();
  }

  function edit(index) {
    const value = readButtons()[index];
    editing = { index, button: value };
    fill(value);
    name.focus();
  }

  function usePreset(preset) {
    editing = null;
    fill(preset.button);
    name.focus();
  }

  // The action's argument editor, set to `value` or the action's default.
  function setArgument(value) {
    const kind = actionById(actionSelect.value)?.argument;
    const argument = value ?? (kind ? KEYBIND_ARGUMENT_DEFAULTS[kind] : "");
    count.value = kind === "count" ? argument : "1";
    renderSources(kind === "audioSource" ? argument : "");
    option.value = kind === "option" && KEYBIND_TOGGLE_OPTIONS.includes(argument) ? argument : "";
  }

  function renderSources(selected) {
    const sources = readAudioSources();
    source.replaceChildren(new Option("Choose a source", ""), ...sources.map((value, index) =>
      new Option(`${index + 1}. ${AUDIO_SOURCE_LABELS[value.type] ?? value.type}`, value.id)));
    if (selected && !sources.some(value => value.id === selected)) source.add(new Option("Removed source", selected));
    source.value = selected;
  }

  function argumentValue() {
    const kind = actionById(actionSelect.value)?.argument;
    if (kind === "count") return count.value.trim();
    if (kind === "audioSource") return source.value;
    if (kind === "option") return option.value;
    return "";
  }

  function createRow(value, index, count) {
    const row = document.createElement("li");
    row.className = "custom-button-row";
    const text = document.createElement("div");
    text.className = "custom-button-text";
    const label = document.createElement("strong");
    label.textContent = value.label;
    const summary = document.createElement("span");
    summary.className = "custom-button-summary";
    const kind = document.createElement("span");
    kind.className = "custom-button-kind";
    kind.textContent = { link: "Link", anki: "Anki", action: "Action", script: "User script" }[value.type];
    const detail = document.createElement(value.type === "link" ? "code" : "span");
    if (value.type === "link") detail.textContent = value.url;
    else if (value.type === "anki") {
      detail.textContent = templateById(value.templateId)?.name ?? "Template unavailable";
      if (value.markers) detail.textContent += ` · ${formatMarkerLines(value.markers).replaceAll("\n", ", ")}`;
    } else if (value.type === "action") detail.textContent = actionById(value.action)?.label ?? value.action;
    else detail.textContent = "hachidori-button";
    summary.append(kind, " · ", detail);
    // A button More custom buttons shows stays in the list while it is off,
    // hidden from the popup, and comes back when it is turned on.
    const off = extendedCustomButton(value) && !extended();
    const note = document.createElement("span");
    note.className = "field-hint";
    note.textContent = "Hidden: turn on More custom buttons in Advanced → Experimental features to show and edit it.";
    text.append(label, summary, ...(off ? [note] : []));
    const actions = document.createElement("div");
    actions.className = "custom-button-actions";
    const up = button("", `Move up: ${value.label}`, () => move(index, -1), "arrow-up");
    const down = button("", `Move down: ${value.label}`, () => move(index, 1), "arrow-down");
    up.dataset.action = "up";
    down.dataset.action = "down";
    up.disabled = index === 0;
    down.disabled = index === count - 1;
    const editButton = button("Edit", `Edit button ${value.label}`, () => edit(index));
    editButton.dataset.action = "edit";
    editButton.disabled = off;
    actions.append(up, down, editButton, button("Delete", `Delete button ${value.label}`, () => remove(index)));
    row.append(text, actions);
    return row;
  }

  function renderTemplateChoices() {
    const values = templates();
    const selected = template.value;
    const choices = values.map(value => new document.defaultView.Option(value.name, value.id));
    if (selected && !values.some(value => value.id === selected)) {
      choices.push(new document.defaultView.Option("Unavailable Template", selected));
    }
    template.replaceChildren(...choices);
    template.value = selected && choices.some(option => option.value === selected)
      ? selected : values[0]?.id ?? "";
  }

  function updateForm() {
    renderTemplateChoices();
    const more = extended();
    if (!more && !["link", "anki"].includes(type.value)) type.value = "link";
    for (const choice of type.options) {
      const offered = more || choice.value === "link" || choice.value === "anki";
      choice.hidden = !offered;
      choice.disabled = !offered;
    }
    presets.hidden = !more;
    const kind = type.value;
    linkField.hidden = kind !== "link";
    ankiField.hidden = kind !== "anki";
    markersField.hidden = kind !== "anki" || !more;
    actionField.hidden = kind !== "action";
    const argument = kind === "action" ? actionById(actionSelect.value)?.argument : undefined;
    for (const [name, field] of Object.entries(argumentFields)) field.hidden = argument !== name;
    scriptHelp.hidden = kind !== "script";
    iconField.hidden = !more;
    submit.textContent = editing ? "Save button" : "Add button";
    cancel.hidden = !editing;
  }

  function closeForm() {
    editing = null;
    name.value = url.value = markers.value = "";
    type.value = "link";
    template.value = templates()[0]?.id ?? "";
    actionSelect.value = BUTTON_ACTIONS[0].id;
    setArgument();
    icon.value = "";
    status.textContent = "";
    updateForm();
  }

  function render() {
    const buttons = readButtons();
    const key = JSON.stringify([buttons, templates().map(({ id, name: templateName }) => [id, templateName]), extended()]);
    if (key === rendered) return;
    rendered = key;
    list.replaceChildren(...buttons.map((value, index) => createRow(value, index, buttons.length)));
    empty.hidden = buttons.length > 0;
    updateForm();
  }

  function uniqueId() {
    const ids = new Set(readButtons().map(value => value.id));
    let id;
    do id = createId();
    while (typeof id !== "string" || id === "" || ids.has(id));
    return id;
  }

  // The button the form describes, with `error` set while it cannot be saved.
  function draft() {
    const base = {
      id: editing?.button.id ?? "",
      type: type.value,
      label: name.value.trim(),
    };
    let value;
    let error = "";
    if (type.value === "anki") {
      value = { ...base, templateId: template.value };
      const parsed = extended() ? parseMarkerLines(markers.value) : { markers: editing?.button.markers ?? null };
      if (parsed.error) error = parsed.error;
      else if (parsed.markers) value.markers = parsed.markers;
    } else if (type.value === "action") {
      value = { ...base, action: actionSelect.value, argument: argumentValue() };
    } else if (type.value === "script") {
      value = base;
    } else {
      value = { ...base, url: url.value.trim() };
    }
    const chosenIcon = extended() ? icon.value : editing?.button.icon ?? "";
    if (chosenIcon) value.icon = chosenIcon;
    return { value, error };
  }

  function draftError({ value, error }) {
    if (value.type === "link") return validateLinkButton(value.label, value.url);
    if (!value.label || /[\u0000-\u001f\u007f]/u.test(value.label)) return "Enter a name for the button.";
    if (value.type === "anki" && !templateById(value.templateId)) return "Choose an available Template.";
    if (value.type === "action") {
      const kind = actionById(value.action)?.argument;
      if (kind === "count" && !/^[1-9]\d*$/u.test(value.argument)) return "Enter a count of 1 or more.";
      if (kind === "audioSource" && !value.argument) return "Choose a pronunciation source.";
      if (kind === "option" && !value.argument) return "Choose an option.";
    }
    return error;
  }

  form.addEventListener("submit", event => {
    event.preventDefault();
    const described = draft();
    const { value } = described;
    const error = draftError(described);
    if (error) {
      status.textContent = error;
      return;
    }
    const buttons = readButtons().slice();
    if (editing && !same(buttons[editing.index], editing.button)) {
      status.textContent = "This button changed elsewhere. Cancel, then edit it again.";
      return;
    }
    if (editing) buttons[editing.index] = value;
    else buttons.push({ ...value, id: uniqueId() });
    saveButtons(buttons);
    closeForm();
    render();
    name.focus();
  });
  for (const input of [name, url, template, markers, count, source, option, icon]) {
    input.addEventListener("input", () => { status.textContent = ""; });
    input.addEventListener("change", () => { status.textContent = ""; });
  }
  type.addEventListener("change", () => {
    status.textContent = "";
    updateForm();
  });
  actionSelect.addEventListener("change", () => {
    status.textContent = "";
    setArgument();
    updateForm();
  });
  cancel.addEventListener("click", () => {
    closeForm();
    name.focus();
  });
  setArgument();
  updateForm();
  render();
  return {
    render,
    reset() { closeForm(); render(); },
    dirty: () => {
      const { value } = draft();
      if (!editing) return value.label !== "" || (value.type === "link" ? value.url !== "" : false);
      return !same(value, editing.button);
    },
  };
}
