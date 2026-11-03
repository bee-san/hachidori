// Probe for #656 (not committed to main): the search page header in Firefox
// with a long Template name: the lines of the title and the Clipboard monitor
// label in the frame, and the menu's width, at several widths.
import { test } from "node:test";
const session = await import("/home/skerraut/herd-synth3/clones/hachi-issue-656/test/firefox-e2e/session.mjs");
test("probe", async () => {
  await session.startSession();
  await session.writeOptions(session.page, { anki: await session.evaluateJson(session.page, async () => {
    const { options } = await chrome.storage.local.get("options");
    const anki = globalThis.HDReaderOptions.normaliseOptions(options).anki;
    return JSON.stringify(globalThis.HDReaderOptions.normaliseAnki({ url: anki.url, apiKey: anki.apiKey, templates: [
      { ...anki.templates[0], name: "Sentences with audio and a picture" }, { ...anki.templates[0], id: "words", name: "Words" }] }));
  }) });
  for (const width of [600, 512, 480, 420]) {
    await session.evaluateJson(session.page, async (w) => {
      const url = chrome.runtime.getURL("search.html");
      for (const context of await chrome.runtime.getContexts({ contextTypes: ["TAB"], documentUrls: [url] })) {
        await chrome.windows.remove(context.windowId).catch(() => {});
      }
      await chrome.windows.create({ url, type: "popup", width: w, height: 640 });
      return "null";
    }, width);
    await session.sleep(2500);
    const search = await session.findPage("search.html");
    const frame = await session.childFrame(search, "search-frame.html");
    await session.waitFor(() => frame.evaluate(() => !document.querySelector("select.search-template").hidden || false), { timeout: 15000 });
    const copy = await frame.evaluate(() => {
      const lines = (element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        return new Set([...range.getClientRects()].map(rect => Math.round(rect.top))).size;
      };
      const select = document.querySelector("select.search-template");
      return { width: Math.round(select.getBoundingClientRect().width), left: Math.round(select.getBoundingClientRect().left),
        lines: [lines(document.querySelector(".search-header h1")), lines(document.querySelector(".search-header .lookup-enable span"))] };
    });
    const shell = await session.evaluateJson(search, () => JSON.stringify({
      width: Math.round(document.getElementById("search-template").getBoundingClientRect().width),
      left: Math.round(document.getElementById("search-template").getBoundingClientRect().left),
      right: Math.round(document.querySelector(".search-shell-header .lookup-enable").getBoundingClientRect().right),
      viewport: innerWidth }));
    console.log("PROBE", width, JSON.stringify({ copy, shell }));
  }
});
