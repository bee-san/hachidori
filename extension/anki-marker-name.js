// SPDX-License-Identifier: GPL-3.0-or-later
// Marker names are case-insensitive; dictionary group IDs remain opaque.
export function normaliseAnkiMarkerName(name) {
  const prefix = "glossary-selection-group-";
  return name.toLowerCase().startsWith(prefix)
    ? prefix + name.slice(prefix.length) : name.toLowerCase();
}
