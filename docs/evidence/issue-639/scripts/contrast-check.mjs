// Ad-hoc contrast check for #639 (not committed): the Clipboard monitor switch
// on the search page, in every palette of Design → Popup theme, against the
// same switch in Settings (Reading → Search page → Show Search in the toolbar
// menu). WCAG 2.2 ratios from computed colours, each converted to sRGB through
// a canvas and composited over what is behind it:
//   label      the label's text on the page behind it (1.4.3, 4.5:1)
//   offEdge    the off switch's border on what is behind the switch (1.4.11, 3:1)
//   offKnob    the off switch's knob on its track
//   onTrack    the on switch's track on what is behind it (1.4.11, 3:1)
//   onKnob     the on switch's knob on its track
// node /tmp/hachi-639/contrast-check.mjs <repo>
import { mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const repo = resolve(process.argv[2]);
const require = createRequire(resolve(repo, "test/tooling/package.json"));
const { default: puppeteer } = await import(require.resolve("puppeteer-core"));
const EXTENSION = resolve(repo, "extension");
const PROFILE = `/tmp/hachi-639/contrast-profile-${process.pid}`;
mkdirSync(PROFILE, { recursive: true });
const browser = await puppeteer.launch({ executablePath: process.env.HACHIDORI_CHROME, headless: true, userDataDir: PROFILE,
  enableExtensions: true, args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    `--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`] });

// Runs in a page: the ratios for the switch `input`.
function measure(selector) {
  const canvas = new OffscreenCanvas(1, 1);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const rgba = colour => {
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = "#010203";
    context.fillStyle = colour;
    if (context.fillStyle === "#010203" && !/^#010203$/iu.test(colour)) throw new Error(`unparsed colour ${colour}`);
    context.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
    return { r, g, b, a: a / 255 };
  };
  const over = (top, bottom) => ({ r: top.r * top.a + bottom.r * (1 - top.a), g: top.g * top.a + bottom.g * (1 - top.a),
    b: top.b * top.a + bottom.b * (1 - top.a), a: 1 });
  const luminance = ({ r, g, b }) => {
    const channel = value => { const c = value / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  };
  const ratio = (a, b) => {
    const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return Math.round(((high + 0.05) / (low + 0.05)) * 100) / 100;
  };
  // What is painted behind `element`: its ancestors' backgrounds, outermost first, over white.
  const backdrop = element => {
    const chain = [];
    for (let node = element.parentElement; node; node = node.parentElement) chain.unshift(node);
    return chain.reduce((below, node) => over(rgba(getComputedStyle(node).backgroundColor), below), { r: 255, g: 255, b: 255, a: 1 });
  };
  const input = document.querySelector(selector);
  const label = input.closest("label").querySelector("span");
  const behind = backdrop(input);
  const labelBehind = backdrop(label);
  const wasChecked = input.checked;
  const state = checked => {
    input.checked = checked;
    const style = getComputedStyle(input);
    const track = over(rgba(style.backgroundColor), behind);
    return { edge: over(rgba(style.borderTopColor), behind), track,
      knob: over(rgba(style.getPropertyValue("--switch-knob").trim()), track), opacity: style.opacity };
  };
  const off = state(false);
  const on = state(true);
  input.checked = wasChecked;
  return {
    theme: document.documentElement.dataset.hoshidictsTheme,
    label: ratio(rgba(getComputedStyle(label).color), labelBehind),
    offEdge: ratio(off.edge, behind), offKnob: ratio(off.knob, off.track),
    onTrack: ratio(on.track, behind), onKnob: ratio(on.knob, on.track),
    opacity: [off.opacity, on.opacity],
  };
}

try {
  const worker = await browser.waitForTarget(t => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"));
  const id = new URL(worker.url()).host;
  const settings = await browser.newPage();
  await settings.goto(`chrome-extension://${id}/settings.html#reading`, { waitUntil: "domcontentloaded" });
  for (const page of await browser.pages()) if (page.url().endsWith("/startup.html")) await page.close();
  const search = await browser.newPage();
  await search.goto(`chrome-extension://${id}/search.html`, { waitUntil: "domcontentloaded" });
  await search.waitForFunction(() => !document.getElementById("search-clipboard").disabled, { polling: 50, timeout: 30_000 });
  await settings.waitForSelector("#opt-toolbar-search");
  // Final colours only: the switch transitions its background, and a page its colours on a theme change.
  for (const page of [search, settings]) {
    await page.addStyleTag({ content: "*, *::before, *::after { transition: none !important; animation: none !important; }" });
  }
  const themes = await settings.evaluate(() => globalThis.HDReaderOptions.POPUP_THEME_GROUPS
    .flatMap(group => group.themes.map(theme => theme.id)).filter(theme => theme !== "auto"));
  const rows = [];
  for (const theme of themes) {
    await settings.evaluate(async value => {
      const { options } = await chrome.storage.local.get("options");
      const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
        baseRevision: options?.revision ?? 0, options: { popupTheme: value } });
      if (!reply.ok) throw new Error(reply.error);
    }, theme);
    for (const page of [search, settings]) {
      await page.waitForFunction(value => document.documentElement.dataset.hoshidictsTheme === value,
        { polling: 50, timeout: 10_000 }, theme);
    }
    const searchRow = await search.evaluate(measure, "#search-clipboard");
    const settingsRow = await settings.evaluate(measure, "#opt-toolbar-search");
    rows.push({ theme, search: searchRow, settings: settingsRow });
  }
  const keys = ["label", "offEdge", "offKnob", "onTrack", "onKnob"];
  const minimum = (page, key) => rows.reduce((low, row) => (row[page][key] < low.value ? { value: row[page][key], theme: row.theme } : low),
    { value: Infinity, theme: null });
  const summary = Object.fromEntries(keys.map(key => [key, { search: minimum("search", key), settings: minimum("settings", key) }]));
  const worse = rows.flatMap(row => keys.filter(key => row.search[key] + 0.005 < row.settings[key])
    .map(key => ({ theme: row.theme, key, search: row.search[key], settings: row.settings[key] })));
  console.log(JSON.stringify({ chrome: await browser.version(), themes: themes.length, summary, searchWorseThanSettings: worse,
    rows }, null, 1));
} finally {
  await browser.close();
  rmSync(PROFILE, { recursive: true, force: true });
}
