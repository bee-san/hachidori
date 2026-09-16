import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, existsSync, readdirSync } from "node:fs";

const root = new URL("../extension/", import.meta.url);
test("popup action icons share local Fluent 20px geometry and currentColor", () => {
  assert.ok(existsSync(new URL("icons.css", root)), "shared Fluent icons stylesheet exists");
  const css = readFileSync(new URL("icons.css", root), "utf8");
  assert.ok(css.startsWith("/* SPDX-License-Identifier: GPL-3.0-or-later */\n"));
  for (const name of ["add", "book-search", "speaker-2", "edit", "checkmark", "error-circle"]) {
    assert.match(css, new RegExp(`\\[data-icon="${name}"\\]`));
  }
  assert.match(css, /width: 20px/);
  assert.match(css, /height: 20px/);
  assert.match(css, /background: currentColor/);
  assert.match(css, /data:image\/svg\+xml/);
  assert.doesNotMatch(css, /https?:\/\//);
  const readme = readFileSync(new URL("README.md", root), "utf8");
  assert.match(readme, /`icons\.css`/u);
  assert.doesNotMatch(readme, /icons in `render\/icons\/`/u);
});

test("reader and status pseudo-icons use the same Fluent source as controls", () => {
  const css = readFileSync(new URL("icons.css", root), "utf8");
  for (const selector of [".gsm-hoshidicts-audio-button::before", ".operational-status.is-ready::before",
    ".operational-status:not(.is-working):not(.is-ready):not(.is-error)::before",
    ".gsm-hoshidicts-popup-close::before", ".gloss-link-external-icon"]) assert.ok(css.includes(selector), selector);
  const reader = readFileSync(new URL("render/reader.css", root), "utf8");
  const settings = readFileSync(new URL("settings.css", root), "utf8");
  assert.doesNotMatch(reader, /data:image\/svg/);
  assert.doesNotMatch(settings.match(/\.operational-status::before\s*\{[^}]*\}/u)?.[0] ?? "", /(?:width|height)\s*:/u);
  assert.match(readFileSync(new URL("content.js", root), "utf8"), /getURL\("icons.css"\)/);
});

test("the vendored subset has pinned provenance and no unlisted SVGs", () => {
  const directory = new URL("icons/fluent/", root);
  const sources = JSON.parse(readFileSync(new URL("sources.json", directory), "utf8"));
  assert.equal(sources.repository, "microsoft/fluentui-system-icons");
  assert.match(sources.revision, /^[0-9a-f]{40}$/u);
  assert.match(readFileSync(new URL("LICENSE", directory), "utf8"), /^MIT License/u);
  assert.deepEqual(readdirSync(directory).filter(name => name.endsWith(".svg")).sort(),
    Object.keys(sources.icons).map(name => `${name}.svg`).sort());
  const update = readFileSync(new URL("../scripts/vendor-fluent-icons.py", import.meta.url), "utf8");
  assert.ok(update.includes(`REVISION = "${sources.revision}"`));
  for (const [name, path] of Object.entries(sources.icons)) {
    assert.equal(path, `assets/${name.split("-").map(word => word[0].toUpperCase() + word.slice(1)).join(" ")}`
      + `/SVG/ic_fluent_${name.replaceAll("-", "_")}_20_regular.svg`);
  }
});
