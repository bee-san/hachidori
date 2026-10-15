// Palette screenshots of Settings → Dictionaries → Updates for #565: the list of
// available updates and failures, with a row action focused from the keyboard.
// The real extension in Chrome for Testing 152; three fixture dictionaries get a
// managed source and a recorded check result (no network). Temporary, local only.
// Usage: node capture-565.mjs <repo worktree> <output dir>
import { mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [ROOT, OUT] = process.argv.slice(2).map(path => resolve(path));
const require = createRequire(resolve(ROOT, "test/tooling/package.json"));
const { default: puppeteer } = await import(require.resolve("puppeteer-core"));
const { buildTitledZip } = await import(pathToFileURL(resolve(ROOT, "test/make-fixture.mjs")).href);
const PROFILE = resolve(tmpdir(), `hachidori-capture-565-${process.pid}`);
mkdirSync(OUT, { recursive: true });
rmSync(PROFILE, { recursive: true, force: true });

const DICTIONARIES = [
  { title: "Jitendex", check: { status: "update-available", remoteRevision: "2026.10.14", error: null } },
  { title: "JMnedict", check: { status: "update-available", remoteRevision: "2026-10-12",
    error: "archive request failed with HTTP 502" } },
  { title: "Kanjium pitch accents", check: { status: "check-failed", remoteRevision: null,
    error: "update index request failed with HTTP 503" } },
];
const PALETTES = [
  { id: "default", label: "dark" },
  { id: "light", label: "light" },
  { id: "high-contrast", label: "high-contrast" },
  { id: "default", label: "forced-colors-dark", forced: true },
];

const browser = await puppeteer.launch({
  executablePath: resolve(ROOT, "test/tmp/browsers/chrome/linux-152.0.7977.75/chrome-linux64/chrome"),
  enableExtensions: true, headless: true, userDataDir: PROFILE,
  args: ["--no-sandbox", "--disable-gpu", `--disable-extensions-except=${resolve(ROOT, "extension")}`,
    `--load-extension=${resolve(ROOT, "extension")}`],
});
try {
  const worker = await browser.waitForTarget(t => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"));
  const id = new URL(worker.url()).host;
  const helper = await browser.newPage();
  await helper.goto(`chrome-extension://${id}/settings.html`, { waitUntil: "domcontentloaded" });
  for (const other of await browser.pages()) if (other.url().endsWith("/startup.html")) await other.close();
  const send = (target, type, fields = {}) => helper.evaluate((target, type, fields) =>
    chrome.runtime.sendMessage({ target, type, requestId: `capture-${type}-${Date.now()}`, ...fields }), target, type, fields);
  for (;;) {
    const status = await send("hoshidicts-offscreen", "hd_status");
    if (status?.ready === true && status.mutating !== true) break;
    await new Promise(done => { setTimeout(done, 100); });
  }
  // Import the three dictionaries, one at a time, as Settings does.
  for (const { title } of DICTIONARIES) {
    const base64 = buildTitledZip(title, { revision: "2026-10-01" }).toString("base64");
    const reply = await helper.evaluate(async (base64, title) => {
      const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
      const blobUrl = URL.createObjectURL(new Blob([bytes]));
      return chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_import",
        requestId: `capture-import-${title}`, blobUrl, fileName: `${title}.zip` });
    }, base64, title);
    if (!reply?.ok || !reply.report?.success) throw new Error(`import ${title}: ${JSON.stringify(reply)}`);
  }
  // Give each a managed source and the check result Updates lists.
  const applied = await helper.evaluate(async (dictionaries) => {
    const { dictionaryState: current } = await chrome.storage.local.get("dictionaryState");
    const byTitle = new Map(dictionaries.map(entry => [entry.title, entry]));
    return chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_apply_state",
      requestId: "capture-apply-state", baseRevision: current.revision,
      dictionaries: current.dictionaries.map((dictionary) => {
        const entry = byTitle.get(dictionary.title);
        if (!entry) return dictionary;
        const slug = entry.title.toLowerCase().replaceAll(" ", "-");
        return { ...dictionary, isUpdatable: true,
          indexUrl: `https://dictionaries.example/${slug}/index.json`,
          downloadUrl: `https://dictionaries.example/${slug}/${slug}.zip`,
          lastUpdateCheck: { checkedAt: "2026-10-15T05:00:00Z", ...entry.check } };
      }) });
  }, DICTIONARIES);
  if (!applied?.ok) throw new Error(`apply state: ${JSON.stringify(applied)}`);

  const page = await browser.newPage();
  await page.setViewport({ width: 1180, height: 1000, deviceScaleFactor: 1 });
  const cdp = await page.createCDPSession();
  const results = [];
  for (const palette of PALETTES) {
    await helper.evaluate(async (theme) => {
      const { options } = await chrome.storage.local.get("options");
      const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
        baseRevision: options?.revision ?? 0, options: { popupTheme: theme } });
      if (!reply?.ok) throw new Error(reply?.error ?? "options write failed");
    }, palette.id);
    await cdp.send("Emulation.setEmulatedMedia", { features: [
      { name: "prefers-reduced-motion", value: "reduce" }, { name: "prefers-color-scheme", value: "dark" },
      ...(palette.forced ? [{ name: "forced-colors", value: "active" }] : []),
    ] });
    await page.goto(`chrome-extension://${id}/settings.html#updates`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(theme => document.documentElement.dataset.hoshidictsTheme === theme
      && !("hoshidictsThemePending" in document.documentElement.dataset), {}, palette.id);
    await page.waitForFunction(() => document.querySelectorAll("#update-dictionary-list > li").length === 3
      && !document.getElementById("update-check-now").disabled);
    // Keyboard focus on the first row's action (Update), as Tab from Update all reaches it.
    const tabs = await page.evaluate(() => {
      const first = document.querySelector("#update-dictionary-list .update-dictionary-action");
      const all = [...document.querySelectorAll("a[href], button, input, select, textarea, summary, [tabindex]")]
        .filter(element => !element.disabled && element.tabIndex >= 0 && element.checkVisibility());
      const from = all.indexOf(document.getElementById("update-all"));
      return { from, to: all.indexOf(first) };
    });
    await page.focus("#update-all");
    for (let step = tabs.from; step < tabs.to; step++) await page.keyboard.press("Tab");
    const state = await page.evaluate(() => ({
      focused: document.activeElement?.getAttribute("aria-label"),
      focusVisible: document.activeElement?.matches(":focus-visible") === true,
      summary: document.getElementById("update-list-summary").textContent,
      rows: [...document.querySelectorAll("#update-dictionary-list > li")].map(row => row.innerText.replace(/\s+/gu, " ").trim()),
    }));
    const group = await page.evaluateHandle(() => document.getElementById("update-dictionary-list").closest(".lookup-group"));
    const box = await group.boundingBox();
    const scroll = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
    await page.screenshot({ path: resolve(OUT, `updates-${palette.label}.png`),
      clip: { x: box.x + scroll.x - 8, y: box.y + scroll.y - 20, width: box.width + 16, height: box.height + 28 } });
    results.push({ palette: palette.label, ...state });
  }
  console.log(JSON.stringify(results, null, 1));
} finally {
  await browser.close();
  rmSync(PROFILE, { recursive: true, force: true });
}
