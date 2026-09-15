// SPDX-License-Identifier: GPL-3.0-or-later

export const ANKI_CONFIG_SCHEMA_VERSION = 1;
export const DEFAULT_ANKI_CONFIG = Object.freeze({
  schemaVersion: ANKI_CONFIG_SCHEMA_VERSION,
  url: "http://127.0.0.1:8765",
  apiKey: "",
  deck: "Default",
  model: "",
});

function normaliseUrl(value) {
  if (typeof value !== "string" || /[\u0000-\u001f\u007f]/u.test(value)) return "";
  try {
    const url = new URL(value.trim());
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return "";
    url.hash = "";
    return url.pathname === "/" && !url.search ? url.origin : url.href;
  } catch {
    return "";
  }
}

export function normaliseAnkiConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...DEFAULT_ANKI_CONFIG };
  if (Number.isInteger(value.schemaVersion) && value.schemaVersion > ANKI_CONFIG_SCHEMA_VERSION) {
    throw new Error("This profile has a newer Anki configuration. Update Hachidori before changing it.");
  }
  const result = { ...DEFAULT_ANKI_CONFIG };
  if (Object.hasOwn(value, "url")) result.url = normaliseUrl(value.url);
  for (const key of ["apiKey", "deck", "model"]) {
    if (typeof value[key] === "string") result[key] = value[key];
  }
  return result;
}
