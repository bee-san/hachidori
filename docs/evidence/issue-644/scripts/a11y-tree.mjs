import { createRequire } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const [REPO, EXTENSION] = process.argv.slice(2);
const require = createRequire(join(REPO, "test/tooling/package.json"));
const puppeteer = require("puppeteer-core");
const browser = await puppeteer.launch({ executablePath: process.env.HACHIDORI_CHROME, enableExtensions: true, headless: true,
  userDataDir: mkdtempSync(join(tmpdir(), "hd644t11y-")),
  args: ["--no-sandbox", "--disable-gpu", `--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`] });
try {
  const sw = await browser.waitForTarget(t => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"));
  const id = new URL(sw.url()).host;
  const tab = await browser.newPage();
  await tab.goto(`chrome-extension://${id}/search.html`, { waitUntil: "load" });
  await new Promise(r => setTimeout(r, 2500));
  // The full tree through CDP, which includes child frames' nodes.
  const cdp = await tab.createCDPSession();
  await cdp.send("Accessibility.enable");
  const { nodes } = await cdp.send("Accessibility.getFullAXTree", {});
  const named = nodes.filter(n => !n.ignored && ["RootWebArea", "WebArea", "Iframe", "banner", "heading", "search", "textbox", "button", "main", "status"].includes(n.role?.value))
    .map(n => `${n.role.value}:${n.name?.value ?? ""}`);
  const frames = tab.frames().filter(f => f !== tab.mainFrame());
  const inner = [];
  for (const frame of frames) {
    const session = await tab.createCDPSession();
    const tree = await session.send("Accessibility.getFullAXTree", { frameId: frame._id }).catch(e => ({ error: e.message }));
    if (tree.nodes) inner.push(...tree.nodes.filter(n => !n.ignored && ["RootWebArea", "banner", "heading", "search", "textbox", "button", "main", "status"].includes(n.role?.value)).map(n => `${n.role.value}:${n.name?.value ?? ""}`));
    else inner.push(tree.error);
  }
  console.log(JSON.stringify({ top: named, frame: inner }));
} finally { await browser.close(); }
