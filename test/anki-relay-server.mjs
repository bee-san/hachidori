// The Anki add-on's relay, extension/anki-relay/server.py, run as a plain
// process for the relay unit test and the two-browser sharing suite. Not shipped.
// SPDX-License-Identifier: GPL-3.0-or-later
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// Resolves with `{ port, close() }`; the process prints the port it bound,
// which is how port 0 is learned.
export async function startAnkiRelayServer({ port = 0, pingMs = 20_000,
  serverPath = fileURLToPath(new URL("../extension/anki-relay/server.py", import.meta.url)) } = {}) {
  const child = spawn("python3", [serverPath, "--port", String(port), "--ping-seconds", String(pingMs / 1000)], { stdio: ["ignore", "pipe", "inherit"] });
  let exitCode = null;
  const exited = new Promise((resolveExit) => child.once("exit", (code, signal) => {
    exitCode = code ?? signal;
    resolveExit();
  }));
  const boundPort = await new Promise((resolvePort, rejectPort) => {
    child.once("error", rejectPort);
    exited.then(() => rejectPort(new Error(`the Anki relay exited with ${exitCode}`)));
    child.stdout.once("data", (chunk) => resolvePort(Number(String(chunk).trim().split(" ")[1])));
  });
  return {
    port: boundPort,
    serverPath,
    // Set once the process is gone; a relay that died mid-run is a failure.
    get exitCode() { return exitCode; },
    close() {
      child.kill();
      return exited;
    },
  };
}
