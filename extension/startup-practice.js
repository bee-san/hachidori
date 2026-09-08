/* SPDX-License-Identifier: GPL-3.0-or-later */
import { createLocalFileAccessController } from "./local-file-access.js";

function practiceInstruction(options, enabled, probing, unavailable, shortcut) {
  if (enabled) {
    const ending = shortcut ? ", or use the lookup button." : ".";
    return options.lookupMode === "activation"
      ? `Try looking up a word below. Hold ${options.activationKey} and hover over Japanese text${ending}`
      : `Try looking up a word below. Hover over Japanese text${ending}`;
  }
  if (probing) return "Checking what the installed dictionaries can answer…";
  if (unavailable) {
    return options.lookupMode === "activation"
      ? `Hold ${options.activationKey} and hover over Japanese text on any webpage to look it up.`
      : "Hover over Japanese text on any webpage to look it up.";
  }
  return "You can finish setup now and try a lookup later.";
}

// Keep the exercise's text nodes alive while options/inventory updates arrive:
// the ordinary reader anchors its selection, popup and Note draft to them.
export function createPracticeView({ document, onDismiss, loadReader }) {
  const node = document.createElement("div");
  node.className = "setup-practice";
  node.innerHTML = `
    <p class="hint" id="setup-practice-instruction"></p>
    <section class="setup-practice-scene vn-scene" id="setup-practice-scene" aria-label="Visual novel practice scene">
      <div class="setup-practice-dialogue vn-dialogue" lang="ja">
        <p class="vn-speaker">ひなた</p>
        <p class="setup-practice-text vn-line" id="setup-practice-text" lang="ja" tabindex="-1">踏切の向こうから蝉の声が響く。喧騒を離れて路地に佇むと、古びた<span id="setup-practice-word">辞書</span>で見つけた言葉が、目の前の景色と少しずつ結びついていく。</p>
      </div>
    </section>
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
  let currentOutcome;

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
    void loadReader().then(() => {
      readerReady = true;
      update(currentOptions, currentDictionaries, currentOutcome);
    }, () => {
      readerFailed = true;
      update(currentOptions, currentDictionaries, currentOutcome);
    });
  }

  function updateRecovery(available, dictionaries, outcome) {
    let section = "lookup";
    let message = "Lookups are turned off. Enable them in ";
    if (!available) {
      section = dictionaries.some(entry => entry.termCount > 0) ? "dictionaries" : "add-dictionaries";
      message = "Install or enable a term dictionary in ";
    } else if (currentOptions.hoverEnabled && readerFailed) {
      message = "The reader could not load. Reload this page or open ";
    } else if (currentOptions.hoverEnabled && outcome === "missing") {
      section = "add-dictionaries";
      message = "The installed dictionaries do not have the words in this sample yet. Install dictionaries in ";
    } else if (currentOptions.hoverEnabled && outcome === "unavailable") {
      message = "The dictionary engine could not answer. Reload this page or open ";
    }
    recoveryLink.href = `settings.html#${section}`;
    recoveryMessage.textContent = message;
  }

  function update(options, dictionaries, outcome = null) {
    currentOptions = options;
    currentDictionaries = dictionaries;
    currentOutcome = outcome;
    const available = dictionaries.some(entry => entry.enabled !== false && entry.termCount > 0);
    const probing = available && options.hoverEnabled && outcome === null;
    const answerable = outcome === "ready" || outcome === "passage";
    const enabled = available && options.hoverEnabled && answerable && !readerFailed;
    const lookupFocused = document.activeElement === lookup;
    const practiceFocused = lookupFocused || document.activeElement === text;
    const recoveryFocused = document.activeElement === recoveryLink;
    find("setup-practice-scene").hidden = !available || (options.hoverEnabled && !answerable);
    find("setup-practice-tools").hidden = !enabled;
    lookup.hidden = outcome !== "ready";
    lookup.disabled = !readerReady || lookup.hidden;
    recovery.hidden = enabled || probing;
    instruction.textContent = practiceInstruction(options, enabled, probing,
      available && options.hoverEnabled && outcome === "unavailable", !lookup.hidden);
    if (enabled) {
      startReader();
      if (recoveryFocused || (lookupFocused && lookup.hidden)) text.focus({ preventScroll: true });
    } else {
      updateRecovery(available, dictionaries, outcome);
      if (practiceFocused && !probing) recoveryLink.focus();
    }
  }
  return { node, update };
}
