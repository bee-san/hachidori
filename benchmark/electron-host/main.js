// Minimal Electron host for benchmarking the extension on the classic FS +
// IDBFS runtime (the GameSentenceMiner shape: cross-origin isolation and
// shared memory, no OPFS sync access handles for chrome-extension:// origins).
//
// Environment: HDW_EXT (unpacked extension), HDW_PROFILE (userData directory),
// HDW_CDP_PORT (remote debugging port). The host quits when a file named
// `hdw-quit` appears in the profile directory, so a driver can shut it down
// gracefully; an abrupt kill leaves Electron unable to re-register the
// extension's service worker on the next launch with the same profile.
const { app, session, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");

const EXT = process.env.HDW_EXT;
if (process.env.HDW_PROFILE) app.setPath("userData", process.env.HDW_PROFILE);
app.commandLine.appendSwitch("remote-debugging-port", process.env.HDW_CDP_PORT || "9333");

app.whenReady().then(async () => {
  const ext = await session.defaultSession.extensions.loadExtension(EXT, { allowFileAccess: true });
  console.log("HDW_EXT_ID", ext.id);
  // A relaunch with an existing profile does not start the extension's
  // service worker until something wakes it; do so explicitly (fails
  // harmlessly on the very first launch, before the registration exists).
  try {
    await session.defaultSession.serviceWorkers.startWorkerForScope(`chrome-extension://${ext.id}/`);
  } catch {}
  const win = new BrowserWindow({ width: 1000, height: 800, show: true });
  await win.loadURL(`chrome-extension://${ext.id}/settings.html`);
  console.log("HDW_READY");
  const quitFile = path.join(app.getPath("userData"), "hdw-quit");
  setInterval(() => {
    try {
      fs.accessSync(quitFile);
      fs.unlinkSync(quitFile);
      app.quit();
    } catch {}
  }, 200);
});
