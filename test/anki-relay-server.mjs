// Run the relay from the archive the Sharing page downloaded. Not shipped.
// SPDX-License-Identifier: GPL-3.0-or-later
import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

// Resolves with `{ port, close() }`; the process prints the port it bound,
// which is how port 0 is learned.
export async function startAnkiRelayServer({ archive, port = 0, pingMs = 20_000, serverPath }) {
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
    child = spawn("python3", [server, "--port", String(port), "--ping-seconds", String(pingMs / 1000)], { stdio: ["ignore", "pipe", "inherit"] });
    exited = new Promise((resolveExit) => child.once("close", (code, signal) => {
      exitCode = code ?? signal;
      resolveExit();
    }));
    const boundPort = await new Promise((resolvePort, rejectPort) => {
      child.once("error", rejectPort);
      exited.then(() => rejectPort(new Error(`the Anki relay exited with ${exitCode}`)));
      child.stdout.once("data", (chunk) => resolvePort(Number(String(chunk).trim().split(" ")[1])));
    });
    return { port: boundPort, serverPath: server, get exitCode() { return exitCode; }, close };
  } catch (error) {
    await close();
    throw error;
  }
}
