// SPDX-License-Identifier: GPL-3.0-or-later
export function createThemeStore({ root, onSelect }) {
  const document = root.ownerDocument;
  const cards = new Map();
  let options;
  let loading;

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function updateSelection() {
    for (const [slug, button] of cards) {
      const selected = slug === globalThis.HDReaderOptions.popupRenderer(options.popupTheme);
      button.textContent = selected ? "Current theme" : "Use";
      button.setAttribute("aria-pressed", String(selected));
    }
  }

  async function load() {
    try {
      const response = await fetch(new URL("vendor/themes/index.json", document.baseURI));
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const { themes } = await response.json();
      const grid = root.querySelector(".theme-store-grid");
      for (const theme of themes) {
        const card = element("article", "theme-store-card");
        const image = element("img", "theme-store-preview");
        image.src = new URL(`vendor/themes/${theme.slug}/screenshot.png`, document.baseURI).href;
        image.alt = `${theme.name} dictionary popup preview`;
        const heading = element("h3", "", theme.name);
        const description = element("p", "hint", theme.description);
        const benchmark = element("a", "theme-store-benchmark", theme.benchmark);
        benchmark.href = theme.benchmarkUrl;
        benchmark.target = "_blank";
        benchmark.rel = "noopener noreferrer";
        const button = element("button", "ghost");
        button.type = "button";
        button.addEventListener("click", () => onSelect(theme.slug));
        card.append(image, heading, description, benchmark, button);
        cards.set(theme.slug, button);
        grid.append(card);
      }
      updateSelection();
    } catch (error) {
      root.querySelector(".theme-store-status").textContent = `Could not load bundled themes: ${error.message}`;
    }
  }

  return { render(next) {
    options = next;
    root.hidden = !options.experimental.themeStore;
    if (!root.hidden) loading ??= load();
    updateSelection();
  } };
}
