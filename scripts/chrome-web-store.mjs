#!/usr/bin/env node
// Upload a verified release package and submit it through the Chrome Web Store API.
// SPDX-License-Identifier: GPL-3.0-or-later

import { sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const API_ENDPOINT = "https://chromewebstore.googleapis.com";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const CHROME_WEB_STORE_SCOPE = "https://www.googleapis.com/auth/chromewebstore";
const JWT_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const ITEM_ID = /^[a-p]{32}$/u;
const RESOURCE_ID = /^[A-Za-z0-9._~-]+$/u;
const RELEASE_VERSION = /^(0|[1-9]\d*)(\.(0|[1-9]\d*)){0,3}$/u;
const SUCCESSFUL_SUBMISSION_STATES = new Set([
  "PENDING_REVIEW",
  "STAGED",
  "PUBLISHED",
  "PUBLISHED_TO_TESTERS",
]);

function fail(message) {
  throw new Error(message);
}

function encodedJson(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function requireString(value, name) {
  if (typeof value !== "string" || value.trim() === "") fail(`${name} is required`);
  return value;
}

export function parseServiceAccount(source) {
  let credentials;
  try {
    credentials = JSON.parse(requireString(source, "CHROME_WEBSTORE_SERVICE_ACCOUNT_JSON"));
  } catch (error) {
    fail(`CHROME_WEBSTORE_SERVICE_ACCOUNT_JSON is not valid JSON: ${error.message}`);
  }
  if (credentials.type !== "service_account") {
    fail("CHROME_WEBSTORE_SERVICE_ACCOUNT_JSON must contain a service account");
  }
  requireString(credentials.client_email, "service account client_email");
  requireString(credentials.private_key, "service account private_key");
  if (credentials.token_uri !== TOKEN_ENDPOINT) {
    fail(`service account token_uri must be ${TOKEN_ENDPOINT}`);
  }
  return credentials;
}

export function createServiceAccountAssertion(credentials, nowMilliseconds = Date.now()) {
  const issuedAt = Math.floor(nowMilliseconds / 1000);
  const header = {
    alg: "RS256",
    typ: "JWT",
    ...(credentials.private_key_id ? { kid: credentials.private_key_id } : {}),
  };
  const claims = {
    iss: credentials.client_email,
    scope: CHROME_WEB_STORE_SCOPE,
    aud: TOKEN_ENDPOINT,
    iat: issuedAt,
    exp: issuedAt + 3600,
  };
  const unsigned = `${encodedJson(header)}.${encodedJson(claims)}`;
  let signature;
  try {
    signature = sign("RSA-SHA256", Buffer.from(unsigned), credentials.private_key).toString("base64url");
  } catch (error) {
    fail(`could not sign the service account assertion: ${error.message}`);
  }
  return `${unsigned}.${signature}`;
}

async function responseJson(response, operation) {
  const text = await response.text();
  let body = {};
  if (text !== "") {
    try {
      body = JSON.parse(text);
    } catch {
      if (response.ok) fail(`${operation} returned non-JSON output`);
      body = { error: { message: text.slice(0, 500) } };
    }
  }
  if (!response.ok) {
    const detail = body?.error?.message || body?.error_description || response.statusText || "request failed";
    fail(`${operation} failed with HTTP ${response.status}: ${detail}`);
  }
  return body;
}

export async function requestAccessToken(credentials, {
  fetchImpl = fetch,
  nowMilliseconds = Date.now(),
} = {}) {
  const assertion = createServiceAccountAssertion(credentials, nowMilliseconds);
  const response = await fetchImpl(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: JWT_GRANT_TYPE,
      assertion,
    }),
  });
  const body = await responseJson(response, "service account authentication");
  return requireString(body.access_token, "OAuth access_token");
}

function itemName(publisherId, itemId) {
  if (!RESOURCE_ID.test(requireString(publisherId, "Chrome Web Store publisher ID"))) {
    fail("Chrome Web Store publisher ID contains unsupported characters");
  }
  if (!ITEM_ID.test(requireString(itemId, "Chrome Web Store extension ID"))) {
    fail("Chrome Web Store extension ID must contain 32 letters from a through p");
  }
  return `publishers/${encodeURIComponent(publisherId)}/items/${encodeURIComponent(itemId)}`;
}

async function uploadPackage(fetchImpl, accessToken, name, packageBytes) {
  const response = await fetchImpl(`${API_ENDPOINT}/upload/v2/${name}:upload`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/zip",
    },
    body: packageBytes,
  });
  return responseJson(response, "Chrome Web Store package upload");
}

