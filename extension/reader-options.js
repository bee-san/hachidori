// SPDX-License-Identifier: GPL-3.0-or-later

// Loaded synchronously by the content-script manifest and by side-effect imports
// in extension modules, so every options consumer uses the same stored view.
(function () {
  "use strict";

  const DEFAULT_OPTIONS = {
    scanLength: 16,
    maxResults: 32,
    hoverEnabled: true,
    onlyScanJapaneseText: true,
    lookupMode: "hover",
    activationKey: "Shift",
    hoverDelayMs: 50,
    popupHideDelayMs: 160,
    kanjiClickDictionary: "",
    frequencyDictionary: "",
    frequencyOrder: "auto",
  };
  const NUMBER_RANGES = {
    scanLength: [1, 64],
    maxResults: [1, 256],
    hoverDelayMs: [0, 2000],
    popupHideDelayMs: [0, 5000],
  };
  const LEGACY_MODIFIERS = new Map([["none", "Shift"], ["shift", "Shift"], ["ctrl", "Control"], ["alt", "Alt"]]);
  const LOOKUP_MODES = ["hover", "activation"];
  // Browser KeyboardEvent names, adapting the source's desktop hotkey names.
  const ACTIVATION_KEYS = [
    "Shift", "Control", "Alt", "Meta", "Space", "Enter", "Escape", "Backspace", "Delete", "Tab",
    "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", "Insert",
    ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
    ...Array.from({ length: 24 }, (_, index) => `F${index + 1}`),
    ..."-=[]\\;',./`",
  ];
  const ACTIVATION_NAMES = new Map(ACTIVATION_KEYS.map((key) => [key.toLowerCase(), key]));
  const FREQUENCY_ORDERS = ["auto", "ascending", "descending", "disabled"];
  const OPTION_KEYS = Object.keys(DEFAULT_OPTIONS);

  function normaliseActivationKey(value, fallback = DEFAULT_OPTIONS.activationKey) {
    if (value === " ") return "Space";
    return typeof value === "string" ? ACTIVATION_NAMES.get(value.toLowerCase()) ?? fallback : fallback;
  }

  function clampOption(key, value) {
    let number;
    try {
      number = Number(value);
    } catch {
      // Legacy writes accepted objects such as {toString: null}; keep them
      // repairable instead of failing every subsequent read and valid save.
      return DEFAULT_OPTIONS[key];
    }
    if (!Number.isFinite(number)) return DEFAULT_OPTIONS[key];
    const [min, max] = NUMBER_RANGES[key];
    return Math.max(min, Math.min(max, Math.trunc(number)));
  }

  /**
   * Preserve legacy title-only selections until dictionary state can infer kind.
   * @returns {string | {title: string, kind: "term" | "kanji"}}
   */
  function normaliseKanjiSelection(value) {
    if (value && typeof value === "object" && typeof value.title === "string"
        && value.title !== "" && (value.kind === "term" || value.kind === "kanji")) {
      return { title: value.title, kind: value.kind };
    }
    return typeof value === "string" ? value : "";
  }

  function normaliseField(key, value) {
    if (Object.hasOwn(NUMBER_RANGES, key)) return clampOption(key, value);
    if (key === "hoverEnabled" || key === "onlyScanJapaneseText") {
      return typeof value === "boolean" ? value : DEFAULT_OPTIONS[key];
    }
    if (key === "lookupMode") return LOOKUP_MODES.includes(value) ? value : DEFAULT_OPTIONS.lookupMode;
    if (key === "activationKey") return normaliseActivationKey(value);
    if (key === "frequencyOrder") return FREQUENCY_ORDERS.includes(value) ? value : DEFAULT_OPTIONS.frequencyOrder;
    if (key === "kanjiClickDictionary") return normaliseKanjiSelection(value);
    return typeof value === "string" ? value : "";
  }

  function legacyActivationOptions(source, strict) {
    if (!Object.hasOwn(source, "modifier")) return {};
    const key = LEGACY_MODIFIERS.get(source.modifier);
    if (strict && key === undefined) {
      throw new Error("the options write request carried an invalid reader option");
    }
    // Old Settings patches still pass through CAS. Plain hover changes mode
    // only, preserving a newer configured key, without a second stored policy.
    return source.modifier === "none" || key === undefined
      ? { lookupMode: "hover" }
      : { lookupMode: "activation", activationKey: key };
  }

  function projectOptions(value, strict) {
    const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const result = legacyActivationOptions(source, strict);
    for (const key of OPTION_KEYS) {
      if (!Object.hasOwn(source, key)) continue;
      const raw = source[key];
      const normalized = normaliseField(key, raw);
      if (strict) {
        const valid = key === "kanjiClickDictionary"
          ? typeof raw === "string" || typeof normalized === "object"
          : typeof raw === typeof DEFAULT_OPTIONS[key] && raw === normalized;
        if (!valid) throw new Error("the options write request carried an invalid reader option");
      }
      result[key] = normalized;
    }
    return result;
  }

  function projectStoredOptions(value) {
    return projectOptions(value, false);
  }

  function validateOptionsPatch(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("the options write request carried no object");
    }
    return projectOptions(value, true);
  }

  function normaliseOptions(value) {
    return { ...DEFAULT_OPTIONS, ...projectStoredOptions(value) };
  }

  globalThis.HDReaderOptions = {
    DEFAULT_OPTIONS, NUMBER_RANGES, LOOKUP_MODES, ACTIVATION_KEYS, FREQUENCY_ORDERS,
    clampOption, normaliseActivationKey, normaliseKanjiSelection, normaliseOptions,
    projectStoredOptions, validateOptionsPatch,
  };
}());
