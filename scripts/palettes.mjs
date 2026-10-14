// Palette screenshots of Settings → Add dictionaries for the #578 PR: an archive
// waiting for the engine with Cancel import focused from the keyboard, and the
// batch after Enter on Cancel. Temporary; under ignored test/tmp.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildTitledZip } from "../../make-fixture.mjs";

const require = createRequire(new URL("../../tooling/package.json", import.meta.url));
const { default: puppeteer } = await import(require.resolve("puppeteer-core"));
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const OUT = resolve(ROOT, "test/tmp/screens-578");
const PROFILE = resolve(tmpdir(), `hachidori-palettes-578-${process.pid}`);
mkdirSync(OUT, { recursive: true });
rmSync(PROFILE, { recursive: true, force: true });

const names = ["034-BCCWJ-LUW", "035-CC100", "036-JLPT", "037-Novels", "038-Wikipedia"];
const paths = names.map((title, index) => {
  const path = resolve(OUT, `${title}.zip`);
  writeFileSync(path, buildTitledZip(title, { banks: false, revision: `r${index}`,
    termMeta: Array.from({ length: 20_000 }, (_, row) => [`語${row}`, "freq", { value: row + 1 }]) }));
  return path;
});
const holder = buildTitledZip("Held import", { revision: "1",
  termMeta: Array.from({ length: 400_000 }, (_, row) => [`語${row}`, "freq", { value: row + 1 }]) }).toString("base64");
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
  const worker = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"));
  const id = new URL(worker.url()).host;
  const settingsUrl = `chrome-extension://${id}/settings.html#add-dictionaries`;
  const page = await browser.newPage();
  await page.setViewport({ width: 1180, height: 900, deviceScaleFactor: 1 });
  const cdp = await page.createCDPSession();
  const emulate = (forced) => cdp.send("Emulation.setEmulatedMedia", { features: [
    { name: "prefers-reduced-motion", value: "reduce" }, { name: "prefers-color-scheme", value: "dark" },
    ...(forced ? [{ name: "forced-colors", value: "active" }] : []),
  ] });
  const helper = await browser.newPage();
  await helper.goto(`chrome-extension://${id}/settings.html`, { waitUntil: "domcontentloaded" });
  for (const other of await browser.pages()) if (other.url().endsWith("/startup.html")) await other.close();
  const status = () => helper.evaluate(() => chrome.runtime.sendMessage({ target: "hoshidicts-offscreen",
    type: "hd_status", requestId: "palette-status" }));
  const idle = async () => {
    for (;;) {
      const reply = await status();
      if (reply?.ready === true && reply.mutating !== true) return;
      await new Promise((done) => { setTimeout(done, 100); });
    }
  };
  const results = [];
  for (const palette of PALETTES) {
    await idle();
    await helper.evaluate(async (theme) => {
      const { options } = await chrome.storage.local.get("options");
      const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
        baseRevision: options?.revision ?? 0, options: { popupTheme: theme } });
      if (!reply?.ok) throw new Error(reply?.error ?? "options write failed");
    }, palette.id);
    await emulate(palette.forced === true);
    await page.goto(settingsUrl, { waitUntil: "domcontentloaded" });
    await page.waitForFunction((theme) => document.documentElement.dataset.hoshidictsTheme === theme
      && !("hoshidictsThemePending" in document.documentElement.dataset), {}, palette.id);
    await page.waitForFunction(() => !document.getElementById("import-file").disabled);
    // Another page's imports hold the engine, as a second tab or an update would.
    void helper.evaluate(async (base64) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const blobUrl = URL.createObjectURL(new Blob([bytes]));
      await Promise.all(Array.from({ length: 6 }, (_, round) => chrome.runtime.sendMessage({ target: "hoshidicts-offscreen",
        type: "hd_import", requestId: `held-${round}`, blobUrl, fileName: "Held import.zip" })));
    }, holder);
    await helper.waitForFunction(async () => (await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen",
      type: "hd_status", requestId: "held" }))?.mutating === true, { polling: 20 });
    await (await page.$("#import-file")).uploadFile(...paths);
    await page.waitForFunction(() => document.querySelector("#import-progress .setup-dictionary-status")
      ?.textContent.startsWith("Waiting for the previous import to finish"), { polling: 20, timeout: 60_000 });
    await page.bringToFront();
    // From the file chooser, Tab reaches Cancel import with keyboard focus.
    await page.focus("#import-file");
    await page.keyboard.press("Tab");
    const focused = await page.evaluate(() => ({ id: document.activeElement?.id,
      visible: document.activeElement?.matches(":focus-visible") === true }));
    const section = await page.$("#add-dictionaries");
    const box = await section.boundingBox();
    const clip = { x: box.x, y: box.y, width: box.width, height: Math.min(box.height, 420) };
    await page.screenshot({ path: resolve(OUT, `waiting-${palette.label}.png`), clip });
    // Enter on Cancel ends the wait; focus moves to the file chooser.
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.getElementById("import-state").textContent.startsWith("Import cancelled"),
      { polling: 20, timeout: 60_000 });
    const after = await page.evaluate(() => ({ state: document.getElementById("import-state").textContent,
      focus: document.activeElement?.id, cancelHidden: document.getElementById("import-cancel").hidden }));
    if (palette.label === "dark") await page.screenshot({ path: resolve(OUT, "cancelled-dark.png"), clip });
    results.push({ palette: palette.label, focused, after });
  }
  console.log(JSON.stringify(results, null, 1));
} finally {
  await browser.close();
  rmSync(PROFILE, { recursive: true, force: true });
}
