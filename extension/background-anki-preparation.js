// Anki preparation runs in the reading document; this worker owns its script
// identity and grants external fetch only while that explicit Add is pending.
// SPDX-License-Identifier: GPL-3.0-or-later
import { createAnkiPreparationService } from "./anki-preparation-service.js";
import { extensionApi as chrome } from "./browser-api.js";
import { OPTIONS_KEY, normaliseOptions } from "./background-core.js";

export const PREPARATION_REQUESTS = new Set(["hd_anki_prepare", "hd_anki_preparation_begin", "hd_anki_preparation_fetch",
  "hd_anki_preparation_finish", "hd_anki_preparation_cancel", "hd_anki_preparation_status"]);
export const ankiPreparation = createAnkiPreparationService({ readScripts: async () =>
  normaliseOptions((await chrome.storage.local.get(OPTIONS_KEY))[OPTIONS_KEY]).userScripts });

export async function handlePreparationRequest(message, sender, { readOptions, readStatus, settingsSender }) {
  if (sender?.id !== chrome.runtime.id) throw new Error("Unknown Anki preparation sender.");
  if (message.type === "hd_anki_preparation_status") {
    if (!settingsSender(sender)) throw new Error("Preparation diagnostics are available only from Settings.");
    return ankiPreparation.diagnostics();
  }
  const request = message.request;
  if (message.type === "hd_anki_preparation_fetch") {
    return { response: await ankiPreparation.request(sender, request.operationId, request.url, request.options) };
  }
  if (message.type === "hd_anki_preparation_finish") {
    return { preparation: await ankiPreparation.finish(sender, request.operationId, request.data) };
  }
  if (message.type === "hd_anki_preparation_cancel") {
    ankiPreparation.cancel(sender, request.operationId);
    return {};
  }
  const options = await readOptions(message.profileId);
  const template = globalThis.HDReaderOptions.ankiTemplateConfig(options.anki, request.templateId);
  if (!template?.preparationScript) throw new Error("This Anki Template has no preparation script.");
  const status = await readStatus(request.templateId, message.profileId);
  if (!status.available || status.configKey !== request.configKey) {
    throw new Error("Anki configuration changed. Refresh this result before adding a note.");
  }
  const script = template.preparationScript;
  if (message.type === "hd_anki_preparation_begin") {
    return { operationId: typeof request.source === "string"
      ? await ankiPreparation.beginDocument(sender, script, request.source)
      : await ankiPreparation.beginNative(sender, script) };
  }
  // The script receives lookup data and the chosen Template's public identity,
  // never a connection/API key, saved field mapping or another script's source.
  const context = { term: request.term, sentence: request.sentence, matched: request.matched,
    matchOffset: request.matchOffset, searchQuery: request.searchQuery, pageUrl: request.pageUrl,
    documentTitle: request.documentTitle, glossarySelection: request.glossarySelection,
    templateId: request.templateId, profileId: message.profileId };
  if (typeof request.operationId !== "string") throw new Error("Begin an Anki preparation before running its function.");
  const preparation = await ankiPreparation.execute(sender, script, context, request.operationId);
  if ((await readStatus(request.templateId, message.profileId)).configKey !== request.configKey) {
    throw new Error("Anki configuration changed. Refresh this result before adding a note.");
  }
  return { preparation };
}
