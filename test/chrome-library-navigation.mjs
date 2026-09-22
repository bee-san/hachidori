// SPDX-License-Identifier: GPL-3.0-or-later

export const LIBRARY_NAVIGATION_CHECK = "Library tabs keep their geometry when the page scrollbar appears or disappears";

export async function checkLibraryNavigation(puppeteer, launchOptions, settingsUrl, check) {
  // Keep native scrollbars local to this regression: popup scenarios rely on
  // Puppeteer's usual hidden scrollbars. Omit the shared suite's profile too.
  const browser = await puppeteer.launch({ ...launchOptions, userDataDir: undefined,
    ignoreDefaultArgs: ["--hide-scrollbars"] });
  try {
    await browser.waitForTarget(target => target.url() === new URL("background.js", settingsUrl).href);
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 900 });
    await page.goto(`${settingsUrl}#dictionaries`);
    await page.waitForFunction(() => document.getElementById("engine-status").textContent.startsWith("Ready"));
    // Exercise a long library independently of how many dictionaries other
    // scenarios have imported. The other panels keep their natural heights.
    await page.$eval("#dictionaries", panel => { panel.style.minHeight = "1200px"; });
    const measurements = [];
    for (const section of ["dictionaries", "add-dictionaries", "updates", "dictionary-groups", "custom-dictionary", "dictionaries"]) {
      await page.click(`#library-navigation a[href="#${section}"]`);
      await page.waitForFunction(id => !document.getElementById(id).hidden
        && document.querySelector('#library-navigation [aria-current="page"]')?.hash === `#${id}`, {}, section);
      measurements.push(await page.evaluate(section => {
        const root = document.documentElement;
        const bounds = document.getElementById("library-navigation").getBoundingClientRect();
        return { section, left: bounds.left, width: bounds.width,
          scrollbarWidth: innerWidth - root.clientWidth,
          overflowing: root.scrollHeight > root.clientHeight,
          gutter: getComputedStyle(root).scrollbarGutter };
      }, section));
    }
    check(LIBRARY_NAVIGATION_CHECK,
      measurements.some(row => row.scrollbarWidth > 0 && row.overflowing)
        && measurements.some(row => !row.overflowing)
        && measurements.every(row => row.gutter === "stable"
          && row.left === measurements[0].left && row.width === measurements[0].width),
      JSON.stringify(measurements));
  } finally {
    await browser.close();
  }
}
