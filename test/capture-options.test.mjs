// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import "../extension/reader-options.js";

const {
  DEFAULT_MEDIA_CAPTURE,
  normaliseOptions,
  normaliseTexthookerUrl,
  projectContentOptions,
  validateOptionsPatch,
} = globalThis.HDReaderOptions;

const configured = patch => ({
  ...structuredClone(DEFAULT_MEDIA_CAPTURE),
  ...patch,
  texthooker: { ...DEFAULT_MEDIA_CAPTURE.texthooker, ...patch.texthooker },
  page: { ...DEFAULT_MEDIA_CAPTURE.page, ...patch.page },
});

test("media capture defaults are disabled and normalize into independent nested objects", () => {
  const first = normaliseOptions({}).mediaCapture;
  const second = normaliseOptions({}).mediaCapture;
  assert.deepEqual(first, DEFAULT_MEDIA_CAPTURE);
  assert.notEqual(first, second);
  assert.notEqual(first.texthooker, second.texthooker);
  first.page.domText = false;
  assert.equal(second.page.domText, true);
});

test("media capture accepts only bounded enumerated settings and loopback websocket endpoints", () => {
  const value = configured({
    enabled: true,
    timingMode: "page",
    includeAnimation: false,
    historySeconds: 30,
    clipSeconds: 5,
    videoPreset: "compact",
    estimatedOffsetMs: 2000,
    texthooker: { enabled: true, url: "ws://localhost:7275/ws/texthooker", format: "gsm" },
    page: { nativeCues: false, domText: true, autoLearnArea: false },
  });
  assert.deepEqual(validateOptionsPatch({ mediaCapture: value }), {
    mediaCapture: { ...value, texthooker: { ...value.texthooker, url: "ws://localhost:7275/ws/texthooker" } },
  });
  for (const url of ["ws://127.0.0.1:7275/", "wss://localhost/ws/texthooker", "ws://[::1]:7275/ws/plaintext"]) {
    assert.equal(normaliseTexthookerUrl(url), url);
  }
  for (const url of ["https://localhost/", "ws://example.test/", "ws://user:secret@localhost/", "ws://localhost/#token"]) {
    assert.equal(normaliseTexthookerUrl(url), null);
  }
});

test("media capture validation ignores storage property order without relaxing values", () => {
  const value = configured({
    enabled: true,
    timingMode: "recent",
    texthooker: { enabled: false, url: "", format: "gsm" },
    page: { nativeCues: false, domText: true, autoLearnArea: false },
  });
  const reordered = Object.fromEntries(Object.entries(value).reverse());
  reordered.texthooker = Object.fromEntries(Object.entries(value.texthooker).reverse());
  reordered.page = Object.fromEntries(Object.entries(value.page).reverse());
  assert.deepEqual(validateOptionsPatch({ mediaCapture: reordered }).mediaCapture, value);
  const inherited = Object.create(value);
  assert.throws(() => validateOptionsPatch({ mediaCapture: inherited }));
  const missing = structuredClone(value);
  delete missing.enabled;
  assert.throws(() => validateOptionsPatch({ mediaCapture: missing }));
  const inheritedPage = { ...value, page: Object.create(value.page) };
  assert.throws(() => validateOptionsPatch({ mediaCapture: inheritedPage }));
});

test("media capture rejects inert output, armed empty texthooker, malformed ranges and unknown properties", () => {
  const invalid = [
    configured({ includeAnimation: false, includeCapturedAudio: false }),
    configured({ texthooker: { enabled: true, url: "", format: "plain" } }),
    configured({ estimatedOffsetMs: 2001 }),
    configured({ historySeconds: 45 }),
    configured({ clipSeconds: 8 }),
    { ...configured({}), surprise: true },
    { ...configured({}), page: { ...DEFAULT_MEDIA_CAPTURE.page, selector: "body" } },
  ];
  for (const value of invalid) assert.throws(() => validateOptionsPatch({ mediaCapture: value }));
  assert.deepEqual(normaliseOptions({ mediaCapture: invalid[0] }).mediaCapture, DEFAULT_MEDIA_CAPTURE);
  assert.equal(normaliseOptions({ mediaCapture: invalid[1] }).mediaCapture.texthooker.enabled, false);
});

test("content option projection never exposes the configured texthooker URL", () => {
  const options = projectContentOptions({ mediaCapture: configured({
    texthooker: { enabled: true, url: "ws://127.0.0.1:7275/ws/texthooker", format: "gsm" },
  }) });
  assert.deepEqual(options.mediaCapture.texthooker, { enabled: true, format: "gsm" });
});
