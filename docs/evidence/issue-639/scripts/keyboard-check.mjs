// Ad-hoc keyboard check for #639 (not committed): the search page's Clipboard
// monitor switch in real Chrome, with the extension as shipped (clipboardRead
// optional and not granted). From the focused search box, Shift+Tab must reach
// the switch, which must show the focus ring and be named "Clipboard monitor";
// Space must ask for clipboardRead, and a refusal must leave the switch off.
// node /tmp/hachi-639/keyboard-check.mjs <repo> <screenshot.png>
import { mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const repo = resolve(process.argv[2]);
const shot = resolve(process.argv[3]);
const require = createRequire(resolve(repo, "test/tooling/package.json"));
const { default: puppeteer } = await import(require.resolve("puppeteer-core"));
const EXTENSION = resolve(repo, "extension");
const PROFILE = `/tmp/hachi-639/keyboard-profile-${process.pid}`;
mkdirSync(PROFILE, { recursive: true });
const browser = await puppeteer.launch({ executablePath: process.env.HACHIDORI_CHROME, headless: true, userDataDir: PROFILE,
  enableExtensions: true, args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    `--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`] });
try {
  const worker = await browser.waitForTarget(t => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"));
  const id = new URL(worker.url()).host;
  const search = await browser.newPage();
  await search.setViewport({ width: 960, height: 400 });
  await search.goto(`chrome-extension://${id}/search.html`, { waitUntil: "domcontentloaded" });
  for (const page of await browser.pages()) if (page.url().endsWith("/startup.html")) await page.close();
  await search.bringToFront();
  await search.waitForFunction(() => !document.getElementById("search-clipboard").disabled, { polling: 50, timeout: 30_000 });
  await search.evaluate(() => {
    globalThis.requests = [];
    chrome.permissions.request = async permissions => { globalThis.requests.push(permissions); return false; };
    document.getElementById("search-input").focus();
  });
  const start = await search.evaluate(() => document.activeElement.id);
  await search.keyboard.down("Shift");
  await search.keyboard.press("Tab");
  await search.keyboard.up("Shift");
  const focused = await search.evaluate(() => {
    const element = document.activeElement;
    const style = getComputedStyle(element);
    return { id: element.id, focusVisible: element.matches(":focus-visible"), outline: `${style.outlineStyle} ${style.outlineWidth}`,
      checked: element.checked };
  });
  const tree = await search.accessibility.snapshot({ interestingOnly: true });
  const nodes = [];
  const walk = node => { nodes.push(node); for (const child of node.children ?? []) walk(child); };
  walk(tree);
  const checkbox = nodes.find(node => node.role === "checkbox");
  const header = await search.$(".search-header");
  await header.screenshot({ path: shot });
  await search.keyboard.press("Space");
  await search.waitForFunction(() => globalThis.requests.length > 0, { polling: 50, timeout: 10_000 });
  await search.waitForFunction(() => !document.getElementById("search-clipboard").checked, { polling: 50, timeout: 10_000 });
  const after = await search.evaluate(() => ({ requests: globalThis.requests, checked: document.getElementById("search-clipboard").checked,
    granted: chrome.permissions.contains({ permissions: ["clipboardRead"] }) }));
  after.granted = await search.evaluate(() => chrome.permissions.contains({ permissions: ["clipboardRead"] }));
  const result = { chrome: await browser.version(), start, focused, checkbox: checkbox && { role: checkbox.role, name: checkbox.name,
    checked: checkbox.checked }, after };
  console.log(JSON.stringify(result, null, 1));
  const ok = start === "search-input" && focused.id === "search-clipboard" && focused.focusVisible && focused.checked === false
    && checkbox?.name === "Clipboard monitor" && JSON.stringify(after.requests) === '[{"permissions":["clipboardRead"]}]'
    && after.checked === false && after.granted === false;
  console.log(ok ? "PASS" : "FAIL");
  process.exitCode = ok ? 0 : 1;
} finally {
  await browser.close();
  rmSync(PROFILE, { recursive: true, force: true });
}
