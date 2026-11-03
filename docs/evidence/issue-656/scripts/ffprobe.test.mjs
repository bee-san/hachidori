import { test } from "node:test";
const session = await import("/home/skerraut/herd-synth3/clones/hachi-issue-656/test/firefox-e2e/session.mjs");
test("probe", async () => {
  await session.startSession();
  const out = await session.evaluateJson(session.page, async () => {
    const sizes = [[0, 0], [50, 50], [200, 200], [600, 640], [1600, 1200], [100000, 100000], [2147483647, 2147483647], [2147483648, 2147483648]];
    const results = [{ screen: [screen.width, screen.height, screen.availWidth, screen.availHeight] }];
    for (const [width, height] of sizes) {
      try {
        const created = await chrome.windows.create({ url: "about:blank", type: "popup", width, height });
        await new Promise(r => setTimeout(r, 300));
        const got = await chrome.windows.get(created.id);
        results.push({ asked: [width, height], created: [created.width, created.height], got: [got.width, got.height] });
        await chrome.windows.remove(created.id);
      } catch (error) { results.push({ asked: [width, height], error: String(error) }); }
    }
    return JSON.stringify(results);
  });
  for (const row of out) console.log("PROBE", JSON.stringify(row));
});
