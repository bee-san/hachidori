import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { resolve } from "node:path";
import { createContext, runInContext } from "node:vm";

const ROOT = resolve(import.meta.dirname, "..");
const read = path => readFileSync(resolve(ROOT, path), "utf8");
const readerCss = read("extension/render/reader.css");
const settingsCss = read("extension/settings.css");

function cssBlock(source, expression, description) {
  const block = source.match(expression)?.[1];
  assert.ok(block, `${description} CSS block is present`);
  return block;
}

function colorVariable(block, name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const value = block.match(new RegExp(`${escapedName}:\\s*(#[\\da-f]{6})\\s*;`, "iu"))?.[1];
  assert.ok(value, `${name} is a six-digit hex colour`);
  return value.toLowerCase();
}

function channels(hex) {
  return hex.slice(1).match(/../gu).map(value => Number.parseInt(value, 16));
}

function hex(channelsValue) {
  return `#${channelsValue.map(value => Math.round(value).toString(16).padStart(2, "0")).join("")}`;
}

function mix(first, second, firstWeight) {
  const right = channels(second);
  return hex(channels(first).map((value, index) => value * firstWeight + right[index] * (1 - firstWeight)));
}

function luminance(value) {
  return channels(value)
    .map(channel => channel / 255)
    .map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
    .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
}

function contrast(first, second) {
  const left = luminance(first);
  const right = luminance(second);
  return (Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05);
}

function distance(first, second) {
  const right = channels(second);
  return Math.hypot(...channels(first).map((value, index) => value - right[index]));
}

const paletteBlock = cssBlock(
  readerCss,
  /html\[data-hoshidicts-theme="autumn"\],\s*:host\(\[data-hoshidicts-theme="autumn"\]\)\s*\{([^}]+)\}/u,
  "Autumn palette",
);
const popupBlock = cssBlock(
  readerCss,
  /:host\(\[data-hoshidicts-theme="autumn"\]\) \.gsm-hoshidicts-popup\s*\{([^}]+)\}/u,
  "Autumn popup",
);
const settingsBlock = cssBlock(
  settingsCss,
  /:root\[data-hoshidicts-theme="autumn"\]\s*\{([^}]+)\}/u,
  "Autumn Settings",
);

test("Autumn remains one explicit light theme with the exact public name", () => {
  const context = createContext({});
  runInContext(read("extension/reader-options.js"), context);
  const groups = context.HDReaderOptions.POPUP_THEME_GROUPS;
  const autumn = groups.flatMap(group => group.themes.map(theme => ({ ...theme, group: group.label })))
    .filter(theme => theme.id === "autumn");

  assert.equal(JSON.stringify(autumn), JSON.stringify([{ id: "autumn", label: "Autumn", group: "Light" }]));
  assert.equal(context.HDReaderOptions.normaliseOptions({ popupTheme: "autumn" }).popupTheme, "autumn");
});

test("Autumn popup colours keep text, badges and every status readable and distinct", () => {
  const palette = Object.fromEntries([
    "base-100", "base-200", "base-300", "base-content",
    "primary", "primary-content", "secondary", "secondary-content",
    "accent", "accent-content", "neutral", "neutral-content",
    "info", "info-content", "success", "warning", "error",
  ].map(name => [name, colorVariable(paletteBlock, `--hoshidicts-palette-${name}`)]));
  const card = mix(palette["base-100"], palette["base-200"], 0.72);

  assert.match(paletteBlock, /--hoshidicts-palette-color-scheme:\s*light;/u);
  assert.ok(contrast(palette["base-content"], card) >= 7);
  for (const [foreground, background] of [
    ["primary-content", "primary"],
    ["secondary-content", "secondary"],
    ["accent-content", "accent"],
    ["neutral-content", "neutral"],
    ["info-content", "info"],
  ]) {
    assert.ok(contrast(palette[foreground], palette[background]) >= 4.5, `${foreground} contrasts with ${background}`);
  }
  for (const status of ["success", "warning", "error"]) {
    assert.ok(contrast(palette[status], card) >= 4.5, `${status} contrasts with cards`);
  }
  for (const [first, second] of [["success", "warning"], ["success", "error"], ["warning", "error"]]) {
    assert.ok(distance(palette[first], palette[second]) >= 45, `${first} and ${second} are visually distinct`);
  }
  assert.ok(contrast(palette["base-100"], palette["base-200"]) >= 1.1);
  assert.ok(contrast(palette["base-200"], palette["base-300"]) >= 1.1);
});

