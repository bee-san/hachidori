/* SPDX-License-Identifier: GPL-3.0-or-later */
import { createLocalFileAccessController } from "./local-file-access.js";

// Keep the exercise's text nodes alive while options/inventory updates arrive:
// the ordinary reader anchors its selection, popup and Note draft to them.
export function createPracticeView({ document, onDismiss }) {
  const node = document.createElement("div");
  node.className = "setup-practice";
  node.innerHTML = `
    <p class="hint" id="setup-practice-instruction"></p>
    <div class="setup-practice-scene" id="setup-practice-scene">
      <img src="assets/practice-background.webp" width="1080" height="607" alt="A sunlit Japanese street leading to a railway crossing." />
      <div class="setup-practice-dialogue">
        <p class="setup-practice-caption">A quiet moment on the way home</p>
        <p class="setup-practice-text" id="setup-practice-text" lang="ja" tabindex="-1">踏切の向こうから蝉の声が響く。喧騒を離れて路地に佇むと、古びた<span id="setup-practice-word">辞書</span>で見つけた言葉が、目の前の景色と少しずつ結びついていく。</p>
      </div>
    </div>
    <div class="setup-practice-tools" id="setup-practice-tools">
      <button type="button" class="ghost" id="setup-practice-lookup">Look up <span lang="ja">辞書</span></button>
      <span class="hint">You can also select text to look it up.</span>
    </div>
    <p class="hint" id="setup-practice-recovery" hidden></p>
    <div id="setup-file-access"></div>`;
  const find = id => node.querySelector(`#${id}`);
  const instruction = find("setup-practice-instruction");
  const recovery = find("setup-practice-recovery");
  const lookup = find("setup-practice-lookup");
  const text = find("setup-practice-text");
  const recoveryMessage = document.createTextNode("");
  const recoveryLink = document.createElement("a");
  recoveryLink.textContent = "Settings";
  recovery.append(recoveryMessage, recoveryLink, ".");
  let readerStarted = false;
  let readerFailed = false;
  let readerReady = false;
  let currentOptions;
  let currentDictionaries;

  lookup.addEventListener("click", () => {
    // Selection is the reader's existing keyboard/precise-lookup route. No
    // synthetic lookup result or separate renderer is involved.
    text.focus({ preventScroll: true });
    const range = document.createRange();
    range.selectNodeContents(find("setup-practice-word"));
    const selection = document.defaultView.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  createLocalFileAccessController({ document, container: find("setup-file-access"), onDismiss });

  function startReader() {
    if (readerStarted) return;
    readerStarted = true;
    const script = document.createElement("script");
    script.src = "content.js";
    script.addEventListener("load", () => { readerReady = true; update(currentOptions, currentDictionaries); });
    script.addEventListener("error", () => { readerFailed = true; update(currentOptions, currentDictionaries); });
    document.body.appendChild(script);
  }

  function update(options, dictionaries) {
    currentOptions = options;
    currentDictionaries = dictionaries;
    const available = dictionaries.some(entry => entry.enabled !== false && entry.termCount > 0);
    const enabled = available && options.hoverEnabled && !readerFailed;
    const practiceFocused = document.activeElement === lookup || document.activeElement === text;
    const recoveryFocused = document.activeElement === recoveryLink;
    find("setup-practice-scene").hidden = !available;
    find("setup-practice-tools").hidden = !enabled;
    lookup.disabled = !readerReady;
    recovery.hidden = enabled;
    if (enabled) {
      instruction.textContent = options.lookupMode === "activation"
        ? `Try looking up a word below. Hold ${options.activationKey} and hover over Japanese text, or use the lookup button.`
        : "Try looking up a word below. Hover over Japanese text, or use the lookup button.";
      startReader();
      if (recoveryFocused) text.focus({ preventScroll: true });
    } else {
      instruction.textContent = "You can finish setup now and try a lookup later.";
      recoveryLink.href = available ? "settings.html#lookup"
        : dictionaries.some(entry => entry.termCount > 0) ? "settings.html#dictionaries" : "settings.html#add-dictionaries";
      recoveryMessage.textContent = !available ? "Install or enable a term dictionary in "
        : readerFailed ? "The reader could not load. Reload this page or open " : "Lookups are turned off. Enable them in ";
      if (practiceFocused) recoveryLink.focus();
    }
  }
  return { node, update };
}
