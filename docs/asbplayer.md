<!-- SPDX-License-Identifier: GPL-3.0-or-later -->

# Using Hachidori with asbplayer

Hachidori looks up Japanese text in the [asbplayer](https://github.com/asbplayer/asbplayer)
web app's subtitle list and on subtitles over its video, including the default
in-window player and its fullscreen mode. It also works in the web app's
**Pop Out** player and on subtitles drawn by the asbplayer extension over a
video. A popup inside a small video frame stays within that frame, so a larger
player or Pop Out window gives it more room. On streaming sites, fullscreen
support depends on the player: some players hide their subtitles or the popup
from other extensions. If a popup disappears in fullscreen, exit fullscreen or
use the web app's subtitle list.

By default, hold **Shift** while hovering a subtitle. To look up words without
holding a key, choose **Hover** under Hachidori **Settings → Reading → Lookup
mode**. In asbplayer's **Misc** settings, **Auto-pause when mousing over
subtitles** lets you read a popup while the video is paused. Its auto-resume
option resumes playback when you move away. If subtitle blur is enabled in
asbplayer, hovering will also unblur the subtitle.

Hachidori cannot read subtitles in asbplayer's browser side panel. The panel is
another extension's page, where browsers do not allow Hachidori's content
script to run. Use the subtitles over the video or the web app's subtitle list
instead. [asbplayer documents the same limitation for popup dictionaries](https://docs.asbplayer.dev/docs/common-issues/#my-popup-dictionary-extension-eg-yomitan-doesnt-work-on-the-side-panel).
