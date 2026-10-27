// Scratch runner for test/chrome-headword-pitch.mjs (not committed).
import { pathToFileURL } from "node:url";
const repo = process.argv[2];
const puppeteer = (await import(pathToFileURL(process.env.HACHIDORI_PUPPETEER).href)).default;
const { checkHeadwordPitch } = await import(pathToFileURL(`${repo}/test/chrome-headword-pitch.mjs`).href);
const browser = await puppeteer.launch({ executablePath: process.env.HACHIDORI_CHROME, headless: true,
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"] });
try {
  await checkHeadwordPitch(browser);
  console.log("PASS checkHeadwordPitch");
} catch (error) {
  console.log("FAIL checkHeadwordPitch", error.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
