// Main-thread paint submission costs for the production popup backdrop.
// SPDX-License-Identifier: GPL-3.0-or-later
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { arch, cpus, platform } from "node:os";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const require = createRequire(resolve(root, "test/tooling/package.json"));
const puppeteer = require("puppeteer-core");
const { config } = JSON.parse(readFileSync(resolve(root, "test/tooling/package.json"), "utf8"));
const beforeRef = process.argv[2] || "origin/main";
const styles = {
  before: execFileSync("git", ["show", `${beforeRef}:extension/render/reader.css`], { cwd: root, encoding: "utf8" }),
  after: readFileSync(resolve(root, "extension/render/reader.css"), "utf8"),
};
const browser = await puppeteer.launch({
  executablePath: process.env.HACHIDORI_CHROME
    || resolve(root, `test/tmp/browsers/chrome/linux-${config.chrome}/chrome-linux64/chrome`),
  headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-lcd-text"],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 800 });
  await page.setContent('<style>body{color:black;background:white;font:20px sans-serif}</style>'
    + '<p>読谷村の日本語を読む。Text rendering benchmark.</p>'.repeat(200) + "<hachidori-host></hachidori-host>");
  await page.evaluate(() => {
    const shadow = document.querySelector("hachidori-host").attachShadow({ mode: "open" });
    shadow.innerHTML = '<style></style><div class="gsm-hoshidicts-popup" style="left:600px;top:100px;width:400px;height:400px"><p>日本語</p></div>';
  });
  const session = await page.createCDPSession();
  await session.send("Performance.enable");
  const taskDuration = async () => (await session.send("Performance.getMetrics")).metrics.find(item => item.name === "TaskDuration").value;
  const samples = { before: [], after: [] };
  for (let run = 0; run < 5; run++) {
    for (const name of run % 2 ? ["after", "before"] : ["before", "after"]) {
      await page.evaluate(css => document.querySelector("hachidori-host").shadowRoot.querySelector("style").textContent = css, styles[name]);
      const start = await taskDuration();
      await page.evaluate(async () => {
        const popup = document.querySelector("hachidori-host").shadowRoot.querySelector(".gsm-hoshidicts-popup");
        for (let i = 0; i < 40; i++) {
          popup.hidden = i % 2 === 0;
          await new Promise(requestAnimationFrame);
        }
      });
      samples[name].push(Number(((await taskDuration() - start) * 1000).toFixed(3)));
    }
  }
  console.log(JSON.stringify({
    browser: await browser.version(), environment: { platform: platform(), arch: arch(), cpu: cpus()[0].model },
    baseline: execFileSync("git", ["rev-parse", beforeRef], { cwd: root, encoding: "utf8" }).trim(),
    paragraphs: 200, visibilityChanges: 40, repetitions: 5,
    scope: "renderer main-thread TaskDuration in milliseconds; excludes GPU, compositor time and lookup",
    samples,
  }, null, 2));
} finally {
  await browser.close();
}
