// SPDX-License-Identifier: GPL-3.0-or-later
//
// Settings → Advanced → Languages → Language rules (docs/languages.md 8.1 and
// 16.3): ordered rules that choose a lookup's language by the website, a held
// key or the popup level. profile-settings.js shows the card with two or more
// languages; each edit writes every rule with hd_language_selection_write.

import { describeErrorOrJson } from "./error-text.js";

const { PROFILE_RULE_MODIFIERS, PROFILE_RULE_COMPARISONS } = globalThis.HDReaderOptions;

const CONDITION_TYPES = [
  ["domain", "Website domain"],
  ["url", "Address contains"],
  ["modifier", "Key held"],
  ["popupLevel", "Popup level"],
];
const MODIFIER_LABELS = { Shift: "Shift", Control: "Ctrl", Alt: "Alt", Meta: "Meta (⌘ or Windows key)" };
const COMPARISON_LABELS = { equal: "is", atLeast: "is at least", atMost: "is at most" };
const OTHER_ORDER_BUTTON = { up: "down", down: "up" };
const PLACEHOLDERS = { domain: "youtube.com, netflix.com", url: "example.com/manga/" };

function copyRules(rules) {
  return rules.map(rule => ({ ...rule, conditions: rule.conditions.map(condition => ({ ...condition })) }));
}

// A new condition of `type`, in the stored shape.
function newCondition(type) {
  if (type === "modifier") return { type, key: PROFILE_RULE_MODIFIERS[0] };
  if (type === "popupLevel") return { type, comparison: "atLeast", level: 1 };
  return { type, value: "" };
}

