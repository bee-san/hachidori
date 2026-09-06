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
    popupNestingMaxDepth: 10,
    popupTheme: "default",
    popupToolbarPosition: "auto",
    customPopupCss: "",
    audioSources: [],
    popupWidthPx: 560,
    popupHeightPx: 420,
    popupOpacityPercent: 85,
    sourceHighlightEnabled: true,
    popupColumns: 1,
    showCompactDefinitionSummary: false,
    compactDefinitionSummaryCount: 3,
    compactDefinitionSummaryDictionary: "",
    popupImageSource: null,
    averageFrequency: false,
    showFrequencyDictionaryNames: true,
    showPitchAccentFurigana: true,
    pitchAccentFuriganaDictionary: "",
    showPitchAccentBadge: true,
    hidePopupGrammarTags: false,
    kanjiClickDictionary: "",
    frequencyDictionary: "",
    frequencyOrder: "auto",
  };
  const NUMBER_RANGES = {
    scanLength: [1, 64],
    maxResults: [1, 256],
    hoverDelayMs: [0, 2000],
    popupHideDelayMs: [0, 5000],
    popupNestingMaxDepth: [0, Number.MAX_SAFE_INTEGER],
    popupWidthPx: [280, 1200],
    popupHeightPx: [200, 900],
    popupOpacityPercent: [0, 100],
    popupColumns: [1, 4],
    compactDefinitionSummaryCount: [1, 6],
  };
  // Audited Hoshidicts catalogue from GSM PR #549; palette values live in reader.css.
  const POPUP_THEME_GROUPS = [
    { label: "Dark", ids: ["default", "miku", "catppuccin-mocha", "solarized-dark", "dark", "synthwave",
      "halloween", "forest", "aqua", "black", "luxury", "dracula", "business", "night", "coffee", "dim", "sunset", "abyss"] },
    { label: "Light", ids: ["girlypop", "solarized-light", "light", "cupcake", "bumblebee", "emerald", "corporate",
      "retro", "cyberpunk", "valentine", "garden", "lofi", "pastel", "fantasy", "wireframe", "cmyk", "autumn", "acid",
      "lemonade", "winter", "nord", "caramellatte", "silk"] },
    { label: "High contrast", ids: ["high-contrast"] },
  ].map(({ label, ids }) => ({ label, themes: ids.map(id => ({ id,
    label: id === "default" ? "Hachidori (default)"
      : id.replace(/(^|-)([a-z])/gu, (_, separator, letter) => `${separator ? " " : ""}${letter.toUpperCase()}`),
  })) }));
  const POPUP_THEME_IDS = new Set(POPUP_THEME_GROUPS.flatMap(group => group.themes.map(theme => theme.id)));
  const DESIGN_OPTION_KEYS = [
    "popupTheme", "popupToolbarPosition", "customPopupCss", "popupWidthPx", "popupHeightPx", "popupOpacityPercent", "sourceHighlightEnabled", "popupColumns",
    "showCompactDefinitionSummary", "compactDefinitionSummaryCount", "compactDefinitionSummaryDictionary",
    "kanjiClickDictionary", "popupImageSource", "averageFrequency", "showFrequencyDictionaryNames",
    "showPitchAccentFurigana", "pitchAccentFuriganaDictionary", "showPitchAccentBadge", "hidePopupGrammarTags",
  ];
  const LEGACY_MODIFIERS = new Map([["none", "Shift"], ["shift", "Shift"], ["ctrl", "Control"], ["alt", "Alt"]]);
  const LOOKUP_MODES = ["hover", "activation"];
  const POPUP_TOOLBAR_POSITIONS = new Set(["auto", "top", "bottom"]);
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
  const AUDIO_SOURCE_TYPES = ["custom", "custom-json", "text-to-speech", "text-to-speech-reading"];

  function normaliseAudioSources(value) {
    if (!Array.isArray(value)) return [];
    const ids = new Set();
    return value.flatMap(source => {
      if (!source || typeof source.id !== "string" || source.id === "" || ids.has(source.id)
          || !AUDIO_SOURCE_TYPES.includes(source.type)) return [];
      ids.add(source.id);
      return [{ id: source.id, type: source.type, enabled: typeof source.enabled === "boolean" ? source.enabled : true,
        url: typeof source.url === "string" ? source.url : "", voice: typeof source.voice === "string" ? source.voice : "" }];
    });
  }

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
    if (typeof DEFAULT_OPTIONS[key] === "boolean") {
      return typeof value === "boolean" ? value : DEFAULT_OPTIONS[key];
    }
    switch (key) {
      case "lookupMode": return LOOKUP_MODES.includes(value) ? value : DEFAULT_OPTIONS.lookupMode;
      case "popupTheme": return POPUP_THEME_IDS.has(value) ? value : DEFAULT_OPTIONS.popupTheme;
      case "popupToolbarPosition": return POPUP_TOOLBAR_POSITIONS.has(value) ? value : DEFAULT_OPTIONS.popupToolbarPosition;
      case "activationKey": return normaliseActivationKey(value);
      case "frequencyOrder": return FREQUENCY_ORDERS.includes(value) ? value : DEFAULT_OPTIONS.frequencyOrder;
      case "kanjiClickDictionary": return normaliseKanjiSelection(value);
      case "popupImageSource": return normalisePopupImageSource(value);
      case "audioSources": return normaliseAudioSources(value);
      default: return typeof value === "string" ? value : "";
    }
  }

  function resolveKanjiDictionary(selection, dictionaries) {
    const title = typeof selection === "string" ? selection : selection?.title;
    if (typeof title !== "string" || title === "") return null;
    const selected = dictionaries.find(entry => entry.title === title && entry.enabled !== false);
    if (!selected) return null;
    const requestedKind = typeof selection === "object" ? selection.kind : "";
    const defaultKind = selected.kanjiCount > 0 ? "kanji" : "term";
    const kind = requestedKind === "" ? defaultKind : requestedKind;
    const available = kind === "kanji" ? selected.kanjiCount > 0 : selected.termCount > 0
      || (selected.frequencyCount === 0 && selected.pitchCount === 0 && selected.kanjiCount === 0);
    return available ? { kind, title } : null;
  }

  function normalisePopupImageSource(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    if (value.kind === "dictionary" && typeof value.title === "string" && value.title !== "") {
      return { kind: "dictionary", title: value.title };
    }
    if (value.kind === "tabGroup" && typeof value.id === "string" && value.id !== "") {
      return { kind: "tabGroup", id: value.id };
    }
    return null;
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

  // Null uses the definition's dictionary. Empty means no eligible source;
  // group membership order is the per-image fallback order.
  function resolvePopupImageSources(source, dictionaries, groups) {
    if (!source) return null;
    if (source.kind === "dictionary") {
      return dictionaries.some(entry => entry.enabled && entry.title === source.title) ? [source.title] : [];
    }
    const group = groups.find(entry => entry.id === source.id);
    const titles = new Map(dictionaries.filter(entry => entry.enabled).map(entry => [entry.id, entry.title]));
    return (group?.dictionaryIds || []).filter(id => titles.has(id)).map(id => titles.get(id));
  }

  function projectOptions(value, strict) {
    const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const result = legacyActivationOptions(source, strict);
    for (const key of OPTION_KEYS) {
      if (!Object.hasOwn(source, key)) continue;
      const raw = source[key];
      const normalized = normaliseField(key, raw);
      if (strict && !isValidOptionField(key, raw, normalized)) {
        throw new Error("the options write request carried an invalid reader option");
      }
      result[key] = normalized;
    }
    return result;
  }

  function isValidOptionField(key, raw, normalized) {
    if (key === "kanjiClickDictionary") return typeof raw === "string" || typeof normalized === "object";
    if (key === "popupImageSource") return raw === null || normalized !== null;
    if (key === "audioSources") return Array.isArray(raw) && raw.length === normalized.length
      && normalized.every((source, index) => Object.entries(source).every(([field, value]) => raw[index][field] === value));
    return typeof raw === typeof DEFAULT_OPTIONS[key] && raw === normalized;
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
    POPUP_THEME_GROUPS, DESIGN_OPTION_KEYS,
    AUDIO_SOURCE_TYPES,
    clampOption, normaliseActivationKey, normaliseKanjiSelection, normaliseOptions,
    projectStoredOptions, validateOptionsPatch,
    resolvePopupImageSources,
    resolveKanjiDictionary,
  };
}());
