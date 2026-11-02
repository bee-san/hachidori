// The search page on main and on this PR: screenshots in several palettes,
// with a result, and the Tab order from the search box. Not part of the repo.
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [REPO, EXTENSION, OUT] = process.argv.slice(2);
mkdirSync(OUT, { recursive: true });
const require = createRequire(join(REPO, "test/tooling/package.json"));
const puppeteer = require("puppeteer-core");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: process.env.HACHIDORI_CHROME, enableExtensions: true, headless: true,
  userDataDir: mkdtempSync(join(tmpdir(), "hd644a11y-")),
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1",
    "--hide-scrollbars", `--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`] });
try {
  const sw = await browser.waitForTarget(t => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"));
  const id = new URL(sw.url()).host;
  const settings = await browser.newPage();
  await settings.goto(`chrome-extension://${id}/settings.html`, { waitUntil: "load" });
  for (const p of await browser.pages()) if (p.url().includes("startup.html")) await p.close();
  const fixture = readFileSync(join(REPO, "test/fixtures/hachidori-fixture.zip")).toString("base64");
  await settings.evaluate(async base64 => {
    const blobUrl = URL.createObjectURL(new Blob([Uint8Array.from(atob(base64), c => c.charCodeAt(0))]));
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_import",
        requestId: `a-${attempt}`, blobUrl, fileName: "hachidori-fixture.zip" }).catch(() => null);
      if (reply?.ok) return;
      await new Promise(r => setTimeout(r, 1000));
    }
  }, fixture);
  const writeOptions = patch => settings.evaluate(async patch => {
    const { options } = await chrome.storage.local.get("options");
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
      baseRevision: options?.revision ?? 0, options: patch });
    if (!reply.ok) throw new Error(reply.error);
  }, patch);
  // Lookup counts change with every search, so they are off for the pictures.
  await writeOptions({ showLookupCounts: false });
  const tab = await browser.newPage();
  await tab.setViewport({ width: 900, height: 700 });
  // The search page's own document: the frame on this PR, the page on main.
  const doc = () => tab.frames().find(f => f.url().endsWith("/search-frame.html")) ?? tab.mainFrame();
  const open = async () => {
    await tab.goto(`chrome-extension://${id}/search.html`, { waitUntil: "load" });
    await sleep(400);
    await doc().waitForFunction(() => !document.getElementById("search-submit").disabled, { timeout: 20000 });
  };
  const search = async text => {
    await doc().focus("#search-input");
    await doc().$eval("#search-input", (box, value) => { box.value = value; }, text);
    await tab.keyboard.press("Enter");
    await doc().waitForFunction(() => document.querySelector("hachidori-host"), { timeout: 10000 });
    await sleep(1200);
  };
  for (const [name, patch, media] of [
    ["light", { popupTheme: "auto" }, [{ name: "prefers-color-scheme", value: "light" }]],
    ["dark", { popupTheme: "auto" }, [{ name: "prefers-color-scheme", value: "dark" }]],
    ["default", { popupTheme: "default" }, []],
    ["high-contrast", { popupTheme: "high-contrast" }, []],
    ["dracula", { popupTheme: "dracula" }, []],
    ["forced-colors", { popupTheme: "default" }, [{ name: "forced-colors", value: "active" }]],
  ]) {
    await writeOptions(patch);
    await tab.emulateMediaFeatures(media.length ? media : [{ name: "prefers-color-scheme", value: "" }, { name: "forced-colors", value: "" }]);
    await open();
    await search("食べる");
    await doc().evaluate(() => document.getElementById("search-input").blur());
    await sleep(300);
    await tab.screenshot({ path: join(OUT, `${name}.png`) });
  }
  await tab.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "" }, { name: "forced-colors", value: "" }]);
  await writeOptions({ popupTheme: "default" });
  // Tab order: focus the box, then Tab and Shift+Tab, naming each focused element.
  const focused = () => doc().evaluate(() => {
    const element = document.activeElement;
    const host = element?.localName === "hachidori-host";
    return host ? "popup control" : `${element?.localName ?? "none"}${element?.id ? `#${element.id}` : ""}`;
  });
  await open();
  await search("食べる");
  await doc().focus("#search-input");
  const forward = [await focused()];
  for (let i = 0; i < 4; i += 1) { await tab.keyboard.press("Tab"); forward.push(await focused()); }
  await doc().focus("#search-input");
  await tab.keyboard.down("Shift"); await tab.keyboard.press("Tab"); await tab.keyboard.up("Shift");
  const back = await focused();
  const outer = await tab.evaluate(() => document.activeElement?.localName ?? "none");
  // The accessibility tree's top: the page title and landmarks a screen reader announces.
  const snapshot = await tab.accessibility.snapshot({ interestingOnly: true });
  const roles = [];
  const walk = (node, depth = 0) => { if (depth < 6) { if (["main", "search", "banner", "heading", "textbox", "button", "Iframe", "RootWebArea", "WebArea", "document"].includes(node.role)) roles.push(`${node.role}:${node.name ?? ""}`); for (const child of node.children ?? []) walk(child, depth + 1); } };
  walk(snapshot);
  console.log(JSON.stringify({ forward, back, outer, roles }));
} finally {
  await browser.close();
}
