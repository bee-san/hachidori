// Probe I: how long one Right / Down press takes synchronously in the searched text (rowKey with a
// fresh textRows layout of the whole text node per press), for texts of 100 to 20,000 characters.
// The audit's probe I, with the first press timed apart from the later ones and
// a second's pause after each search, so the first press does not also pay for
// the popup's layout. PROBE_ROOT=<checkout> node probe-longtext.mjs
import { start } from "./probe-harness.mjs";

const out = { samples: [] };
const h = await start({ name: "longtext" });
try {
  const { frame } = await h.openSearch("longtext");
  for (const length of [100, 1_000, 5_000, 20_000]) {
    const text = "漢字読むありがとう食べる。".repeat(Math.ceil(length / 13)).slice(0, length);
    // A paste outside a text field searches any length (the Clipboard monitor stops at 1,000).
    await frame.evaluate((value) => {
      const data = new DataTransfer();
      data.setData("text/plain", value);
      document.body.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    }, text);
    await frame.waitForFunction(value => document.getElementById("search-query").textContent.length === value,
      { polling: 50, timeout: 30_000 }, text.length);
    await new Promise(done => setTimeout(done, 1000));
    const timing = await frame.evaluate(async () => {
      const query = document.getElementById("search-query");
      query.focus();
      const press = (key) => {
        const started = performance.now();
        query.dispatchEvent(new KeyboardEvent("keydown", { key, code: key, bubbles: true, cancelable: true }));
        return performance.now() - started;
      };
      const right = [];
      const down = [];
      for (let index = 0; index < 5; index += 1) {
        right.push(press("ArrowRight"));
        await new Promise(done => setTimeout(done, 30));
      }
      for (let index = 0; index < 3; index += 1) {
        down.push(press("ArrowDown"));
        await new Promise(done => setTimeout(done, 30));
      }
      const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
      return { firstRightMs: +right[0].toFixed(2), rightMs: +median(right.slice(1)).toFixed(2), downMs: +median(down).toFixed(2) };
    });
    out.samples.push({ characters: text.length, ...timing });
  }
} catch (error) {
  out.error = String(error?.stack ?? error);
} finally {
  console.log(JSON.stringify(out, null, 1));
  await h.close();
}
