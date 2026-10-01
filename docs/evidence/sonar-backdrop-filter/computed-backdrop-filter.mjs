// SPDX-License-Identifier: GPL-3.0-or-later
// Compares the popup's computed backdrop-filter under two reader.css versions
// for every palette, with --gsm-hoshidicts-popup-backdrop-filter unset, valid
// and invalid.
// Usage: node computed-backdrop-filter.mjs <chrome> <before.css> <after.css>
// Run from a checkout with test/tooling installed (npm ci --prefix test/tooling).
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const puppeteer = createRequire(resolve("test/tooling/package.json"))("puppeteer-core");
const [executablePath, beforePath, afterPath] = process.argv.slice(2);
const before = readFileSync(beforePath, "utf8");
const after = readFileSync(afterPath, "utf8");
const themes = [...new Set(["default", ...[...before.matchAll(/data-hoshidicts-theme="([^"]+)"/gu)].map(m => m[1])])];
const browser = await puppeteer.launch({ executablePath, headless: true, args: ["--no-sandbox"] });
try {
  const page = await browser.newPage();
  await page.goto("about:blank");
  const result = await page.evaluate((before, after, themes) => {
    const read = (css) => {
      const host = document.createElement("div");
      document.body.append(host);
      const root = host.attachShadow({ mode: "open" });
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      root.adoptedStyleSheets = [sheet];
      const popup = document.createElement("div");
      popup.className = "gsm-hoshidicts-popup";
      root.append(popup);
      const values = {};
      for (const custom of [null, "blur(4px)", "not-a-filter"]) {
        for (const theme of themes) {
          if (theme === "default") delete host.dataset.hoshidictsTheme;
          else host.dataset.hoshidictsTheme = theme;
          if (custom === null) popup.style.removeProperty("--gsm-hoshidicts-popup-backdrop-filter");
          else popup.style.setProperty("--gsm-hoshidicts-popup-backdrop-filter", custom);
          const style = getComputedStyle(popup);
          values[`${custom ?? "unset"}|${theme}`] = `${style.getPropertyValue("backdrop-filter")}`
            + ` | -webkit-: ${style.getPropertyValue("-webkit-backdrop-filter") || "(not exposed)"}`;
        }
      }
      host.remove();
      return values;
    };
    const a = read(before);
    const b = read(after);
    return {
      browser: navigator.userAgent.match(/Chrome\/[\d.]+/)[0],
      cases: Object.keys(a).length,
      differences: Object.keys(a).filter(key => a[key] !== b[key]).map(key => ({ key, before: a[key], after: b[key] })),
      values: [...new Set(Object.values(a))],
    };
  }, before, after, themes);
  console.log(`${result.browser}: ${themes.length} palettes x 3 custom-property states = ${result.cases} cases, `
    + `${result.differences.length} differences`);
  for (const difference of result.differences) console.log("  ", JSON.stringify(difference));
  console.log("  computed values seen:", JSON.stringify(result.values));
} finally {
  await browser.close();
}
