// SPDX-License-Identifier: GPL-3.0-or-later
import { createAnkiMiningService } from "./anki-mining.js";
import { enrichAnkiNote } from "./anki-enrichment.js";
import { ankiTemplateMarkerNames } from "./anki-templates.js";
import { MAX_ANIMATED_AVIF_BYTES } from "./avif-sequence.js";
import { MAX_WAV_BYTES } from "./capture-buffer.js";

const CAPTURE_FILENAMES = {
  animation: /^hachidori-[a-z0-9]+\.avif$/u,
  audio: /^hachidori-[a-z0-9]+\.wav$/u,
};
const CAPTURE_LIMITS = {
  animation: MAX_ANIMATED_AVIF_BYTES,
  audio: MAX_WAV_BYTES,
};

function assertCapturePin(pin) {
  if (!pin || typeof pin !== "object"
      || typeof pin.token !== "string" || !pin.token || pin.token.length > 256
      || typeof pin.captureSessionId !== "string" || !pin.captureSessionId || pin.captureSessionId.length > 256
      || !["texthooker", "cue", "dom", "recent"].includes(pin.sourceKind)
      || typeof pin.sourceLabel !== "string" || !pin.sourceLabel || pin.sourceLabel.length > 100
      || typeof pin.partial !== "boolean"
      || !Number.isFinite(pin.readyAtMs)
      || !CAPTURE_FILENAMES.animation.test(pin.animationFilename)
      || !CAPTURE_FILENAMES.audio.test(pin.audioFilename)) {
    throw new Error("The captured-media pin is invalid or expired. Look up the text again.");
  }
}

function decodedBase64Length(value) {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0
      || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) return null;
  if (value.endsWith("==")) return value.length / 4 * 3 - 2;
  const padding = Number(value.endsWith("="));
  return value.length / 4 * 3 - padding;
}

function validateCapture({ request, prepared, capture: selected }) {
  const media = prepared.config.mediaCapture;
  if (!media?.enabled) throw new Error("Enable media capture in Settings before using captured-media markers.");
  if (selected.requirements.includeAnimation && !media.includeAnimation) {
    throw new Error("This note maps captured animation, but animation capture is disabled.");
  }
  if (selected.requirements.includeAudio && !media.includeCapturedAudio) {
    throw new Error("This note maps captured audio, but captured-audio output is disabled.");
  }
  assertCapturePin(request.capturePin);
}

