import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createServiceAccountAssertion,
  parseServiceAccount,
  uploadAndSubmit,
} from "../scripts/chrome-web-store.mjs";

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const PUBLISHER_ID = "publisher-123";
const ITEM_ID = "abcdefghijklmnopabcdefghijklmnop";

function testCredentials() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    credentials: {
      type: "service_account",
      private_key_id: "test-key",
      private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
      client_email: "release@example.iam.gserviceaccount.com",
      token_uri: TOKEN_ENDPOINT,
    },
    publicKey,
  };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("service account assertion has the Chrome Web Store scope and a valid RSA signature", () => {
  const { credentials, publicKey } = testCredentials();
  const now = Date.UTC(2026, 8, 15, 9, 0, 0);
  const assertion = createServiceAccountAssertion(credentials, now);
  const [header, claims, signature] = assertion.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url")), {
    alg: "RS256",
    typ: "JWT",
    kid: "test-key",
  });
  assert.deepEqual(JSON.parse(Buffer.from(claims, "base64url")), {
    iss: credentials.client_email,
    scope: "https://www.googleapis.com/auth/chromewebstore",
    aud: TOKEN_ENDPOINT,
    iat: now / 1000,
    exp: now / 1000 + 3600,
  });
  assert.equal(
    verify("RSA-SHA256", Buffer.from(`${header}.${claims}`), publicKey, Buffer.from(signature, "base64url")),
    true,
  );
});

test("service account credentials reject a redirected token endpoint", () => {
  const { credentials } = testCredentials();
  assert.throws(
    () => parseServiceAccount(JSON.stringify({ ...credentials, token_uri: "https://example.com/token" })),
    /token_uri must be https:\/\/oauth2\.googleapis\.com\/token/u,
  );
});

test("release submission authenticates, waits for upload processing, and blocks on warnings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hachidori-chrome-store-"));
  const packagePath = join(directory, "hachidori-1.2.3-chrome.zip");
  await writeFile(packagePath, "verified package");
  const { credentials } = testCredentials();
  const requests = [];
  const responses = [
    jsonResponse({ access_token: "access-token", expires_in: 3600, token_type: "Bearer" }),
    jsonResponse({ name: `publishers/${PUBLISHER_ID}/items/${ITEM_ID}`, uploadState: "IN_PROGRESS" }),
    jsonResponse({ lastAsyncUploadState: "IN_PROGRESS" }),
    jsonResponse({ lastAsyncUploadState: "SUCCEEDED" }),
    jsonResponse({
      name: `publishers/${PUBLISHER_ID}/items/${ITEM_ID}`,
      itemId: ITEM_ID,
      state: "PENDING_REVIEW",
    }),
  ];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options });
    return responses.shift();
  };
  try {
    const result = await uploadAndSubmit({
      credentialsJson: JSON.stringify(credentials),
      packagePath,
      publisherId: PUBLISHER_ID,
      itemId: ITEM_ID,
      expectedVersion: "1.2.3",
      fetchImpl,
      nowMilliseconds: Date.UTC(2026, 8, 15, 9, 0, 0),
      pollIntervalMilliseconds: 0,
      sleep: async () => {},
    });
    assert.equal(result.submission.state, "PENDING_REVIEW");
    assert.equal(requests.length, 5);
    assert.equal(requests[0].url, TOKEN_ENDPOINT);
    const tokenBody = new URLSearchParams(requests[0].options.body);
    assert.equal(tokenBody.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
    assert.match(tokenBody.get("assertion"), /^[^.]+\.[^.]+\.[^.]+$/u);
    assert.equal(
      requests[1].url,
      `https://chromewebstore.googleapis.com/upload/v2/publishers/${PUBLISHER_ID}/items/${ITEM_ID}:upload`,
    );
    assert.equal(requests[1].options.headers.Authorization, "Bearer access-token");
    assert.equal(requests[1].options.body.toString(), "verified package");
    assert.equal(
      requests[2].url,
      `https://chromewebstore.googleapis.com/v2/publishers/${PUBLISHER_ID}/items/${ITEM_ID}:fetchStatus`,
    );
    assert.equal(
      requests[4].url,
      `https://chromewebstore.googleapis.com/v2/publishers/${PUBLISHER_ID}/items/${ITEM_ID}:publish`,
    );
    assert.deepEqual(JSON.parse(requests[4].options.body), {
      publishType: "DEFAULT_PUBLISH",
      blockOnWarnings: true,
      skipReview: false,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a synchronously uploaded package must report the expected manifest version", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hachidori-chrome-store-"));
  const packagePath = join(directory, "hachidori-1.2.3-chrome.zip");
  await writeFile(packagePath, "verified package");
  const { credentials } = testCredentials();
  const responses = [
    jsonResponse({ access_token: "access-token" }),
    jsonResponse({ uploadState: "SUCCEEDED", crxVersion: "1.2.4" }),
  ];
  try {
    await assert.rejects(
      uploadAndSubmit({
        credentialsJson: JSON.stringify(credentials),
        packagePath,
        publisherId: PUBLISHER_ID,
        itemId: ITEM_ID,
        expectedVersion: "1.2.3",
        fetchImpl: async () => responses.shift(),
      }),
      /read package version 1\.2\.4; expected 1\.2\.3/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
