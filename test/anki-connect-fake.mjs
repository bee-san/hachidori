// SPDX-License-Identifier: GPL-3.0-or-later
// A fake AnkiConnect for tests. Handlers throw this to answer an action the
// way the add-on reports a failure; any other throw is a fixture fault and
// propagates so the suite fails loudly instead of the extension seeing an
// ordinary Anki error.
export class AnkiConnectError extends Error {}

// Answers one AnkiConnect request the way the add-on does. `multi` runs each
// sub-action through the same handler and returns its reply in request order;
// like AnkiConnect, a sub-action without `version` 5 or later gets the bare
// result, so a gateway that forgot to bind API v6 fails the envelope check.
// `handle(action, params, request)` returns the action's result or throws
// `AnkiConnectError` with the text AnkiConnect would report.
export async function answerAnkiConnect(request, handle) {
  const envelope = (request.version ?? 4) >= 5;
  const reply = (result, error = null) => envelope ? { result, error } : result;
  if (request.action === "multi") {
    const replies = [];
    for (const entry of request.params.actions) replies.push(await answerAnkiConnect(entry, handle));
    return reply(replies);
  }
  try {
    return reply(await handle(request.action, request.params ?? {}, request));
  } catch (error) {
    if (!(error instanceof AnkiConnectError)) throw error;
    return reply(null, error.message);
  }
}

// An `invoke`-shaped fake over the same handler, binding `multi` sub-actions to
// API v6 the way the gateway does: a direct action returns its result or
// throws, and `multi` returns the sub-action envelopes.
export function ankiInvokeFake(handle) {
  return async (action, params) => action === "multi"
    ? (await answerAnkiConnect({ action, version: 6, params: {
      actions: params.actions.map(entry => ({ ...entry, version: 6 })) } }, handle)).result
    : handle(action, params);
}