export function createAnkiWorkerService({
  gateway,
  readOptions,
  readDictionaries,
  engine,
  offscreen,
  capture = null,
  maturityCache,
}) {
  const confirmedCaptureUploads = new Map();

  async function currentGeneration(request) {
    const status = await engine({ type: "hd_status" });
    if (!status.ready || status.loading || status.generation !== request.generation) {
      throw new Error("The dictionary generation changed or is being updated. Look up this result again before adding it.");
    }
  }
  const audio = (request, config) => offscreen({ type: "hd_anki_audio", term: request.term,
    selection: request.audioSelection, sources: config.audioSources });
  const render = (request, templates, audio, resources) => offscreen({ type: "hd_anki_fields", request, templates, audio,
    dictionaryPaths: resources.dictionaryPaths });

  async function captureRequest(type, fields) {
    if (typeof capture !== "function") throw new Error("The captured-media host is unavailable.");
    const reply = await capture({ type, ...fields });
    if (!reply || reply.ok === false) throw new Error(reply?.error || "The captured-media host did not reply.");
    return reply;
  }

  async function uploadCaptureAsset(kind, expectedFilename, metadata, { request, invoke }) {
    if (!metadata || metadata.filename !== expectedFilename
        || !Number.isSafeInteger(metadata.byteLength) || metadata.byteLength < 1
        || metadata.byteLength > CAPTURE_LIMITS[kind]) {
      throw new Error(`The encoded captured ${kind} is invalid or exceeds its size limit.`);
    }
    const uploadKey = `${request.captureJobId}:${kind}`;
    if (confirmedCaptureUploads.get(uploadKey) === expectedFilename) return;
    const asset = await captureRequest("hd_capture_asset", { jobId: request.captureJobId, kind });
    const byteLength = decodedBase64Length(asset.data);
    if (asset.filename !== expectedFilename || byteLength !== metadata.byteLength
        || byteLength > CAPTURE_LIMITS[kind]) {
      throw new Error(`The captured ${kind} payload changed during preparation.`);
    }
    await currentGeneration(request);
    const stored = await invoke("storeMediaFile", {
      filename: expectedFilename,
      data: asset.data,
      deleteExisting: false,
    }, 30_000);
    if (stored !== expectedFilename) {
      throw new Error(`Anki stored the captured ${kind} under a different filename.`);
    }
    confirmedCaptureUploads.set(uploadKey, expectedFilename);
  }

  async function prepareCapture(context) {
    const { appliedFields, capture: selected, request } = context;
    await currentGeneration(request);
    if (!selected) return null;
    assertCapturePin(request.capturePin);
    if (typeof request.captureJobId !== "string" || !request.captureJobId || request.captureJobId.length > 256) {
      throw new Error("Encode the pinned clip before submitting this note.");
    }
    const status = await captureRequest("hd_capture_job_status", { jobId: request.captureJobId });
    if (status.state === "finishing") throw new Error("The selected clip is still finishing.");
    if (status.state === "encoding") throw new Error("The selected clip is still encoding.");
    if (status.state !== "ready") throw new Error(status.error || "The selected clip could not be encoded.");

    const kinds = [
      ["animation", "includeAnimation", request.capturePin.animationFilename],
      ["audio", "includeAudio", request.capturePin.audioFilename],
    ];
    for (const [kind, requirement, expectedFilename] of kinds) {
      if (!selected.requirements[requirement]) continue;
      if (!Object.values(appliedFields).some(value => value.includes(expectedFilename))) {
        throw new Error(`The applied note fields do not reference the captured ${kind}.`);
      }
      await uploadCaptureAsset(kind, expectedFilename, status.assets?.[kind], context);
    }
    return {
      captureJobId: request.captureJobId,
      warnings: Array.isArray(status.warnings)
        ? status.warnings.filter(value => typeof value === "string").map(value => value.slice(0, 500)) : [],
    };
  }

  async function completeCapture({ writeResources }) {
    const jobId = writeResources?.captureJobId;
    if (!jobId) return;
    await captureRequest("hd_capture_complete", { jobId });
    for (const key of confirmedCaptureUploads.keys()) {
      if (key.startsWith(`${jobId}:`)) confirmedCaptureUploads.delete(key);
    }
  }

  async function beforeMutation({ request, writeResources }) {
    await currentGeneration(request);
    if (!writeResources?.captureJobId) return;
    const status = await captureRequest("hd_capture_job_status", { jobId: writeResources.captureJobId });
    if (status.state !== "ready") throw new Error(status.error || "The captured-media export was cancelled or expired.");
  }

  const mining = createAnkiMiningService({ gateway,
    readConfig: async () => {
      const options = await readOptions();
      return {
        ...options.anki,
        audioSources: options.audioSources.filter(source => source.enabled),
        mediaCapture: options.mediaCapture,
      };
    },
    buildFields: async (request, current) => {
      if (!Number.isSafeInteger(request?.generation) || request.generation < 0
          || typeof request.term?.expression !== "string" || !request.term.expression
          || typeof request.term.reading !== "string") throw new Error("Mining requires a current dictionary result.");
      await currentGeneration(request);
      const dictionaries = await readDictionaries();
      const resources = { dictionaryPaths: Object.fromEntries(dictionaries.filter(item => item.enabled !== false)
        .map(item => [item.title, item.path])), audioPrepared: false, audio: null };
      const first = current.resolved.templates[current.discovery.fields[0]];
      if (ankiTemplateMarkerNames(first.value).includes("audio")) {
        resources.audioPrepared = true;
        // Audio in the first field is part of Anki's duplicate identity. A
        // failed/stale selection must not turn that identity into text-only.
        resources.audio = await audio(request, current.config);
      }
      const built = await render(request, current.resolved.templates, resources.audio ? `[sound:${resources.audio.filename}]` : "", resources);
      return { ...resources, ...built };
    },
    validateCapture,
    beforeWrite: prepareCapture,
    beforeMutation,
    afterConfirmed: completeCapture,
    enrich: context => enrichAnkiNote(context, { audio, render, media: async (item, generation) => {
      const reply = await engine({ type: "hd_media", dictionary: item.dictionary, path: item.path, generation });
      if (!reply.dataUrl) throw new Error("The dictionary image is no longer available.");
      return reply.dataUrl.slice(reply.dataUrl.indexOf(",") + 1);
    } }),
  });
  return { ...mining, async maturity(request) {
    try {
      const options = await readOptions();
      return { mature: options.definitionBlurAnkiMature === true
        && await maturityCache.has(options.anki, request?.term?.expression) };
    } catch {
      // Missing local evidence never prevents dictionary lookup.
      return { mature: false };
    }
  } };
}