async function fetchItemStatus(fetchImpl, accessToken, name) {
  const response = await fetchImpl(`${API_ENDPOINT}/v2/${name}:fetchStatus`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return responseJson(response, "Chrome Web Store upload status");
}

async function waitForUpload(fetchImpl, accessToken, name, upload, {
  maxPolls,
  pollIntervalMilliseconds,
  sleep,
}) {
  if (upload.uploadState === "SUCCEEDED") return upload;
  if (upload.uploadState !== "IN_PROGRESS") {
    fail(`Chrome Web Store package upload ended in state ${upload.uploadState || "UNKNOWN"}`);
  }
  for (let poll = 0; poll < maxPolls; poll += 1) {
    await sleep(pollIntervalMilliseconds);
    const status = await fetchItemStatus(fetchImpl, accessToken, name);
    const state = status.lastAsyncUploadState;
    if (state === "SUCCEEDED") return upload;
    if (state === undefined || state === "UPLOAD_STATE_UNSPECIFIED" || state === "IN_PROGRESS") continue;
    fail(`Chrome Web Store asynchronous package upload ended in state ${state}`);
  }
  fail("Chrome Web Store package upload did not finish before the polling deadline");
}

async function submitForReview(fetchImpl, accessToken, name, publishType) {
  const response = await fetchImpl(`${API_ENDPOINT}/v2/${name}:publish`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      publishType,
      blockOnWarnings: true,
      skipReview: false,
    }),
  });
  const submission = await responseJson(response, "Chrome Web Store review submission");
  if (!SUCCESSFUL_SUBMISSION_STATES.has(submission.state)) {
    fail(`Chrome Web Store review submission ended in state ${submission.state || "UNKNOWN"}`);
  }
  return submission;
}

const defaultSleep = milliseconds => new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds));

export async function uploadAndSubmit({
  credentialsJson,
  packagePath,
  publisherId,
  itemId,
  expectedVersion,
  publishType = "DEFAULT_PUBLISH",
  fetchImpl = fetch,
  nowMilliseconds = Date.now(),
  maxPolls = 60,
  pollIntervalMilliseconds = 5000,
  sleep = defaultSleep,
}) {
  if (!RELEASE_VERSION.test(requireString(expectedVersion, "expected Chrome extension version"))) {
    fail("expected Chrome extension version is not a valid manifest version");
  }
  if (!["DEFAULT_PUBLISH", "STAGED_PUBLISH"].includes(publishType)) {
    fail("publish type must be DEFAULT_PUBLISH or STAGED_PUBLISH");
  }
  const credentials = parseServiceAccount(credentialsJson);
  const packageBytes = await readFile(resolve(requireString(packagePath, "Chrome Web Store package path")));
  const name = itemName(publisherId, itemId);
  const accessToken = await requestAccessToken(credentials, { fetchImpl, nowMilliseconds });
  const upload = await uploadPackage(fetchImpl, accessToken, name, packageBytes);
  await waitForUpload(fetchImpl, accessToken, name, upload, {
    maxPolls,
    pollIntervalMilliseconds,
    sleep,
  });
  if (upload.crxVersion !== undefined && upload.crxVersion !== expectedVersion) {
    fail(`Chrome Web Store read package version ${upload.crxVersion}; expected ${expectedVersion}`);
  }
  const submission = await submitForReview(fetchImpl, accessToken, name, publishType);
  return { upload, submission };
}

function commandLine(arguments_) {
  const options = {};
  const allowed = new Set(["package", "publisher-id", "item-id", "expected-version", "publish-type"]);
  for (let index = 0; index < arguments_.length; index += 2) {
    const option = arguments_[index];
    const value = arguments_[index + 1];
    if (!option?.startsWith("--") || value === undefined) {
      fail("usage: chrome-web-store.mjs --package ZIP --publisher-id ID --item-id ID --expected-version VERSION");
    }
    const name = option.slice(2);
    if (!allowed.has(name) || options[name] !== undefined) fail(`unknown or repeated option: ${option}`);
    options[name] = value;
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = commandLine(process.argv.slice(2));
    const result = await uploadAndSubmit({
      credentialsJson: process.env.CHROME_WEBSTORE_SERVICE_ACCOUNT_JSON,
      packagePath: options.package,
      publisherId: options["publisher-id"],
      itemId: options["item-id"],
      expectedVersion: options["expected-version"],
      publishType: options["publish-type"],
    });
    console.log(
      `Chrome Web Store accepted ${options["item-id"]} ${options["expected-version"]}; `
      + `submission state ${result.submission.state}`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