test("Autumn popup refinements expose readable controls, metadata, links and interaction states", () => {
  const base = colorVariable(paletteBlock, "--hoshidicts-palette-base-100");
  const card = mix(base, colorVariable(paletteBlock, "--hoshidicts-palette-base-200"), 0.72);
  const popup = Object.fromEntries([
    "text-faint", "border", "border-strong", "accent-soft",
    "link", "link-hover", "scrollbar", "pitch",
  ].map(name => [name, colorVariable(popupBlock, `--hoshidicts-${name}`)]));

  assert.ok(contrast(popup["text-faint"], card) >= 4.5);
  assert.ok(contrast(popup.border, card) >= 3);
  assert.ok(contrast(popup["border-strong"], base) >= 4.5);
  assert.ok(contrast(popup.link, card) >= 4.5);
  assert.ok(contrast(popup["link-hover"], card) >= 4.5);
  assert.ok(distance(popup.link, popup["link-hover"]) >= 45);
  assert.ok(contrast(popup.pitch, base) >= 3);
  assert.match(popupBlock, /radial-gradient\(/u);
  assert.match(popupBlock, /var\(--hoshidicts-popup-background\)/u);

  for (const stateHook of [
    /\.gsm-hoshidicts-tab:hover:not\(:disabled\):not\(\[aria-selected="true"\]\)/u,
    /\.gsm-hoshidicts-tab\[aria-selected="true"\]/u,
    /\.gsm-hoshidicts-tab:focus-visible/u,
    /\.gsm-hoshidicts-tab:disabled/u,
    /\.gsm-hoshidicts-mine-button\[data-state="mining"\]/u,
    /\.gsm-hoshidicts-mining-feedback\[data-kind="success"\]/u,
    /\.gsm-hoshidicts-mining-feedback\[data-kind="warning"\]/u,
    /\.gsm-hoshidicts-mining-feedback\[data-kind="error"\]/u,
  ]) {
    assert.match(readerCss, stateHook);
  }
});

test("Autumn Settings projection keeps preview, controls, links and statuses accessible", () => {
  const settings = Object.fromEntries([
    "bg", "surface", "surface-sunken", "border", "border-strong",
    "text", "text-dim", "accent", "accent-fill", "accent-soft",
    "accent-contrast", "ok", "error", "favorite",
  ].map(name => [name, colorVariable(settingsBlock, `--${name}`)]));

  for (const [foreground, background] of [
    ["text", "surface"],
    ["text-dim", "surface"],
    ["text-dim", "bg"],
    ["text-dim", "surface-sunken"],
    ["accent", "accent-soft"],
    ["accent", "surface"],
    ["accent-contrast", "accent-fill"],
    ["error", "surface"],
    ["ok", "bg"],
    ["favorite", "surface"],
  ]) {
    assert.ok(contrast(settings[foreground], settings[background]) >= 4.5,
      `${foreground} contrasts with ${background}`);
  }
  assert.ok(contrast(settings.border, settings.surface) >= 3);
  assert.ok(contrast(settings["border-strong"], settings.surface) >= 4.5);
  assert.notEqual(settings.text, settings["text-dim"]);
  assert.ok(distance(settings.accent, settings.ok) >= 20);
  assert.ok(distance(settings.ok, settings.error) >= 45);
});
