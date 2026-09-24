# Evidence for the asbplayer compatibility issue (split out of #330)

Reproduction of Hachidori `0.1.6` (`main` at `fc3eb73`) on the asbplayer web app
(https://app.asbplayer.dev, fetched 2026-09-24) and on the asbplayer browser
extension `1.21.0` built from https://github.com/asbplayer/asbplayer at
`b65ef837`, in the repository's pinned Chrome for Testing 152.0.7977.75 with the
`hachidori-fixture` dictionary (`node test/make-fixture.mjs`).

| File | What it shows |
| --- | --- |
| `01-control-plain-page.png` | Control: the popup on a plain page. |
| `02-webapp-subtitle-list-hover-works.png` | Web app, subtitle list (top frame): works. |
| `03-webapp-video-iframe-hover-no-popup.png` | Web app, subtitle over the video (same-origin `<iframe>`): **no popup**. |
| `04-webapp-video-iframe-hover-with-all-frames.png` | Same hover with `all_frames: true` (prototype): popup appears inside the iframe. |
| `05-webapp-popout-window-hover-works.png` | Web app "Pop Out" window (top-level document): works. |
| `06-extension-overlay-hover-works.png` | asbplayer extension overlay on a local video page, not fullscreen: works. |
| `07-extension-overlay-document-fullscreen-works.png` | `document.documentElement.requestFullscreen()`: works (body is inside the fullscreen element). |
| `08-extension-overlay-player-fullscreen-no-popup.png` | Player `<div>` fullscreen (YouTube/Netflix style): highlight paints, **popup is covered by the top layer**. |
| `09-extension-overlay-player-fullscreen-with-host-reparent.png` | Same hover with the host re-parented into the fullscreen element (prototype): popup appears. |
| `10-extension-overlay-after-cue-change.png` | Popup stays open after the cue changes (asbplayer parks the old cue offscreen, still connected). |
| `webapp-log.txt`, `extension-log.txt` | Step-by-step results and page console for the unpatched runs. |
| `*-patched.txt` | The same runs against the prototype. |
| `repro-webapp.mjs`, `repro-extension.mjs`, `sample.srt` | The Puppeteer scripts (`HD_EXTENSION=<dir>` selects the extension folder). |
| `prototype.patch` | The throwaway prototype (`all_frames`, host re-parenting) used for 04 and 09. Not a proposed diff. |
