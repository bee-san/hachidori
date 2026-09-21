// SPDX-License-Identifier: GPL-3.0-or-later
// Answers one AnkiConnect request the way the add-on does: `multi` runs each
// bound sub-action through the same handler and returns their `{ result, error }`
// envelopes in request order. `handle(action, params, request)` returns the
// sub-action's result or throws the error text AnkiConnect would report.
export async function answerAnkiConnect(request, handle) {
  if (request.action === "multi") {
    const replies = [];
    for (const entry of request.params.actions) replies.push(await answerAnkiConnect(entry, handle));
    return { result: replies, error: null };
  }
  try {
    return { result: await handle(request.action, request.params ?? {}, request), error: null };
  } catch (error) {
    return { result: null, error: error.message };
  }
}

// An `invoke`-shaped fake over the same handler: a direct action returns its
// result or throws, and `multi` returns the sub-action envelopes as the
// gateway does.
export function ankiInvokeFake(handle) {
  return async (action, params) => action === "multi"
    ? (await answerAnkiConnect({ action, params }, handle)).result
    : handle(action, params);
}
