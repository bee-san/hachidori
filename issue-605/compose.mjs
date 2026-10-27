// Lay the per-headword captures of shots.mjs side by side: main | this branch.
// node compose.mjs <shots dir> <mode> <out.png> "<left label>" "<right label>"
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [dir, mode, out, leftLabel, rightLabel] = process.argv.slice(2);
const puppeteer = (await import(pathToFileURL(process.env.HACHIDORI_PUPPETEER).href)).default;
const main = JSON.parse(readFileSync(join(dir, "main", `${mode}.json`), "utf8"));
const branch = JSON.parse(readFileSync(join(dir, "branch", `${mode}.json`), "utf8"));
const image = file => `data:image/png;base64,${readFileSync(resolve(file)).toString("base64")}`;
const rows = main.map((left, index) => {
  const right = branch[index];
  if (right.expression !== left.expression) throw new Error("row mismatch");
  return `<tr><th scope="row">${left.expression}</th><td><img src="${image(left.file)}" alt=""></td>`
    + `<td><img src="${image(right.file)}" alt=""></td></tr>`;
}).join("");
const html = `<!doctype html><meta charset="utf-8"><style>
body{margin:0;background:#fff;font:15px sans-serif;color:#222}
table{border-collapse:collapse;margin:8px}
th,td{border:1px solid #ccc;padding:4px 12px;text-align:left;vertical-align:middle}
thead th{background:#f3f3f3}
tbody th{font-weight:normal;color:#555}
img{display:block}
</style><table><thead><tr><th>Headword</th><th>${leftLabel}</th><th>${rightLabel}</th></tr></thead><tbody>${rows}</tbody></table>`;
const browser = await puppeteer.launch({ executablePath: process.env.HACHIDORI_CHROME, headless: true,
  args: ["--no-sandbox", "--force-device-scale-factor=1"], defaultViewport: { width: 1200, height: 800, deviceScaleFactor: 1 } });
try {
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: "load" });
  const table = await page.$("table");
  await table.screenshot({ path: out });
  const box = await table.boundingBox();
  console.log(out, Math.ceil(box.width), Math.ceil(box.height));
} finally {
  await browser.close();
}
