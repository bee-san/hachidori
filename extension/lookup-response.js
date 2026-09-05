// SPDX-License-Identifier: GPL-3.0-or-later

const MAX_LOOKUP_RESPONSE_BYTES = 32 * 1024 * 1024;
export const LOOKUP_RESPONSE_ERROR = "lookup response exceeds the 32 MiB serialized limit";
const LOOKUP_REQUESTS = new Set(["hd_lookup", "hd_lookup_dictionary", "hd_kanji"]);
const lookupResponseEncoder = new TextEncoder();

export function isLookupRequest(type) {
  return LOOKUP_REQUESTS.has(type);
}

export function validLookupRequestId(value) {
  return value === null || typeof value === "string" || Number.isFinite(value);
}

export function lookupReplyFits(reply, nativeJsonLength = 0) {
  // Extra empty endpoint fields only enlarge this conservative envelope; near
  // the boundary we always measure the actual reply instead.
  const envelope = nativeJsonLength === 0 ? reply : { ...reply, results: [], kanji: null };
  const envelopeJson = JSON.stringify(envelope);
  // JSON escaping needs at most six bytes per UTF-16 code unit, including
  // lone surrogates. Ordinary native replies need no second full traversal.
  if ((nativeJsonLength + envelopeJson.length) * 6 <= MAX_LOOKUP_RESPONSE_BYTES) return true;
  const json = nativeJsonLength === 0 ? envelopeJson : JSON.stringify(reply);
  return lookupResponseEncoder.encode(json).byteLength <= MAX_LOOKUP_RESPONSE_BYTES;
}

export function boundLookupFailure(reply) {
  if (!isLookupRequest(reply.type.replace(/_result$/u, ""))) return reply;
  if (!validLookupRequestId(reply.requestId)) reply.requestId = null;
  if (!lookupReplyFits(reply)) {
    reply.error = LOOKUP_RESPONSE_ERROR;
    if (!lookupReplyFits(reply)) reply.requestId = null;
  }
  return reply;
}
