import { createRequire } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const [REPO, EXTENSION] = process.argv.slice(2);
const require = createRequire(join(REPO, "test/tooling/package.json"));
const puppeteer = require("puppeteer-core");
const UUID = "11111111-2222-4333-8444-555555555555";
const browser = await puppeteer.launch({ browser: "firefox", executablePath: process.env.HACHIDORI_FIREFOX, headless: true,
  userDataDir: mkdtempSync(join(tmpdir(), "hd644ff-")), env: { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: "1" },
  extraPrefsFirefox: { "extensions.webextensions.uuids": JSON.stringify({ "ffproto@test": UUID }) } });
const logs = [];
try {
  const [first] = await browser.pages();
  const session = first.mainFrame().browsingContext.userContext.browser.session;
  session.on("log.entryAdded", entry => logs.push(`[${entry.level}] ${entry.text}`));
  await session.send("session.subscribe", { events: ["log.entryAdded"] });
  await browser.installExtension(EXTENSION);
  const page = await browser.newPage();
  await session.send("browsingContext.navigate", { context: page.mainFrame().browsingContext.id, url: `moz-extension://${UUID}/shell.html`, wait: "none" });
  await new Promise(r => setTimeout(r, 4000));
  console.log(JSON.stringify(await page.evaluate(() => window.results), null, 0));
  console.log("frames:", page.frames().map(f => f.url()));
  const tree = await session.send("browsingContext.getTree", { root: page.mainFrame().browsingContext.id });
  console.log("tree:", JSON.stringify(tree.result.contexts.map(c => ({ url: c.url, children: c.children?.map(k => ({ url: k.url, context: k.context })) }))));
  const child = tree.result.contexts[0].children?.[0];
  if (child) {
    const { result } = await session.send("script.callFunction", { functionDeclaration: "() => JSON.stringify({ href: location.href, origin: self.origin, p: document.getElementById('p')?.textContent })", awaitPromise: true, target: { context: child.context } });
    console.log("child eval:", JSON.stringify(result));
    const { result: sandboxed } = await session.send("script.callFunction", { functionDeclaration: "() => typeof report", awaitPromise: true, target: { context: child.context } });
    console.log("child globals:", JSON.stringify(sandboxed));
  }
  console.log(logs.filter(l => !/telemetry|Remote|WebDriver/i.test(l)).slice(-15).join("\n"));
} finally { await browser.close(); }
