// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import "../extension/reader-options.js";

const {
  ADVANCED_CAPTURE_TIMING_ENABLED,
  DEFAULT_MEDIA_CAPTURE,
  activeMediaCapture,
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

test("media capture accepts a whole-second recent window and retains dormant advanced settings", () => {
  const value = configured({
    enabled: true,
    timingMode: "page",
    includeAnimation: false,
    historySeconds: 30,
    clipSeconds: 37,
    videoPreset: "compact",
    estimatedOffsetMs: 2000,
    texthooker: { enabled: true, url: "ws://localhost:7275/ws/texthooker", format: "gsm" },
    page: { nativeCues: false, domText: true, autoLearnArea: false },
  });
  assert.deepEqual(validateOptionsPatch({ mediaCapture: value }), {
    mediaCapture: { ...value, texthooker: { ...value.texthooker, url: "ws://localhost:7275/ws/texthooker" } },
  });
  for (const clipSeconds of [1, 5, 10, 37, 60]) {
    assert.equal(validateOptionsPatch({ mediaCapture: configured({ clipSeconds }) })
      .mediaCapture.clipSeconds, clipSeconds);
  }
  for (const url of ["ws://127.0.0.1:7275/", "wss://localhost/ws/texthooker", "ws://[::1]:7275/ws/plaintext"]) {
    assert.equal(normaliseTexthookerUrl(url), url);
  }
  for (const url of ["https://localhost/", "ws://example.test/", "ws://user:secret@localhost/", "ws://localhost/#token"]) {
    assert.equal(normaliseTexthookerUrl(url), null);
  }
});

test("media capture rejects inert output, armed empty texthooker, malformed ranges and unknown properties", () => {
  const invalid = [
    configured({ includeAnimation: false, includeCapturedAudio: false }),
    configured({ texthooker: { enabled: true, url: "", format: "plain" } }),
    configured({ estimatedOffsetMs: 2001 }),
    configured({ historySeconds: 45 }),
    configured({ clipSeconds: 0 }),
    configured({ clipSeconds: 61 }),
    configured({ clipSeconds: 1.5 }),
    { ...configured({}), surprise: true },
    { ...configured({}), page: { ...DEFAULT_MEDIA_CAPTURE.page, selector: "body" } },
  ];
  for (const value of invalid) assert.throws(() => validateOptionsPatch({ mediaCapture: value }));
  assert.deepEqual(normaliseOptions({ mediaCapture: invalid[0] }).mediaCapture, DEFAULT_MEDIA_CAPTURE);
  assert.equal(normaliseOptions({ mediaCapture: invalid[1] }).mediaCapture.texthooker.enabled, false);
});

test("active capture projection keeps advanced timing dormant and bounds history to the recent window", () => {
  const stored = configured({
    timingMode: "auto",
    historySeconds: 60,
    clipSeconds: 37,
    texthooker: { enabled: true, url: "ws://127.0.0.1:7275/ws/texthooker", format: "gsm" },
    page: { nativeCues: true, domText: true, autoLearnArea: true },
  });
  assert.equal(ADVANCED_CAPTURE_TIMING_ENABLED, false);
  assert.deepEqual(activeMediaCapture(stored), {
    ...stored,
    timingMode: "recent",
    historySeconds: 37,
    texthooker: { ...stored.texthooker, enabled: false },
    page: { nativeCues: false, domText: false, autoLearnArea: false },
  });
  assert.deepEqual(normaliseOptions({ mediaCapture: stored }).mediaCapture, stored,
    "stored legacy settings remain available for a future re-enable");
  const options = projectContentOptions({ mediaCapture: stored });
  assert.deepEqual(options.mediaCapture.texthooker, { enabled: false, format: "gsm" });
  assert.deepEqual(options.mediaCapture.page, {
    nativeCues: false,
    domText: false,
    autoLearnArea: false,
  });
});
