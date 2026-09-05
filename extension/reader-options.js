// SPDX-License-Identifier: GPL-3.0-or-later

// Loaded synchronously by the content-script manifest and by side-effect imports
// in extension modules, so every options consumer uses the same stored view.
(function () {
  "use strict";

  const DEFAULT_OPTIONS = {
    scanLength: 16,
    maxResults: 32,
    modifier: "none",
    hoverDelayMs: 50,
    kanjiClickDictionary: "",
    frequencyDictionary: "",
    frequencyOrder: "auto",
  };
  const NUMBER_RANGES = {
    scanLength: [1, 64],
    maxResults: [1, 256],
    hoverDelayMs: [0, 2000],
  };
  const MODIFIERS = ["none", "shift", "ctrl", "alt"];
  const FREQUENCY_ORDERS = ["auto", "ascending", "descending", "disabled"];
  const OPTION_KEYS = Object.keys(DEFAULT_OPTIONS);

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
    if (key === "modifier") return MODIFIERS.includes(value) ? value : DEFAULT_OPTIONS.modifier;
    if (key === "frequencyOrder") return FREQUENCY_ORDERS.includes(value) ? value : DEFAULT_OPTIONS.frequencyOrder;
    if (key === "kanjiClickDictionary") return normaliseKanjiSelection(value);
    return typeof value === "string" ? value : "";
  }

  function projectOptions(value, strict) {
    const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const result = {};
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
    DEFAULT_OPTIONS, NUMBER_RANGES, MODIFIERS, FREQUENCY_ORDERS,
    clampOption, normaliseKanjiSelection, normaliseOptions,
    projectStoredOptions, validateOptionsPatch,
  };
}());
