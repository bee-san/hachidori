// SPDX-License-Identifier: GPL-3.0-or-later
import http from "node:http";

const DEFAULT_RESULTS = Object.freeze({
  version: 6,
  deckNames: ["Default", "Mining"],
  modelNames: ["Basic", "Japanese"],
  modelFieldNames: ["Expression", "Reading", "Meaning"],
});

export async function startFakeAnkiConnect({ results = DEFAULT_RESULTS, apiKey = "" } = {}) {
  const requests = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => {
      let message;
      try {
        message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        response.writeHead(400).end();
        return;
      }
      requests.push(message);
      const error = request.method !== "POST" ? "POST required"
        : message.version !== 6 ? "unsupported version"
          : apiKey && message.key !== apiKey ? "valid API key required"
            : !Object.hasOwn(results, message.action) ? `unsupported action: ${message.action}` : null;
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ result: error === null ? results[message.action] : null, error }));
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}
