// SPDX-License-Identifier: GPL-3.0-or-later
import "./external-links.js";

export function parseCustomLinks(text) {
  return text.split(/\r?\n/u).flatMap((line, index) => {
    if (!line.trim()) return [];
    const comma = line.indexOf(",");
    const label = comma < 0 ? "" : line.slice(0, comma).trim();
    const url = line.slice(comma + 1).trim();
    if (!label || /[\u0000-\u001f\u007f]/u.test(label)
        || !globalThis.HDExternalLinks.expandCustomLinkUrl(url, { word: "word", reading: "reading", sentence: "sentence" })) {
      throw new Error(`Line ${index + 1}: enter a name, then a valid HTTP or HTTPS URL.`);
    }
    return [{ label, url }];
  });
}

const sourceFor = links => links.map(link => `${link.label}, ${link.url}`).join("\n");

export function createCustomLinkSettings({ document, readLinks, saveLinks }) {
  const editor = document.getElementById("opt-custom-links");
  const save = document.getElementById("save-custom-links");
  const discard = document.getElementById("discard-custom-links");
  const status = document.getElementById("custom-links-status");
  let baseline = sourceFor(readLinks());
  editor.value = baseline;
  const dirty = () => editor.value !== baseline;

  function updateControls() {
    save.disabled = discard.disabled = !dirty();
  }

  function reset() {
    baseline = sourceFor(readLinks());
    editor.value = baseline;
    status.textContent = "";
    updateControls();
  }

  editor.addEventListener("input", () => {
    status.textContent = "";
    updateControls();
  });
  save.addEventListener("click", () => {
    if (!dirty()) return;
    if (sourceFor(readLinks()) !== baseline) {
      status.textContent = "Links changed elsewhere. Discard this draft to load the current links before editing again.";
      return;
    }
    try {
      const links = parseCustomLinks(editor.value);
      saveLinks(links);
      reset();
    } catch (error) {
      status.textContent = error.message;
    }
  });
  discard.addEventListener("click", reset);
  updateControls();
  return { render() { if (!dirty()) reset(); }, reset, dirty };
}
