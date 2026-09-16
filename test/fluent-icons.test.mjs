import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, existsSync } from "node:fs";

const root = new URL("../extension/", import.meta.url);
test("popup action icons share local Fluent 20px geometry and currentColor", () => {
  assert.ok(existsSync(new URL("icons.css", root)), "shared Fluent icons stylesheet exists");
  const css = readFileSync(new URL("icons.css", root), "utf8");
  for (const name of ["add", "speaker-2", "edit", "checkmark", "error-circle"]) {
    assert.match(css, new RegExp(`\\[data-icon="${name}"\\]`));
  }
  assert.match(css, /width: 20px/);
  assert.match(css, /height: 20px/);
  assert.match(css, /background: currentColor/);
  assert.match(css, /data:image\/svg\+xml/);
  assert.doesNotMatch(css, /https?:\/\//);
});

test("reader and status pseudo-icons use the same Fluent source as controls", () => {
  const css = readFileSync(new URL("icons.css", root), "utf8");
  for (const selector of [".gsm-hoshidicts-audio-button::before", ".operational-status.is-ready::before",
    ".gsm-hoshidicts-popup-close::before", ".gloss-link-external-icon"]) assert.ok(css.includes(selector), selector);
  const reader = readFileSync(new URL("render/reader.css", root), "utf8");
  const settings = readFileSync(new URL("settings.css", root), "utf8");
  assert.doesNotMatch(reader, /data:image\/svg/);
  assert.doesNotMatch(settings.match(/\.operational-status::before\s*\{[^}]*\}/u)?.[0] ?? "", /(?:width|height)\s*:/u);
  assert.match(readFileSync(new URL("content.js", root), "utf8"), /getURL\("icons.css"\)/);
});
