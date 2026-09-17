// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { createAnkiMediaStore } from "../extension/anki-media.js";

const filename = (character, extension) => `hachidori_${character.repeat(64)}.${extension}`;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
const WAV = Buffer.from("RIFF\u0000\u0000\u0000\u0000WAVEfmt ", "binary");
const base64 = value => Buffer.from(value).toString("base64");

function ankiInventory(initial = [], store = async ({ filename: stored }) => stored) {
  const files = new Set(initial);
  const calls = [];
  return {
    calls,
    files,
    async invoke(action, params) {
      calls.push({ action, params });
      if (action === "getMediaFilesNames") return files.has(params.pattern) ? [params.pattern] : [];
      if (action === "storeMediaFile") {
        const result = await store(params, files, calls);
        if (result === params.filename) files.add(params.filename);
        return result;
      }
      if (action === "deleteMediaFile") assert.fail("deterministic media must be retained, not deleted");
      throw new Error(`Unexpected ${action}`);
    },
  };
}

test("referenced PNG and nested SVG media are deduplicated and confirmed before use", async () => {
  const png = filename("a", "png");
  const svg = filename("b", "svg");
  const inventory = ankiInventory();
  const loads = [];
  const resources = {
    media: [
      { dictionary: "明鏡", path: "media/unsafe name.png", filename: png },
      { dictionary: "明鏡", path: "media/nested/図版.svg", filename: svg },
      { dictionary: "明鏡", path: "media/nested/図版.svg", filename: svg },
    ],
    audioPrepared: false,
  };
  const payloads = new Map([
    ["media/unsafe name.png", { mime: "image/png", data: PNG.toString("base64") }],
    ["media/nested/図版.svg", {
      mime: "image/svg+xml",
      data: base64(`<svg xmlns="http://www.w3.org/2000/svg">
        <defs><linearGradient id="gradient"/><filter id="filter"/></defs>
        <rect style="fill: url(#gradient)" filter="url('#filter')"/>
        <use href="#shape"/>
      </svg>`),
    }],
  ]);
  const result = await createAnkiMediaStore().prepare({
    request: { generation: 7 },
    invoke: inventory.invoke,
    appliedFields: { Back: `<img src="${png}"><section><img src="${svg}"><img src="${svg}"></section>` },
    resources,
    media: async item => {
      loads.push(item.path);
      return payloads.get(item.path);
    },
    validate: async () => {},
  });
  assert.deepEqual(loads, ["media/unsafe name.png", "media/nested/図版.svg"]);
  assert.deepEqual(result, {
    files: [
      { filename: png, status: "stored", bytes: PNG.length },
      { filename: svg, status: "stored", bytes: Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg">
        <defs><linearGradient id="gradient"/><filter id="filter"/></defs>
        <rect style="fill: url(#gradient)" filter="url('#filter')"/>
        <use href="#shape"/>
      </svg>`,
      ).length },
    ],
    required: 2,
    existing: 0,
    stored: 2,
    uploadedBytes: result.uploadedBytes,
  });
  assert.equal(result.uploadedBytes, PNG.length + result.files[1].bytes);
  assert.deepEqual(resources.confirmedMedia, [png, svg]);
  assert.deepEqual(inventory.calls.map(call => call.action),
    ["getMediaFilesNames", "storeMediaFile", "getMediaFilesNames",
      "getMediaFilesNames", "storeMediaFile", "getMediaFilesNames"]);
});

test("existing media skips dictionary retrieval and upload", async () => {
  const expected = filename("d", "png");
  const inventory = ankiInventory([expected]);
  const result = await createAnkiMediaStore().ensure({
    invoke: inventory.invoke,
    filename: expected,
    kind: "dictionary image",
    load: () => assert.fail("existing media must not be fetched"),
  });
  assert.deepEqual(result, { filename: expected, status: "existing", bytes: 0 });
  assert.deepEqual(inventory.calls.map(call => call.action), ["getMediaFilesNames"]);
});

test("a lost store acknowledgement is accepted only after exact live confirmation", async () => {
  const expected = filename("e", "png");
  const inventory = ankiInventory([], async (params, files) => {
    files.add(params.filename);
    throw new Error("reply lost");
  });
  const result = await createAnkiMediaStore().ensure({
    invoke: inventory.invoke,
    filename: expected,
    kind: "dictionary image",
    data: PNG.toString("base64"),
  });
  assert.deepEqual(result, { filename: expected, status: "confirmed-after-error", bytes: PNG.length });
  assert.deepEqual(inventory.calls.map(call => call.action),
    ["getMediaFilesNames", "storeMediaFile", "getMediaFilesNames"]);
});

test("a wrong returned filename cannot authorize the expected note reference", async () => {
  const expected = filename("f", "png");
  const inventory = ankiInventory([], async () => filename("0", "png"));
  await assert.rejects(createAnkiMediaStore().ensure({
    invoke: inventory.invoke,
    filename: expected,
    kind: "dictionary image",
    data: PNG.toString("base64"),
  }), /different filename/u);
  assert.deepEqual(inventory.calls.map(call => call.action),
    ["getMediaFilesNames", "storeMediaFile", "getMediaFilesNames"]);
  assert.equal(inventory.calls.some(call => call.action === "deleteMediaFile"), false);
});

test("an exact store acknowledgement without live persistence cannot authorize a note reference", async () => {
  const expected = filename("0", "png");
  const calls = [];
  const invoke = async (action, params) => {
    calls.push({ action, params });
    if (action === "getMediaFilesNames") return [];
    if (action === "storeMediaFile") return params.filename;
    throw new Error(`Unexpected ${action}`);
  };
  await assert.rejects(createAnkiMediaStore().ensure({
    invoke,
    filename: expected,
    kind: "dictionary image",
    data: PNG.toString("base64"),
  }), /without confirming the requested media filename/u);
  assert.deepEqual(calls.map(call => call.action),
    ["getMediaFilesNames", "storeMediaFile", "getMediaFilesNames"]);
});

test("partial multi-file failure retains confirmed media and retry reuses it", async () => {
  const first = filename("1", "png");
  const second = filename("2", "png");
  let refuseSecond = true;
  const inventory = ankiInventory([], async (params) => {
    if (params.filename === second && refuseSecond) throw new Error("media folder is read-only");
    return params.filename;
  });
  const resources = {
    media: [
      { dictionary: "Fixture", path: "first.png", filename: first },
      { dictionary: "Fixture", path: "second.png", filename: second },
    ],
    audioPrepared: false,
  };
  const loads = [];
  const prepare = () => createAnkiMediaStore().prepare({
    request: { generation: 3 },
    invoke: inventory.invoke,
    appliedFields: { Back: `<img src="${first}"><img src="${second}">` },
    resources,
    media: async item => {
      loads.push(item.path);
      return { mime: "image/png", data: PNG.toString("base64") };
    },
    validate: async () => {},
  });
  await assert.rejects(prepare(), /1 confirmed media file was retained for a safe retry/u);
  assert.deepEqual([...inventory.files], [first]);
  refuseSecond = false;
  const callsBeforeRetry = inventory.calls.length;
  const retry = await prepare();
  assert.equal(retry.existing, 1);
  assert.equal(retry.stored, 1);
  assert.deepEqual(loads, ["first.png", "second.png", "second.png"]);
  assert.deepEqual(inventory.calls.slice(callsBeforeRetry).map(call => [call.action, call.params.filename ?? call.params.pattern]), [
    ["getMediaFilesNames", first],
    ["getMediaFilesNames", second],
    ["storeMediaFile", second],
    ["getMediaFilesNames", second],
  ]);
});

test("invalid, empty and colliding dictionary media fail before an unsafe write", async t => {
  await t.test("invalid base64", async () => {
    const inventory = ankiInventory();
    await assert.rejects(createAnkiMediaStore().ensure({
      invoke: inventory.invoke,
      filename: filename("3", "png"),
      kind: "dictionary image",
      data: "not base64!",
    }), /not valid base64/u);
    assert.equal(inventory.calls.some(call => call.action === "storeMediaFile"), false);
  });
  await t.test("empty payload", async () => {
    const inventory = ankiInventory();
    await assert.rejects(createAnkiMediaStore().ensure({
      invoke: inventory.invoke,
      filename: filename("4", "png"),
      kind: "dictionary image",
      data: "",
    }), /not valid base64/u);
    assert.equal(inventory.calls.some(call => call.action === "storeMediaFile"), false);
  });
  await t.test("unsafe generated name", async () => {
    const inventory = ankiInventory();
    await assert.rejects(createAnkiMediaStore().ensure({
      invoke: inventory.invoke,
      filename: "../escape.png",
      kind: "dictionary image",
      data: PNG.toString("base64"),
    }), /filename is invalid/u);
    assert.deepEqual(inventory.calls, []);
  });
  await t.test("colliding planned names", async () => {
    const shared = filename("5", "png");
    const inventory = ankiInventory();
    await assert.rejects(createAnkiMediaStore().prepare({
      request: { generation: 1 },
      invoke: inventory.invoke,
      appliedFields: { Back: shared },
      resources: { audioPrepared: false, media: [
        { dictionary: "A", path: "one.png", filename: shared },
        { dictionary: "A", path: "two.png", filename: shared },
      ] },
      media: async () => ({ data: PNG.toString("base64") }),
      validate: async () => {},
    }), /planned the same Anki filename/u);
    assert.deepEqual(inventory.calls, []);
  });
  await t.test("more than 64 referenced files retain the pre-existing uncapped contract", async () => {
    const media = Array.from({ length: 65 }, (_, index) => ({
      dictionary: "A",
      path: `${index}.png`,
      filename: filename(index.toString(16).padStart(2, "0").slice(-1), "png"),
    }));
    // Keep every generated name distinct despite the helper's single repeated
    // character by replacing its digest with the index in hexadecimal.
    media.forEach((item, index) => {
      item.filename = `hachidori_${index.toString(16).padStart(64, "0")}.png`;
    });
    const inventory = ankiInventory(media.map(item => item.filename));
    const result = await createAnkiMediaStore().prepare({
      request: { generation: 1 },
      invoke: inventory.invoke,
      appliedFields: { Back: media.map(item => item.filename).join(" ") },
      resources: { audioPrepared: false, media },
      media: () => assert.fail("pre-existing media must not be loaded"),
      validate: async () => {},
    });
    assert.equal(result.required, 65);
    assert.equal(result.existing, 65);
    assert.equal(result.stored, 0);
    assert.equal(inventory.calls.length, 65);
  });
});

test("generation cancellation after retrieval prevents the store", async () => {
  const expected = filename("6", "png");
  const inventory = ankiInventory();
  let validations = 0;
  await assert.rejects(createAnkiMediaStore().ensure({
    invoke: inventory.invoke,
    filename: expected,
    kind: "dictionary image",
    load: async () => ({ data: PNG.toString("base64") }),
    validate: async () => {
      if (++validations === 3) throw new Error("dictionary generation changed");
    },
  }), /generation changed/u);
  assert.deepEqual(inventory.calls.map(call => call.action), ["getMediaFilesNames"]);
});

test("playable pronunciation keeps the existing unbounded file-size contract", async () => {
  const bytes = Buffer.alloc(16 * 1024 * 1024 + 1);
  WAV.copy(bytes);
  const expected = filename("7", "wav");
  const inventory = ankiInventory();
  const result = await createAnkiMediaStore().ensure({
    invoke: inventory.invoke,
    filename: expected,
    kind: "pronunciation",
    data: bytes.toString("base64"),
  });
  assert.equal(result.status, "stored");
  assert.equal(result.bytes, bytes.length);
});

test("browser-decoded pronunciation keeps legal leading bytes and existing long extensions", async () => {
  const expected = filename("8", "verylongaudioextension");
  const inventory = ankiInventory();
  const bytes = Buffer.from("leading metadata and container boxes accepted by the browser decoder");
  const result = await createAnkiMediaStore().ensure({
    invoke: inventory.invoke,
    filename: expected,
    kind: "pronunciation",
    data: bytes.toString("base64"),
  });
  assert.equal(result.status, "stored");
  assert.equal(result.bytes, bytes.length);
});