export function createProfileRules({ document, create, readSelection, profileList, optionLabel, writeRules, setStatus }) {
  const card = create("fieldset", { className: "lookup-group", id: "language-rules" });
  card.innerHTML = `<legend data-search-keywords="profile conditions website domain url modifier key popup level">Language rules</legend>
    <p class="field-hint" id="language-rules-help">In this browser, a lookup uses the language of the first rule whose
      conditions all match. Website domains match their subdomains too, Key held is checked as each word is scanned,
      and popup level 0 is the page, 1 the first popup. When no rule matches, the language is chosen as above.</p>
    <ol class="language-list language-rule-list" id="language-rules-list"></ol>
    <div class="options-actions"><button type="button" class="ghost" id="language-rules-add" aria-describedby="language-rules-help">Add a rule</button></div>`;
  const list = card.querySelector("#language-rules-list");
  const add = card.querySelector("#language-rules-add");
  let rules = [];
  let shown = null;
  let saving = Promise.resolve();
  // Saves not yet answered: until then the list shows the rules being saved.
  let pending = 0;

  function storedRules() {
    return readSelection().rules ?? [];
  }

  // What the list shows: the rules and the languages their menus offer.
  function shownKey() {
    return JSON.stringify([rules, profileList().map(profile => [profile.id, profile.language])]);
  }

  // Applies `change` to a copy of the rules, shows it with focus on `focus`
  // ({key, role}, see renderRules), and saves the result once earlier saves
  // have finished; a refused save shows the stored rules.
  function edit(change, focus = null) {
    const next = copyRules(rules);
    change(next);
    rules = next;
    renderRules(focus);
    pending += 1;
    saving = saving.then(() => writeRules(next)).then(() => setStatus(""), error => {
      setStatus(`Could not save the language rules: ${describeErrorOrJson(error)}`, "error", error);
      rules = copyRules(storedRules());
    }).finally(() => {
      pending -= 1;
      if (pending === 0) render();
    });
  }

  // Every control has a role, so a rebuild can focus the same control again.
  function select(entries, value, role, label, onChange) {
    const node = create("select", { "aria-label": label, "data-role": role });
    node.replaceChildren(...entries.map(([id, text]) => new Option(text, id)));
    node.value = value;
    node.addEventListener("change", () => onChange(node.value));
    return node;
  }

  function button(text, role, label, onClick, disabled = false) {
    const node = create("button", { type: "button", className: "ghost", text, "aria-label": label, "data-role": role });
    node.disabled = disabled;
    node.addEventListener("click", onClick);
    return node;
  }

  function conditionControls(condition, ruleIndex, index, name) {
    const update = patch => edit(next => Object.assign(next[ruleIndex].conditions[index], patch));
    if (condition.type === "modifier") {
      return [select(PROFILE_RULE_MODIFIERS.map(key => [key, MODIFIER_LABELS[key]]), condition.key, "key", `${name}: key`,
        key => update({ key }))];
    }
    if (condition.type === "popupLevel") {
      const level = create("input", { type: "number", min: "0", step: "1", inputmode: "numeric",
        "aria-label": `${name}: level`, "data-role": "level" });
      level.value = String(condition.level);
      level.addEventListener("change", () => {
        const value = Number(level.value);
        if (Number.isInteger(value) && value >= 0) update({ level: value });
        else level.value = String(condition.level);
      });
      return [select(PROFILE_RULE_COMPARISONS.map(id => [id, COMPARISON_LABELS[id]]), condition.comparison,
        "comparison", `${name}: comparison`, comparison => update({ comparison })), level];
    }
    const text = create("input", { type: "text", spellcheck: "false", autocomplete: "off",
      placeholder: PLACEHOLDERS[condition.type], "data-role": "value",
      "aria-label": `${name}: ${condition.type === "domain" ? "domains" : "text"}` });
    text.value = condition.value;
    text.addEventListener("change", () => update({ value: text.value.trim() }));
    return [text];
  }

  function buildCondition(condition, ruleIndex, index, count) {
    const name = `Rule ${ruleIndex + 1}, condition ${index + 1}`;
    const item = create("li", { className: "language-rule-condition" });
    item.dataset.focusKey = `${ruleIndex}:${index}`;
    const type = select(CONDITION_TYPES, condition.type, "type", `${name}: type`,
      value => edit(next => { next[ruleIndex].conditions[index] = newCondition(value); },
        { key: `${ruleIndex}:${index}`, role: "type" }));
    item.append(type, ...conditionControls(condition, ruleIndex, index, name),
      button("Remove", "remove-condition", `Remove ${name.toLowerCase()}`, () => edit(next => {
        next[ruleIndex].conditions.splice(index, 1);
      }, { key: `${ruleIndex}:${Math.max(0, index - 1)}`, role: "remove-condition" }), count === 1));
    return item;
  }

  function buildRule(rule, index) {
    const name = `rule ${index + 1}`;
    const item = create("li", { className: "language-row language-rule" });
    item.dataset.focusKey = `${index}`;
    const head = create("div", { className: "options-actions language-rule-head" });
    const label = create("label", { className: "field-label", text: `Rule ${index + 1}: use` });
    const profile = select(profileList().map(entry => [entry.id, optionLabel(entry.language)]), rule.profileId,
      "profile", `Language of ${name}`, value => edit(next => { next[index].profileId = value; }));
    profile.id = `language-rule-${index}-profile`;
    label.htmlFor = profile.id;
    const move = (to, role) => edit(next => next.splice(to, 0, ...next.splice(index, 1)), { key: `${to}`, role });
    head.append(label, profile,
      button("Move up", "up", `Move ${name} up`, () => move(index - 1, "up"), index === 0),
      button("Move down", "down", `Move ${name} down`, () => move(index + 1, "down"), index === rules.length - 1),
      button("Remove", "remove-rule", `Remove ${name}`, () => edit(next => { next.splice(index, 1); }, { key: "add" })));
    const conditions = create("ul", { className: "language-rule-conditions" });
    conditions.append(...rule.conditions.map((condition, at) => buildCondition(condition, index, at, rule.conditions.length)));
    const more = button("Add condition", "add-condition", `Add a condition to ${name}`, () => edit(next => {
      next[index].conditions.push(newCondition("domain"));
    }, { key: `${index}:${rule.conditions.length}`, role: "type" }));
    item.append(head, conditions, more);
    return item;
  }

  // Rebuilds the list, then focuses `focus`, or what had focus: the control
  // with its role in the rule or condition named by its key ("1", "1:0"), the
  // other order button when a move disabled it, else the first enabled one.
  function renderRules(focus = null) {
    const focused = list.contains(document.activeElement) ? document.activeElement : null;
    const wanted = focus ?? (focused === null ? null
      : { key: focused.closest("[data-focus-key]")?.dataset.focusKey, role: focused.dataset.role });
    shown = shownKey();
    list.replaceChildren(...rules.map((rule, index) => buildRule(rule, index)));
    list.hidden = rules.length === 0;
    if (wanted === null) return;
    const target = [...list.querySelectorAll("[data-focus-key]")].find(node => node.dataset.focusKey === wanted.key);
    const controls = [...(target?.querySelectorAll("select, input, button") ?? [])].filter(node => !node.disabled);
    const role = name => controls.find(node => node.dataset.role === name);
    (role(wanted.role) ?? role(OTHER_ORDER_BUTTON[wanted.role]) ?? controls[0] ?? add).focus();
  }

  add.addEventListener("click", () => edit(next => {
    next.push({ profileId: profileList()[0].id, conditions: [newCondition("domain")] });
  }, { key: `${rules.length}:0`, role: "type" }));

  // Shows the stored rules, unless a save is pending or a text field of this
  // list is being edited.
  function render() {
    if (pending > 0 || (list.contains(document.activeElement) && document.activeElement.type === "text")) return;
    rules = copyRules(storedRules());
    if (shownKey() !== shown) renderRules();
  }

  return { card, render };
}
