// SPDX-License-Identifier: GPL-3.0-or-later

// The Settings page's own modules: settings.js and the feature modules that
// share its bindings by importing from it and from each other. The jsdom
// harnesses strip their imports and evaluate them as one script. The feature
// modules' top-level code only declares, so their order does not matter;
// settings.js starts the page and comes last.
export const SETTINGS_PAGE_MODULES = [
  "import-settings.js", "update-settings.js", "custom-dictionary-settings.js", "lookup-stats-settings.js",
  "settings.js",
];
