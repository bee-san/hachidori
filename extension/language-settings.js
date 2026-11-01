// SPDX-License-Identifier: GPL-3.0-or-later
//
// The settings a language pack defines (docs/languages.md 7.5), rendered from
// the pack's schema as experimental-settings.js renders its flags: Reading →
// {Language} options for `group: "lookup"` and Design → {Language} display for
// `group: "display"`. A display setting shows only while the selected theme
// declares that it renders `presentation` (section 11.3). Settings imports
// this module only once the edited profile's pack declares settings.

const GROUPS = {
  lookup: { id: "language-lookup-settings", legend: name => `${name} options`,
    place: document => document.getElementById("opt-japanese-only").closest("fieldset") },
  display: { id: "language-display-settings", legend: name => `${name} display`,
    place: document => document.querySelector("#design .design-controls > fieldset:not(#theme-store)") },
};

function settingValue(setting, values) {
  return globalThis.HDReaderOptions.packSettingValue({ settings: [setting] }, values, setting.id);
}

function controlFor(document, setting, value, onChange) {
  const id = `opt-pack-${setting.id}`;
  const describedBy = typeof setting.description === "string" && setting.description !== "" ? `${id}-help` : "";
  let row;
  let control;
  if (setting.type === "boolean") {
    row = document.createElement("label");
    row.className = "lookup-enable";
    const label = document.createElement("span");
    label.textContent = setting.label;
    control = document.createElement("input");
    control.type = "checkbox";
    row.append(label, control);
    control.addEventListener("change", () => onChange(setting.id, control.checked));
  } else {
    row = document.createElement("label");
    row.className = "field";
    const label = document.createElement("span");
    label.className = "field-label";
    label.textContent = setting.label;
    if (setting.type === "enum") {
      control = document.createElement("select");
      for (const choice of setting.values ?? []) control.add(new Option(choice.label ?? choice.id, choice.id));
      control.addEventListener("change", () => onChange(setting.id, control.value));
    } else {
      control = document.createElement("input");
      control.type = "number";
      for (const key of ["min", "max", "step"]) {
        if (typeof setting[key] === "number") control[key] = String(setting[key]);
      }
      control.addEventListener("change", () => {
        const number = Number(control.value);
        if (control.value !== "" && Number.isFinite(number)) onChange(setting.id, number);
      });
    }
    row.append(label, control);
  }
  control.id = id;
  if (describedBy) control.setAttribute("aria-describedby", describedBy);
  const nodes = [row];
  if (describedBy) {
    const hint = document.createElement("p");
    hint.className = "field-hint";
    hint.id = describedBy;
    hint.textContent = setting.description;
    nodes.push(hint);
  }
  setValue(document, control, setting, value);
  return { nodes, control };
}

function setValue(document, control, setting, value) {
  if (control === document.activeElement) return;
  if (setting.type === "boolean") {
    if (control.checked !== (value === true)) control.checked = value === true;
  } else if (control.value !== String(value)) control.value = String(value);
}

// Builds, updates or removes the two fieldsets for `descriptor` (null: none).
export function renderLanguageSettings({ document, descriptor, name, values, presentation, onChange }) {
  const settings = Array.isArray(descriptor?.settings) ? descriptor.settings : [];
  for (const [group, { id, legend, place }] of Object.entries(GROUPS)) {
    const own = settings.filter(setting => setting?.group === group && typeof setting.id === "string");
    let fieldset = document.getElementById(id);
    const key = JSON.stringify([descriptor?.code ?? null, own.map(setting => setting.id)]);
    if (own.length === 0) {
      fieldset?.remove();
      continue;
    }
    if (fieldset === null || fieldset.dataset.languageSettings !== key) {
      fieldset?.remove();
      fieldset = document.createElement("fieldset");
      fieldset.className = "lookup-group";
      fieldset.id = id;
      fieldset.dataset.languageSettings = key;
      // theme-store.js shows the display group only for themes that render
      // presentation, as this module does below.
      fieldset.dataset.packSettingsGroup = group;
      const caption = document.createElement("legend");
      fieldset.append(caption);
      for (const setting of own) {
        const { nodes } = controlFor(document, setting, settingValue(setting, values), onChange);
        const wrapper = document.createElement("div");
        wrapper.className = "language-setting";
        wrapper.dataset.packSetting = setting.id;
        wrapper.append(...nodes);
        fieldset.append(wrapper);
      }
      place(document).after(fieldset);
    }
    fieldset.querySelector("legend").textContent = legend(name);
    for (const setting of own) {
      const control = document.getElementById(`opt-pack-${setting.id}`);
      setValue(document, control, setting, settingValue(setting, values));
    }
    // A theme that does not declare presentation shows the stored headword,
    // so the pack's display settings would change nothing (section 11.4).
    if (group === "display") fieldset.hidden = !presentation;
  }
}
