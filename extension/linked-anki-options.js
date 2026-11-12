// Preserve settings an older linked reader cannot edit. A field is matched
// by stable Template ID, never the Template's current name or position.
// SPDX-License-Identifier: GPL-3.0-or-later
import { sameJsonValue } from "./json-value.js";

export function preserveLinkedAnkiTemplateFields(current, incoming, defaults,
  unsupported = "Update the linked Hachidori before changing these Anki Template settings.") {
  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) return incoming;
  function preserve(source, previous) {
    if (!source || typeof source !== "object" || Array.isArray(source)) return source;
    const result = { ...source };
    for (const [key, fallback] of Object.entries(defaults)) {
      const saved = previous && Object.hasOwn(previous, key) ? previous[key] : fallback;
      if (Object.hasOwn(source, key) && !sameJsonValue(source[key], saved)) throw new Error(unsupported);
      result[key] = saved;
    }
    return result;
  }
  if (!Array.isArray(incoming.templates)) return preserve(incoming, current.templates[0]);
  const previous = new Map(current.templates.map(template => [template.id, template]));
  const templates = incoming.templates.map(template => preserve(template, previous.get(template?.id)));
  return { ...preserve(incoming, templates[0]), templates };
}
