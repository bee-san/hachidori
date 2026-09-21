// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const { JSDOM } = require(require.resolve("jsdom", { paths: [process.env.HACHIDORI_JSDOM
  || resolve(process.env.XDG_CACHE_HOME || resolve(homedir(), ".cache"), "hachidori-e2e")] }));
const source = file => readFileSync(new URL(`../extension/${file}`, import.meta.url), "utf8");

function fixture(t) {
  const dom = new JSDOM("<!doctype html><title>host</title>", {
    pretendToBeVisual: true,
    runScripts: "outside-only",
    url: "https://overlay.test/",
  });
  t.after(() => dom.window.close());
  dom.window.eval(source("external-links.js"));
  dom.window.eval(source("external-link-host.js"));
  return dom.window;
}

test("overlay host requests carry one normalized URL and resolve only their matching result", async t => {
  const window = fixture(t);
  const requests = [];
  window.addEventListener(window.HDExternalLinkHost.REQUEST_EVENT, event => {
    requests.push(structuredClone(event.detail));
    window.dispatchEvent(new window.CustomEvent(window.HDExternalLinkHost.RESULT_EVENT, {
      detail: { requestId: "unrelated", ok: true },
    }));
    window.dispatchEvent(new window.CustomEvent(window.HDExternalLinkHost.RESULT_EVENT, {
      detail: { requestId: event.detail.requestId, ok: true },
    }));
  });
  const opened = await window.HDExternalLinkHost.open(window, {
    url: " HTTPS://EXAMPLE.TEST:443/辞書?q=蜂%20%26%20犬 ",
    active: false,
  });
  assert.equal(opened.opened, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://example.test/%E8%BE%9E%E6%9B%B8?q=%E8%9C%82%20%26%20%E7%8A%AC");
  assert.equal(requests[0].active, false);
  assert.equal(typeof requests[0].requestId, "string");
  assert.ok(requests[0].requestId.length > 0);
});

test("overlay host errors and missing replies reject without retrying", async t => {
  const window = fixture(t);
  let requests = 0;
  const fail = event => {
    requests += 1;
    window.dispatchEvent(new window.CustomEvent(window.HDExternalLinkHost.RESULT_EVENT, {
      detail: { requestId: event.detail.requestId, ok: false, error: "desktop opener failed" },
    }));
  };
  window.addEventListener(window.HDExternalLinkHost.REQUEST_EVENT, fail);
  await assert.rejects(
    window.HDExternalLinkHost.open(window, { url: "https://example.test/", active: true }),
    /desktop opener failed/u,
  );
  assert.equal(requests, 1);
  window.removeEventListener(window.HDExternalLinkHost.REQUEST_EVENT, fail);
  await assert.rejects(
    window.HDExternalLinkHost.open(window, { url: "https://example.test/" }, { timeoutMs: 5 }),
    /did not answer/u,
  );
  assert.equal(requests, 1);
});

test("overlay host requests reject unsafe inputs before dispatch", async t => {
  const window = fixture(t);
  let requests = 0;
  window.addEventListener(window.HDExternalLinkHost.REQUEST_EVENT, () => { requests += 1; });
  for (const value of [
    { url: "javascript:alert(1)" },
    { url: "file:///tmp/unsafe" },
    { url: "https:example.test/" },
    { url: "https://user:pass@example.test/" },
    { url: "\nhttps://example.test/" },
    { url: "https://example.test/", active: "yes" },
  ]) {
    await assert.rejects(window.HDExternalLinkHost.open(window, value));
  }
  assert.equal(requests, 0);
});
