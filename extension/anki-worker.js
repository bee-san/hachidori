// SPDX-License-Identifier: GPL-3.0-or-later
import { createAnkiMiningService } from "./anki-mining.js";
import { enrichAnkiNote } from "./anki-enrichment.js";
import { ankiTemplateMarkerNames } from "./anki-templates.js";

export function createAnkiWorkerService({ gateway, readOptions, readDictionaries, engine, offscreen }) {
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
  return createAnkiMiningService({ gateway,
    readConfig: async () => {
      const options = await readOptions();
      return { ...options.anki, audioSources: options.audioSources.filter(source => source.enabled) };
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
    beforeWrite: currentGeneration,
    enrich: context => enrichAnkiNote(context, { audio, render, media: async (item, generation) => {
      const reply = await engine({ type: "hd_media", dictionary: item.dictionary, path: item.path, generation });
      if (!reply.dataUrl) throw new Error("The dictionary image is no longer available.");
      return reply.dataUrl.slice(reply.dataUrl.indexOf(",") + 1);
    } }),
  });
}
