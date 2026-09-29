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
      // The row only shows two or three cards, so Previous and Next themes
      // page it. Each disables (which hides it) at its end, the last pixel
      // counting as the end for fractional widths, and hands keyboard focus
      // to the other rather than dropping it.
      const previousButton = root.querySelector("#theme-store-previous");
      const nextButton = root.querySelector("#theme-store-next");
      const updateScrollButtons = () => {
        const focused = document.activeElement;
        previousButton.disabled = grid.scrollLeft <= 0;
        nextButton.disabled = grid.scrollLeft >= grid.scrollWidth - grid.clientWidth - 1;
        if (focused === nextButton && nextButton.disabled) previousButton.focus();
        else if (focused === previousButton && previousButton.disabled) nextButton.focus();
      };
      previousButton.addEventListener("click", () => grid.scrollBy({ left: -grid.clientWidth }));
      nextButton.addEventListener("click", () => grid.scrollBy({ left: grid.clientWidth }));
      grid.addEventListener("scroll", updateScrollButtons, { passive: true });
      // Also runs once the row first has a size (the store can load while
      // Design is hidden) and whenever it resizes.
      new ResizeObserver(updateScrollButtons).observe(grid);
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
