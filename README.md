<p align="center">
  <img src="docs/assets/hachidori.png" width="180" alt="Hachidori pink and lilac hummingbird logo">
</p>

<h1 align="center">Hachidori</h1>

<p align="center"><strong>The fastest, most feature rich Japanese dictionary app in the world</strong></p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0--or--later-7c3aed" alt="GPL-3.0-or-later license"></a>
  <a href="#install-in-15-seconds"><img src="https://img.shields.io/badge/Chrome-128%2B-4285F4?logo=googlechrome&logoColor=white" alt="Chrome 128 or newer"></a>
  <a href="docs/privacy.md"><img src="https://img.shields.io/badge/dictionary_engine-local-0f766e" alt="Dictionary engine runs locally"></a>
  <a href="https://sonarcloud.io/summary/new_code?id=bee-san_hachidori"><img src="https://sonarcloud.io/api/project_badges/measure?project=bee-san_hachidori&metric=alert_status" alt="SonarQube Cloud quality gate"></a>
  <a href="https://github.com/bee-san/hachidori"><img src="https://img.shields.io/github/stars/bee-san/hachidori?style=flat&logo=github&color=f59e0b" alt="GitHub stars"></a>
</p>

<p align="center">
  <a href="#install-in-15-seconds">Install</a> ·
  <a href="benchmark/README.md">Benchmarks</a> ·
  <a href="docs/architecture.md">Architecture</a> ·
  <a href="extension/README.md">Extension</a> ·
  <a href="docs/asbplayer.md">asbplayer</a> ·
  <a href="docs/sharing.md">Sharing</a> ·
  <a href="docs/memory.md">Memory</a> ·
  <a href="docs/chrome-web-store.md">Chrome Web Store guide</a> ·
  <a href="docs/privacy.md">Privacy</a> ·
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

Hachidori is a blazing fast Japanese Dictionary Chrome Extension that is feature rich and opinionated.

<p align="center">
  <a href="https://cdn.jsdelivr.net/gh/bee-san/hachidori@27ac4da45bf6c63f07f16108af386a941b3972b9/media/promo-video/out/hachidori-promo.mp4"><img src="https://cdn.jsdelivr.net/gh/bee-san/hachidori@27ac4da45bf6c63f07f16108af386a941b3972b9/media/promo-video/out/hachidori-promo.gif" width="720" alt="One-minute tour of Hachidori: importing dictionaries in seconds, hover lookups with conjugation, pitch accent and frequency, lookups in text boxes, one-click Anki cards, the personal dictionary, lookup blur and popup themes"></a>
  <br>
  <a href="https://cdn.jsdelivr.net/gh/bee-san/hachidori@27ac4da45bf6c63f07f16108af386a941b3972b9/media/promo-video/out/hachidori-promo.mp4">▶ Watch the one-minute tour (MP4)</a>
</p>

## Install in 15 seconds

Click <a href="https://chromewebstore.google.com/detail/hachidori/mikpaebfdmidjnopgffchicnmoahhcbe">here to install from Chrome store.</a> (note: this will always lag behind the repo and may have bugs fixed in the repo)

<p align="center">
  <img src="docs/assets/install-in-60-seconds.gif" alt="Animated walkthrough of Hachidori's first-run setup, dictionary installation, Anki detection, and Japanese lookup" width="720">
</p>

# Blazing Fast

Hachidori is 83 times faster than the worlds most popular Japanese dictionary app at importing dictionaries.

<img width="1672" height="941" alt="ChatGPT Image Sep 9, 2026, 09_18_59 AM" src="https://github.com/user-attachments/assets/c507c940-f61e-4063-8d2c-9e43184cd7d3" />

See [the measured results](docs/browser-performance.md).


# Custom Dictionary

Do you keep on seeing a name pop up over & over again in a book, but it's not in the dictionary? 

With Hachidori, you can highlight the word and add it as a custom definition.

