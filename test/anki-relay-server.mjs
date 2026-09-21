// Run the relay from the archive the Sharing page downloaded. Not shipped.
// SPDX-License-Identifier: GPL-3.0-or-later
import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

// Resolves with `{ port, apiPort, close() }`; the process prints the ports it
// bound, which is how port 0 is learned. `apiPort` also serves the relay's
// Yomitan-compatible HTTP API (null leaves it off).
export async function startAnkiRelayServer({ archive, port = 0, pingMs = 20_000, serverPath, apiPort = null }) {
  const directory = await mkdtemp(join(tmpdir(), "hachidori-relay-"));
  let child = null;
  let exited = Promise.resolve();
  let exitCode = null;
  async function close() {
    child?.kill();
    await exited;
    await rm(directory, { recursive: true, force: true });
  }
  try {
    if (!serverPath) await execute("python3", ["-m", "zipfile", "-e", archive, directory]);
    const server = serverPath || join(directory, "server.py");
    const args = [server, "--port", String(port), "--ping-seconds", String(pingMs / 1000)];
    if (apiPort !== null) args.push("--api-port", String(apiPort));
    child = spawn("python3", args, { stdio: ["ignore", "pipe", "inherit"] });
    exited = new Promise((resolveExit) => child.once("close", (code, signal) => {
      exitCode = code ?? signal;
      resolveExit();
    }));
    const announced = { listening: null, api: null };
    await new Promise((resolvePorts, rejectPorts) => {
      let buffered = "";
      child.once("error", rejectPorts);
      exited.then(() => rejectPorts(new Error(`the Anki relay exited with ${exitCode}`)));
      child.stdout.on("data", (chunk) => {
        buffered += String(chunk);
        for (const line of buffered.split("\n").slice(0, -1)) {
          const [kind, value] = line.trim().split(" ");
          if (kind === "listening") announced.listening = Number(value);
          else if (kind === "api") announced.api = Number(value);
          else if (kind === "api-failed") rejectPorts(new Error(`the Anki relay's API did not start: ${line}`));
        }
        buffered = buffered.slice(buffered.lastIndexOf("\n") + 1);
        if (announced.listening !== null && (apiPort === null || announced.api !== null)) resolvePorts();
      });
    });
    return { port: announced.listening, apiPort: announced.api, serverPath: server, get exitCode() { return exitCode; }, close };
  } catch (error) {
    await close();
    throw error;
  }
}
