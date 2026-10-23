// Settings screenshots for the hachidori-freq PRs: one checkout's unpacked
// extension with a Jiten-like rank list and a CC100-like list without
// frequencyMode installed. Not part of the repository's suites.
//
// node settings-shots.mjs <checkout> <out-dir> <label>
import { mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [checkout, out, label] = process.argv.slice(2);
const require = createRequire(resolve(checkout, "test/tooling/package.json"));
const { default: puppeteer } = await import(require.resolve("puppeteer-core"));
const { buildTitledZip } = await import(pathToFileURL(resolve(checkout, "test/make-fixture.mjs")).href);
const PROFILE = resolve(tmpdir(), `hachidori-freq-settings-shots-${process.pid}`);
mkdirSync(out, { recursive: true });
rmSync(PROFILE, { recursive: true, force: true });

const archives = [
  buildTitledZip("Jiten", { banks: false, frequencyMode: "rank-based", termMeta: [["平均", "freq", 15700]] }),
  buildTitledZip("CC100", { banks: false, termMeta: [["平均", "freq", 26700]] }),
];
const browser = await puppeteer.launch({
  executablePath: process.env.HACHIDORI_CHROME, enableExtensions: true, headless: true, userDataDir: PROFILE,
  args: ["--no-sandbox", "--disable-gpu", "--lang=en-US",
    `--disable-extensions-except=${resolve(checkout, "extension")}`, `--load-extension=${resolve(checkout, "extension")}`],
});
try {
  const worker = await browser.waitForTarget(target => target.type() === "service_worker"
    && target.url().startsWith("chrome-extension://"));
  const id = new URL(worker.url()).host;
  const settings = await browser.newPage();
  await settings.setViewport({ width: 1180, height: 1000, deviceScaleFactor: 1 });
  await settings.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
  await settings.goto(`chrome-extension://${id}/settings.html`, { waitUntil: "domcontentloaded" });
  for (const other of await browser.pages()) if (other.url().endsWith("/startup.html")) await other.close();
  await settings.waitForFunction(async () => (await chrome.runtime.sendMessage({ target: "hoshidicts-offscreen",
    type: "hd_status", requestId: "status" }))?.ready === true, { polling: 200, timeout: 120_000 });
  for (const [index, archive] of archives.entries()) {
    const reply = await settings.evaluate(async (base64, index) => {
      const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
      return chrome.runtime.sendMessage({ target: "hoshidicts-offscreen", type: "hd_import", requestId: `import-${index}`,
        blobUrl: URL.createObjectURL(new Blob([bytes])), fileName: `archive-${index}.zip` });
    }, archive.toString("base64"), index);
    if (!reply?.ok) throw new Error(`import ${index} failed: ${JSON.stringify(reply)}`);
  }
  await settings.evaluate(async () => {
    const { options } = await chrome.storage.local.get("options");
    await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write", requestId: "options",
      baseRevision: options?.revision ?? 0, options: { averageFrequency: true, popupTheme: "light" } });
  });
  await settings.reload({ waitUntil: "domcontentloaded" });
  const shoot = async (hash, control, name, select) => {
    await settings.evaluate(hash => { window.location.hash = hash; }, hash);
    await settings.waitForFunction(id => document.getElementById(id)?.closest("section")?.hidden === false,
      { timeout: 20_000 }, control);
    if (select) {
      await settings.select(`#${control}`, select);
      await new Promise(done => setTimeout(done, 1500));
    }
    const box = await settings.evaluate(id => {
      const group = document.getElementById(id).closest("fieldset");
      group.scrollIntoView({ block: "center", behavior: "instant" });
      const rect = group.getBoundingClientRect();
      return { x: rect.x + window.scrollX, y: rect.y + window.scrollY, width: rect.width, height: rect.height };
    }, control);
    await new Promise(done => setTimeout(done, 500));
    await settings.screenshot({ path: resolve(out, `${label}-${name}.png`), clip: box });
    console.log(`${label}-${name}.png`);
  };
  await shoot("#design", "opt-average-frequency", "design-frequency-labels");
  await shoot("#lookup", "opt-frequency-dictionary", "reading-frequency-sorting");
  await shoot("#lookup", "opt-frequency-dictionary", "reading-frequency-sorting-cc100", "CC100");
} finally {
  await browser.close();
  rmSync(PROFILE, { recursive: true, force: true });
}