Never add your own words? Turn off **Settings → Library → Personal dictionary →
Use the personal dictionary** and highlighting text no longer opens a popup.

<p align="center">
  <img src="docs/assets/custom-dictionary.gif" alt="Animated demonstration of adding and viewing a custom dictionary definition in Hachidori" width="720">
</p>

# Lookup blur

Sometimes we fall into a trap of looking up a word over & over again, but never learning it.

Hachidori records how many times you have looked up a word and can blur it for you for a few seconds to force you to remember it.

It can even use anki.

<p align="center">
  <img src="docs/assets/lookup-blur.gif" alt="Animated demonstration of Hachidori blurring repeated lookups before revealing their definitions" width="720">
</p>

# Sharing

Set up Hachidori once and use that setup from every other Hachidori, in GameSentenceMiner, another browser or another computer. Same dictionaries and settings used across multiple Hachidoris.

Install [Hachidori Relay for Anki](https://github.com/bee-san/hachidori-anki)
from **Settings → Sharing → Download the Anki add-on**, then follow the
[sharing guide](docs/sharing.md) to link your other browsers.

<img width="775" height="471" alt="Screenshot 2026-09-14 at 14 19 41" src="https://github.com/user-attachments/assets/991d570a-599e-4277-8736-c72b2f371ed0" />


# MDX dictionaries and long entries

**Add dictionaries** imports MDict `.mdx` dictionaries with their `.mdd`
resource files, next to Yomitan ZIPs. Choose the `.mdx` and its `.mdd` files
together. When an import leaves something out (unreadable entries, aliases with
no target, or images and styles no `.mdd` provides), its row says so with a note
for each.

Lookups also find entries longer than the scan length, such as proverbs and
titles, without scanning further on every hover.

# Experimental features

**Settings → Advanced → Experimental features** switches on work that is still
changing and may be removed:

- **Google Docs** — look up words while reading a Google Doc. Docs paints its
  text to a canvas; Hachidori asks it to expose the text as well, which Google
  may change or remove without notice. The sentence is the hovered run of text.
- **Smaller Anki cards** — write compact definitions to new Anki notes. The
  dictionary stylesheets, classes and wrappers are left out; the text, line
  breaks, lists, tables, furigana, images and the markers note types such as
  Lapis, Kiku and Senren rely on are kept. As in Yomitan, the definition ends
  without a Rules/Deinflection line; use `{part-of-speech}` and
  `{conjugation}` for that information. A Jitendex note shrinks to about a
  quarter of its size. Notes already in Anki are not changed. The behaviour
  follows the Compact HTML Cleanup Anki add-on.
- **Netflix mining** — Migaku-style sentence cards from Netflix. Hover a word
  in a Japanese subtitle on `netflix.com/watch/…` and add it: the sentence is the
  whole subtitle line, and a field mapped to `{sentence-audio}` gets that line's
  audio. Kiku, Lapis and Senren use their blank sentence-audio field
  automatically. A field mapped to `{gif}` gets a short looping GIF of the line;
  off Netflix or with the switch off it is the page screenshot instead, so a
  `Picture` field mapped to `{gif}` still gets a picture everywhere, and a
  Netflix line that cannot be recorded also gets the screenshot, with a note
  saying why. Hachidori reads Netflix's own subtitle files for the timing
  (adapted from Subadub). While the switch is on, the video's sound plays
  through Hachidori, which keeps the last 30 seconds you heard at normal speed
  in the page's memory, so the audio of a line you have just watched is cut
  from that without replaying anything. A line you have not heard all of plays
  on to its end, if the video stopped partway through it, or replays once
  otherwise; either way you hear it. This needs no click on Hachidori's
  toolbar button, but the sound starts going through Hachidori only once you
  have clicked or pressed a key on the Netflix page (or Chrome lets the site
  play sound by itself), and stays that way until the page reloads, even with
  the switch off. Until then, and for `{gif}`, Hachidori replays the line once
  to record the tab, muted, then returns to where you were. Chrome lets it
  record a tab only after you click Hachidori's toolbar button once on that
  tab, or add notes with its **Add the current popup entry to Anki** shortcut.
  Netflix may change its data without notice, and protected playback can
  record as silence, in which case the note is added without the audio and
  says why, or as black frames, which Hachidori cannot tell from a dark scene,
  so the GIF is then black. While you hover a subtitle line the video pauses,
  and it plays on once the pointer has left the line and Hachidori's popup,
  unless you played, paused or skipped it yourself in the meantime. Adding a
  note leaves it paused until the line is recorded and the pointer has left.
- **Word highlighting** — mark the Japanese words on every page by their Anki
  status, like Migaku: unknown words (no card) get a solid line, learning words
  a dashed one and, if you turn them on, known words (a mature card) a dotted
  one, in your popup theme's colours. Turn it on under **Settings → Reading →
  Word highlighting**. Your dictionaries split the page into words in the
  browser and the status comes from the Anki index Hachidori keeps for the
  first Anki Template, so opening a page never contacts Anki; adding a word from
  the popup re-marks every copy of it at once. **Mark as known** and **Ignore**
  in the popup, or their keybinds, set a word's status yourself without an Anki
  note: a name you will never mine stops showing as unknown. Pressing one again
  clears it. Known and ignored words are left plain unless you turn their marks
  on; ignored ones get a double line. The words you set travel with your backups
  and to linked browsers. The page's markup is not changed, but its own scripts
  can read which words are marked.


# Opinionated

Hachidori is an opinionated program. If it does not benefit me, the creator, personally than I will not add that feature.

I do this because I am a pretty average learner, and if I make this tool great for myself than I am making it great for the average Japanese learner.

# AI Usage

This program was created with the assistance of AI. I used GPT 5.6 Ultra, and then GPT 6.0 Astra Ultra exclusively. When Codex goes down, I use Fable 5.1 with ultrathink and ultracode.

I have reviewed all plans, I set the direction of how this program works. Large parts of the program such as the actual dictionary core are hand-written. 

I also have personally been using this for months, and as I am the main user of this program I find bugs pretty often which I fix.

The assets used are AI generated. If you are an artist and want to contribute to open source, please feel free to make a real logo or a visual novel style background.

## Credits

The logo pack and six visual novel backgrounds were supplied by bee-san. See the
[asset ownership and publishing record](docs/asset-rights.md) for the original
assets and their copyright declaration.

Hachidori is powered by [hoshidicts](https://github.com/Manhhao/hoshidicts) by Manhhao. Its popup renderer, structured-content renderer, furigana segmentation, and CSS are ported from [GameSentenceMiner PR #549](https://github.com/bpwhelan/GameSentenceMiner/pull/549), which adapts [Hoshi Reader](https://github.com/Manhhao/Hoshi-Reader) and [Yomitan](https://github.com/yomidevs/yomitan). See the full [renderer attribution](extension/render/ATTRIBUTION.md).

The experimental Netflix mining's subtitle hooks are adapted from [Subadub](https://github.com/rsimmons/subadub) by Russel Simmons, under the MIT licence ([notice](distribution/licenses/subadub-LICENSE)). Its looping GIFs are encoded with [gifenc](https://github.com/mattdesl/gifenc) by Matt DesLauriers, under the MIT licence ([notice](distribution/licenses/gifenc-LICENSE)).

Headword furigana use the kanji readings of [KANJIDIC2](https://www.edrdg.org/wiki/index.php/KANJIDIC_Project). This file is the property of the [Electronic Dictionary Research and Development Group](https://www.edrdg.org/), and is used in conformance with the Group's [licence](https://www.edrdg.org/edrdg/licence.html). The readings in `extension/vendor/kanjidic/` remain under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).

## License

Hachidori is available under [GPL-3.0-or-later](LICENSE), matching hoshidicts and the ported GameSentenceMiner code.
