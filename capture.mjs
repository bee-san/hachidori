// Evidence capture for PR #559 (kept off the feature branch).
// Renders the production popup and Anki controller from one extension
// directory with the duplicate check held, so the Anki action stays pending,
// and captures it per palette: idle, hovered and keyboard-focused.
// Usage: node capture.mjs <extensionDir> <label> <outputDir>
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [extensionDir, label, outputDir] = process.argv.slice(2);
// Run from a Hachidori checkout with the locked test tooling and pinned Chrome installed.
const repo = process.cwd();
const puppeteer = (await import(pathToFileURL(`${repo}/test/tooling/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js`))).default;
mkdirSync(outputDir, { recursive: true });

const palettes = [
  { name: "hachidori-dark", theme: "default", scheme: "dark", forced: false },
  { name: "light", theme: "light", scheme: "light", forced: false },
  { name: "high-contrast", theme: "high-contrast", scheme: "dark", forced: false },
  { name: "forced-colors-dark", theme: "default", scheme: "dark", forced: true },
  { name: "forced-colors-light", theme: "default", scheme: "light", forced: true },
];

const browser = await puppeteer.launch({
  executablePath: `${repo}/test/tmp/browsers/chrome/linux-152.0.7977.75/chrome-linux64/chrome`,
  headless: true, args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--font-render-hinting=none"],
});
const results = [];
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 640, height: 360, deviceScaleFactor: 2 });
  await page.setContent('<p style="margin:16px;font:20px sans-serif">響く</p><div id="host"></div>');
  for (const file of ["external-links.js", "render/glossary.js", "render/popup.js", "reader-options.js", "anki-content.js"]) {
    await page.addScriptTag({ path: resolve(extensionDir, file) });
  }
  const css = [readFileSync(resolve(extensionDir, "render/reader.css"), "utf8"),
    readFileSync(resolve(extensionDir, "icons.css"), "utf8")].join("\n");
  await page.evaluate(css => {
    const host = document.querySelector("#host");
    const root = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = css;
    const popup = document.createElement("div");
    popup.className = "gsm-hoshidicts-popup";
    popup.style.cssText = "left:16px;top:56px;width:420px";
    root.append(style, popup);
    // The duplicate check never answers, so the action stays pending.
    const anki = HDAnki.createAnkiController({ onChange() {}, send(type) {
      if (type === "hd_anki_status") return Promise.resolve({ available: true, configKey: "evidence" });
      if (type === "hd_anki_view") return Promise.resolve({ state: "unknown", canAdd: false, noteIds: [], configKey: "evidence", cached: false });
      if (type === "hd_anki_preflight_batch") return new Promise(() => {});
      return Promise.resolve({});
    } });
    anki.update({ anki: { model: "Basic" } });
    const request = {};
    const view = HDPopup.createPopupView({ document, window, popup,
      appendExpressionRuby: HDGlossary.appendExpressionRuby,
      createPronunciationPitchAccent: HDGlossary.createPronunciationPitchAccent,
      appendTextOnlyGlossary: HDGlossary.appendTextOnlyGlossary,
      parseTagList: HDGlossary.parseTagList, positionPopup() {},
      onResultsRendered({ miningActions }) {
        anki.bind(miningActions, { owner: popup, popup, request, isCurrent: () => true, getRequest: () => ({}) });
      },
    });
    view.renderResults([{ matched: "響く", term: { expression: "響く", reading: "ひびく", frequencies: [], pitches: [],
      glossaries: [{ dictionary: "evidence", glossary: JSON.stringify(["to resound", "to be heard far away"]) }] } }],
    { anchor: document.querySelector("p"), query: "響く" }, {});
    window.evidence = { root, popup };
  }, css);
  const session = await page.createCDPSession();
  for (const palette of palettes) {
    await session.send("Emulation.setEmulatedMedia", { features: [
      { name: "prefers-reduced-motion", value: "reduce" },
      { name: "prefers-color-scheme", value: palette.scheme },
      ...(palette.forced ? [{ name: "forced-colors", value: "active" }] : []),
    ] });
    await page.evaluate(({ theme, scheme }) => {
      document.querySelector("#host").dataset.hoshidictsTheme = theme;
      // A page in the same scheme behind the translucent popup.
      document.body.style.background = scheme === "dark" ? "#121212" : "#ffffff";
    }, palette);
    await page.waitForFunction(() => window.evidence.root.querySelector(".gsm-hoshidicts-mine-button")?.dataset.state === "checking");
    const measure = () => page.evaluate(() => {
      const { root } = window.evidence;
      const button = root.querySelector(".gsm-hoshidicts-mine-button");
      const header = root.querySelector(".gsm-hoshidicts-primary-header");
      const page = getComputedStyle(document.body).backgroundColor;
      const toRgb = (...layers) => {
        const context = new OffscreenCanvas(1, 1).getContext("2d");
        for (const colour of [page, ...layers]) {
          context.fillStyle = colour;
          context.fillRect(0, 0, 1, 1);
        }
        return [...context.getImageData(0, 0, 1, 1).data.slice(0, 3)];
      };
      // Every background between the button and the page, outermost first.
      const backgrounds = [];
      let node = button;
      while (node && node !== document.body) {
        const value = node instanceof Element ? getComputedStyle(node).backgroundColor : null;
        if (value && value !== "rgba(0, 0, 0, 0)" && value !== "transparent") backgrounds.unshift(value);
        node = node.parentNode instanceof ShadowRoot ? node.parentNode.host : node.parentNode;
      }
      const background = backgrounds.at(-1) ?? page;
      const luminance = rgb => {
        const [r, g, b] = rgb.map(v => v / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const style = getComputedStyle(button);
      const bg = toRgb(...backgrounds), fg = toRgb(...backgrounds, style.color), border = toRgb(...backgrounds, style.borderTopColor);
      const ratio = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
      const rect = header.getBoundingClientRect();
      return {
        state: button.dataset.state, disabled: button.disabled, ariaBusy: button.getAttribute("aria-busy"),
        ariaLabel: button.getAttribute("aria-label"), icon: button.querySelector(".hd-icon")?.dataset.icon,
        focused: root.activeElement === button, focusVisible: button.matches(":focus-visible"),
        color: style.color, borderColor: style.borderTopColor, background,
        iconContrast: Math.round(ratio(fg, bg) * 100) / 100, borderContrast: Math.round(ratio(border, bg) * 100) / 100,
        clip: { x: Math.max(0, rect.left - 8), y: Math.max(0, rect.top - 8), width: rect.width + 16, height: rect.height + 16 },
        button: button.getBoundingClientRect().toJSON(),
      };
    });
    const idle = await measure();
    await page.screenshot({ path: resolve(outputDir, `${label}-${palette.name}-idle.png`), clip: idle.clip });
    await page.mouse.move(idle.button.x + idle.button.width / 2, idle.button.y + idle.button.height / 2);
    const hovered = await measure();
    await page.screenshot({ path: resolve(outputDir, `${label}-${palette.name}-hover.png`), clip: idle.clip });
    await page.mouse.move(2, 2);
    // A key press first, so a programmatic focus counts as keyboard focus.
    await page.keyboard.press("Shift");
    await page.evaluate(() => window.evidence.root.querySelector(".gsm-hoshidicts-mine-button").focus());
    const focused = await measure();
    await page.screenshot({ path: resolve(outputDir, `${label}-${palette.name}-focus.png`), clip: idle.clip });
    await page.evaluate(() => window.evidence.root.activeElement?.blur());
    results.push({ label, palette: palette.name, idle, hoverBackground: hovered.background, focused: { focused: focused.focused, focusVisible: focused.focusVisible } });
  }
  console.log(`Chrome ${await browser.version()}`);
} finally {
  await browser.close();
}
writeFileSync(resolve(outputDir, `${label}.json`), JSON.stringify(results, null, 2));
for (const r of results) {
  console.log(`${r.label} ${r.palette}: state=${r.idle.state} disabled=${r.idle.disabled} icon=${r.idle.iconContrast}:1 border=${r.idle.borderContrast}:1 focusable=${r.focused.focused} focusVisible=${r.focused.focusVisible}`);
}
