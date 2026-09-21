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
  <a href="docs/sharing.md">Sharing</a> ·
  <a href="docs/chrome-web-store.md">Chrome Web Store guide</a> ·
  <a href="docs/privacy.md">Privacy</a> ·
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

Hachidori is a blazing fast Japanese Dictionary Chrome Extension that is feature rich and optionated.

## Install in 15 seconds

Click <a href="https://chromewebstore.google.com/detail/hachidori/mikpaebfdmidjnopgffchicnmoahhcbe">here to install from Chrome store.</a> (note: this will always lag behind the repo and may have bugs fixed in the repo)

Every GitHub release also ships an unsigned Firefox 153+ desktop package
(`*-firefox-unsigned.xpi`) for temporary installation; it is not on
addons.mozilla.org yet. See [the Firefox guide](docs/firefox.md); media
recording is not included in that edition.

<p align="center">
  <img src="docs/assets/install-in-60-seconds.gif" alt="Animated walkthrough of Hachidori's first-run setup, dictionary installation, Anki detection, and Japanese lookup" width="720">
</p>

# Blazing Fast

Hachidori is 83 times faster than the worlds most popular Japanese dictionary app at importing dictionaries.

<img width="1672" height="941" alt="ChatGPT Image Sep 9, 2026, 09_18_59 AM" src="https://github.com/user-attachments/assets/c507c940-f61e-4063-8d2c-9e43184cd7d3" />

See [the measured results](docs/browser-performance.md).


# Media mining

<img width="917" height="362" alt="Screenshot 2026-09-09 at 11 26 31" src="https://github.com/user-attachments/assets/c0f6d1b5-187d-45b7-9bda-aadf32879586" />

Hachidori can record your screen and capture sentence audio + a gif. Not just in Chrome but in all windows on your desktop.

This feature is **experimental** and may not work very well. I may remove it or reduce it also.

See [Media mining setup, limits, and verification](docs/media-capture.md).

# Custom Dictionary

Do you keep on seeing a name pop up over & over again in a book, but it's not in the dictionary? 

With Hachidori, you can highlight the word and add it as a custom definition.

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


# Experimental features

**Settings → Advanced → Experimental features** switches on work that is still
changing and may be removed:

- **Media mining** — the screen and audio capture above.
- **Long dictionary entries** — find entries longer than the scan length
  (proverbs, titles) without scanning further on every hover.
- **MDX dictionaries** — import MDict `.mdx` dictionaries with their `.mdd`
  resource files from **Add dictionaries**, next to Yomitan ZIPs. Choose the
  `.mdx` and its `.mdd` files together.


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

## License

Hachidori is available under [GPL-3.0-or-later](LICENSE), matching hoshidicts and the ported GameSentenceMiner code.
