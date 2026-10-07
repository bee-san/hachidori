/*
 * The popup in frames, fullscreen and other tabs, and its links.
 *
 * Part of the real-Chrome suite (test/chrome-e2e.mjs); see test/README.md.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// The scenario's previous file: its steps run before the ones here.
import "./counts.mjs";
import { describe } from "node:test";
import { externalLinksFixture, kanjiReadingFuriganaFixture } from "../make-fixture.mjs";
import { check, step } from "./harness.mjs";
import { hoverForPopup } from "./popup-reader.mjs";
import { popup, tab } from "./reader.mjs";
import {
  activeExtensionWorker,
  browser,
  installMediaArchive,
  page,
  pageUrl,
  readSettingsControls,
  updateSettingsControls,
} from "./session.mjs";

async function checkFrameAndFullscreenPopups(tab, popup, pageUrl) {
  await tab.keyboard.press("Escape");
  await popup.waitForHidden();
  await tab.evaluate(src => {
    const frame = document.createElement("iframe");
    frame.id = "lookup-frame";
    frame.src = src;
    frame.style.cssText = "width: 760px; height: 420px";
    document.body.firstElementChild.before(frame);
  }, new URL("frame", pageUrl).href);
  let frameResult = null;
  try {
    const frame = await (await tab.$("#lookup-frame")).contentFrame();
    await frame.waitForSelector("#frame-verb");
    const box = await (await frame.$("#frame-verb")).boundingBox();
    for (let attempt = 0; attempt < 12 && !frameResult; attempt += 1) {
      await tab.mouse.move(2, 2);
      await tab.mouse.move(box.x + box.width * 0.15, box.y + box.height / 2);
      await frame.waitForFunction(() => {
        const host = document.querySelector("hachidori-host");
        const panel = host?.shadowRoot?.querySelector(".gsm-hoshidicts-popup");
        return panel && !panel.hidden && panel.textContent.includes("食べる");
      }, { timeout: 1500 }).then(() => { frameResult = true; }).catch(() => {});
    }
    frameResult = frameResult && await tab.evaluate(() => {
      const topPopup = document.querySelector("hachidori-host")?.shadowRoot
        ?.querySelector(".gsm-hoshidicts-popup");
      return !topPopup || topPopup.hidden;
    });
  } finally {
    await tab.$eval("#lookup-frame", element => element.remove());
  }
  check("the reader opens a popup for Japanese text inside a same-origin iframe",
    frameResult === true, `frame popup: ${frameResult}`);

  await tab.evaluate(() => {
    const player = document.createElement("div");
    player.id = "fullscreen-player";
    player.style.cssText = "width: 800px; height: 450px; padding: 24px; background: black; color: white";
    player.innerHTML = '<button id="fullscreen-button">Fullscreen</button><p><span id="fullscreen-verb">食べたかった</span></p>';
    player.querySelector("button").addEventListener("click", () => player.requestFullscreen());
    document.body.firstElementChild.before(player);
  });
  let fullscreenResult = null;
  let opened = null;
  let restored = false;
  try {
    await tab.click("#fullscreen-button");
    await tab.waitForFunction(() => !!document.fullscreenElement, { timeout: 5000 });
    opened = await hoverForPopup(tab, popup, "#fullscreen-verb");
    fullscreenResult = await tab.evaluate(() => {
      const player = document.getElementById("fullscreen-player");
      const host = document.querySelector("#fullscreen-player > hachidori-host");
      const panel = host?.shadowRoot?.querySelector(".gsm-hoshidicts-popup");
      const rect = panel?.getBoundingClientRect();
      return { mounted: host?.parentElement === player, visible: panel && !panel.hidden,
        hit: rect ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)?.localName : null };
    });
    await tab.evaluate(() => document.exitFullscreen());
    await tab.waitForFunction(() => !document.fullscreenElement &&
      document.querySelector("body > hachidori-host"), { timeout: 5000 });
    restored = await hoverForPopup(tab, popup, "#verb") !== null;
  } finally {
    await tab.evaluate(async () => {
      if (document.fullscreenElement) await document.exitFullscreen();
      document.getElementById("fullscreen-player")?.remove();
    });
  }
  check("the popup paints above a fullscreen player and returns to body on exit",
    opened !== null && fullscreenResult?.mounted && fullscreenResult.visible
      && fullscreenResult.hit === "hachidori-host" && restored,
    JSON.stringify({ opened: opened !== null, fullscreenResult, restored }));
  await tab.keyboard.press("Escape");
  await popup.waitForHidden();
  await hoverForPopup(tab, popup, "#verb");
}

// Like Yomitan (#402): once shown, the popup keeps the viewport position it
// opened at while a live chat scrolls its comment away, the page scrolls, and
// the comment leaves the DOM. Only the usual paths, here Escape, close it.
async function checkPopupStaysInPlace(tab, popup) {
  await tab.keyboard.press("Escape");
  await popup.waitForHidden();
  await tab.evaluate(() => {
    const feed = document.createElement("div");
    feed.id = "chat-feed";
    feed.style.cssText = "height: 160px; width: 480px; overflow: auto; font: 24px serif";
    feed.innerHTML = '<p id="chat-comment"><span id="chat-verb">食べたかった</span></p>'
      + "<p>コメント</p>".repeat(40);
    document.body.firstElementChild.before(feed);
    document.body.style.minHeight = "6000px";
  });
  const box = () => tab.evaluate(() => {
    const panel = document.querySelector("hachidori-host")?.shadowRoot?.querySelector(".gsm-hoshidicts-popup");
    const rect = panel?.getBoundingClientRect();
    return rect && !panel.hidden ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : null;
  });
  // Two frames let any scroll listener, observer or rAF placement run.
  const settle = () => tab.evaluate(() => new Promise(done =>
    requestAnimationFrame(() => requestAnimationFrame(done))));
  const steps = {};
  let closed = false;
  try {
    const opened = await hoverForPopup(tab, popup, "#chat-verb");
    const start = opened && await box();
    if (start) {
      // Read the popup, as a user would, while the feed moves underneath.
      await tab.mouse.move(start.left + start.width / 2, start.top + start.height / 2);
      await settle();
      steps.entered = await box();
      await tab.evaluate(() => { document.getElementById("chat-feed").scrollTop += 30; });
      await settle();
      steps.feedNudged = await box();
      await tab.evaluate(() => {
        const feed = document.getElementById("chat-feed");
        feed.scrollTop = feed.scrollHeight;
      });
      await settle();
      steps.feedScrolledPast = await box();
      await tab.evaluate(() => window.scrollBy(0, 2000));
      await settle();
      steps.pageScrolled = await box();
      steps.sourceOffscreen = await tab.evaluate(() =>
        document.getElementById("chat-verb").getBoundingClientRect().bottom < 0);
      await tab.evaluate(() => document.getElementById("chat-comment").remove());
      await settle();
      steps.sourceRemoved = await box();
    }
    await tab.keyboard.press("Escape");
    closed = await popup.waitForHidden();
    const same = rect => rect !== null && rect !== undefined && start && ["left", "top", "width", "height"]
      .every(key => rect[key] === start[key]);
    check("the popup stays in place while a chat feed or the page scrolls and after its source is removed",
      Boolean(start) && same(steps.entered) && same(steps.feedNudged) && same(steps.feedScrolledPast)
        && same(steps.pageScrolled) && steps.sourceOffscreen === true && same(steps.sourceRemoved) && closed,
      JSON.stringify({ start, ...steps, closed }));
  } finally {
    await tab.evaluate(() => {
      document.getElementById("chat-feed")?.remove();
      document.body.style.minHeight = "";
      window.scrollTo(0, 0);
    });
  }
  await hoverForPopup(tab, popup, "#verb");
}

// Like Yomitan (#432): with the default Shift key, whose popup outlives its
// release, switching to another tab and back keeps the popup, its view and a
// Note draft with keyboard focus in it. A click into one of the page's own
// frames, same-origin or cross-site, is still a click outside the popup.
async function checkTabSwitchKeepsPopup(settings, tab, popup, pageUrl) {
  const original = await readSettingsControls(settings, ["opt-activation-key", "opt-lookup-sticky"]);
  await tab.keyboard.press("Escape");
  await popup.waitForHidden();
  await tab.mouse.move(2, 2);
  await updateSettingsControls(settings, { "opt-activation-key": "Shift", "opt-lookup-sticky": true });
  const openSticky = async () => {
    const box = await (await tab.$("#verb")).boundingBox();
    await tab.mouse.move(2, 2);
    await tab.mouse.move(box.x + box.width * 0.15, box.y + box.height / 2);
    await tab.keyboard.down("Shift");
    const shown = await popup.waitForVisible();
    await tab.keyboard.up("Shift");
    return shown;
  };
  const draft = "a draft typed before leaving";
  const away = {};
  const frames = {};
  try {
    away.opened = await openSticky() !== null && await popup.click(".gsm-hoshidicts-note-button")
      && (await popup.writeNote({ definition: draft }))?.definition === draft;
    const before = await popup.retainedControls("remember");
    await settings.bringToFront();
    await new Promise(done => setTimeout(done, 600));
    await tab.bringToFront();
    const after = await popup.retainedControls();
    away.kept = popup.visible(await popup.state()) && after?.sameForm && after.mounted && after.inputFocused
      && after.draft === draft && after.selection.join() === before?.selection.join() && !after.replaced
      && after.scrollTop === before.scrollTop;
    await tab.keyboard.press("End");
    await tab.keyboard.type(" and more");
    away.typed = (await popup.retainedControls())?.draft;
    await tab.keyboard.press("Escape");
    const noteClosed = await popup.state();
    away.noteFirst = popup.visible(noteClosed) && !noteClosed.noteOpen;
    await tab.keyboard.press("Escape");
    away.closed = await popup.waitForHidden();

    const port = new URL(pageUrl).port;
    for (const [kind, src] of [["same-origin", `http://127.0.0.1:${port}/frame`], ["cross-site", `http://localhost:${port}/frame`]]) {
      await tab.evaluate(source => {
        const frame = document.createElement("iframe");
        frame.id = "click-frame";
        frame.src = source;
        frame.style.cssText = "width: 760px; height: 420px";
        document.body.firstElementChild.before(frame);
      }, src);
      try {
        await (await (await tab.$("#click-frame")).contentFrame()).waitForSelector("#frame-verb");
        const opened = await openSticky() !== null;
        const box = await (await tab.$("#click-frame")).boundingBox();
        // The frame's empty corner, beside the popup above the pushed-down word.
        const point = { x: box.x + box.width - 20, y: box.y + box.height - 20 };
        const rect = opened ? (await popup.dictionaryTabs())?.rect : null;
        const outside = Boolean(rect) && (point.x > rect.right || point.x < rect.left
          || point.y > rect.bottom || point.y < rect.top);
        await tab.mouse.click(point.x, point.y);
        frames[kind] = { opened, outside, closed: await popup.waitForHidden() };
      } finally {
        await tab.$eval("#click-frame", element => element.remove());
      }
    }
  } finally {
    // A failure can leave the Note and then the popup open.
    for (let press = 0; press < 2; press += 1) await tab.keyboard.press("Escape");
    await updateSettingsControls(settings, original);
  }
  check("switching to another tab and back keeps the popup, its Note draft and keyboard focus until Escape",
    away.opened && away.kept && away.typed === `${draft} and more` && away.noteFirst && away.closed,
    JSON.stringify(away));
  check("a click into one of the page's frames, same-origin or cross-site, still closes the popup",
    ["same-origin", "cross-site"].every(kind => frames[kind]?.opened && frames[kind].outside && frames[kind].closed),
    JSON.stringify(frames));
  await hoverForPopup(tab, popup, "#verb");
}

async function checkDeinflectionDisclosure(settings, tab, popup) {
  const native = await settings.evaluate(() => chrome.runtime.sendMessage({
    target: "hoshidicts-offscreen", type: "hd_lookup", requestId: "e2e-deinflection-trace",
    text: "食べたかった", maxResults: 1, scanLength: 16,
    options: { frequencyDictionary: "", frequencyOrder: "auto", primaryReading: "" },
  }));
  const expected = native.results?.[0];
  const closed = await popup.deinflection();
  const labels = new Map([
    ["en", ["Deinflection steps", `Why this matched: ${expected?.matched} became ${expected?.deinflected}`]],
    ["ja", ["活用解除の手順", `一致した理由: ${expected?.matched} から ${expected?.deinflected} に戻しました`]],
    ["uk", ["Кроки відновлення словникової форми", `Чому це збіглося: ${expected?.matched} перетворено на ${expected?.deinflected}`]],
  ]);
  const [stepsLabel, summaryLabel] = labels.get(closed?.language.toLowerCase().split("-")[0]) ?? labels.get("en");
  const viewport = tab.viewport();
  let focused;
  let expanded;
  let collapsed;
  let lastStep;
  let glossary;
  let note;
  try {
    await tab.bringToFront();
    await tab.setViewport({ width: 360, height: 900 });
    focused = await popup.deinflection("focus");
    await tab.keyboard.press("Enter");
    expanded = await popup.deinflection();
    await popup.click(".gsm-hoshidicts-note-button");
    note = await popup.deinflection();
    await tab.keyboard.press("Escape");
    lastStep = await popup.deinflection("last-step");
    glossary = await popup.deinflection("glossary");
    await popup.deinflection("focus");
    await tab.keyboard.press("Space");
    collapsed = await popup.deinflection();
    if (process.env.HACHIDORI_DEINFLECTION_SCREENSHOT) {
      await tab.setViewport(viewport);
      await tab.keyboard.press("Enter");
      await popup.deinflection();
      await tab.screenshot({ path: process.env.HACHIDORI_DEINFLECTION_SCREENSHOT });
      await tab.keyboard.press("Space");
    }
  } finally {
    await popup.deinflection("blur");
    await tab.setViewport(viewport);
  }
  const fitsWidth = (outer, inner) => inner?.width > 0 && inner.height > 0
    && inner.left >= outer.left - 1 && inner.right <= outer.right + 1;
  check("deinflection disclosure exposes the real ordered trace and remains keyboard reachable",
    native.ok && expected?.matched === "食べたかった" && expected.deinflected === "食べる"
      && JSON.stringify(expected.trace.map(step => step.name)) === JSON.stringify(["-た", "-たい"])
      && closed?.count === 1 && closed.open === false
      && closed.path === `${expected.matched} → ${expected.deinflected}`
      && closed.label === summaryLabel && closed.stepsLabel === stepsLabel
      && JSON.stringify(closed.steps) === JSON.stringify(expected.trace.map(({ name, description }) => ({ name, description })))
      && focused?.focused === true && expanded?.open === true && expanded.focused
      && collapsed?.open === false && collapsed.focused
      && expanded.whitespace === "pre-wrap" && expanded.summaryDisplay === "list-item"
      && expanded.marker !== "none" && expanded.noteReachable
      && expanded.popupRect.left >= 0 && expanded.popupRect.right <= 360
      && fitsWidth(expanded.popupRect, expanded.detailsRect)
      && fitsWidth(expanded.popupRect, expanded.listRect)
      && fitsWidth(expanded.popupRect, expanded.noteRect)
      // Responsive action buttons can wrap as the expanded headword gets wider;
      // the whole Note button must still be visible and usable.
      && expanded.noteRect.top >= expanded.popupRect.top && expanded.noteRect.bottom <= expanded.popupRect.bottom
      && note?.open === true && note.noteInputFocused && note.noteInputReachable
      && lastStep?.open === true && Math.abs(lastStep.toolbarScrollTop) > 0 && lastStep.lastStepReachable
      && lastStep.lastStepRect.top >= lastStep.popupRect.top
      && lastStep.lastStepRect.bottom <= lastStep.popupRect.bottom
      && glossary?.open === true && glossary.glossaryReachable,
    JSON.stringify({ expected, closed, focused, expanded, collapsed, lastStep, glossary, note }));
}

// Dictionary cards follow Yomitan: definitions are always shown, and only
// disclosures a dictionary authors inside its own content collapse.
async function checkGlossaryCardsOpen(tab, popup) {
  await tab.keyboard.press("Escape");
  await popup.waitForHidden();
  const rendered = await hoverForPopup(tab, popup, "#verb");
  const before = rendered === null ? null : await popup.glossaryCard();
  let after = null;
  if (before) {
    await tab.mouse.click(before.titlePoint.x, before.titlePoint.y);
    after = await popup.glossaryCard();
  }
  check("dictionary cards render open under a plain title with no disclosure control",
    rendered !== null && before?.count >= 1 && before.tags.every(tag => tag === "DIV") && !before.inDisclosure
      && before.titleTag === "DIV" && before.label.length > 0 && before.dictionary.length > 0
      && before.cursor !== "pointer" && before.marker === "none" && before.bodyHeight > 0
      && after?.cardHeight === before.cardHeight && after.bodyHeight === before.bodyHeight,
    JSON.stringify({ before, after }));
}

async function checkExternalLinks(browser, settings, tab, popup) {
  const sourceUrl = tab.url();
  const destinationUrl = new URL("external-reference?query=%E5%8F%82%E7%85%A7#meaning", sourceUrl).href;
  const fixture = externalLinksFixture(destinationUrl);
  const originalVerb = await tab.$eval("#verb", element => element.innerHTML);
  await installMediaArchive(settings, fixture.archive);
  const worker = await activeExtensionWorker(browser, settings, "external links");
  await worker.evaluate(() => {
    const probe = { requests: [], creates: [], pending: [], create: chrome.tabs.create };
    probe.listener = message => {
      if (message.type === "hd_open_external") probe.requests.push(message);
    };
    chrome.runtime.onMessage.addListener(probe.listener);
    chrome.tabs.create = function (properties) {
      const operation = probe.create.call(this, properties).then(tab => {
        probe.creates.push({ properties, id: tab.id, openerTabId: tab.openerTabId });
        return tab;
      });
      probe.pending.push(operation);
      return operation;
    };
    globalThis.__externalLinksProbe = probe;
  });
  const created = [];
  const onCreated = target => { if (target.type() === "page") created.push(target); };
  browser.on("targetcreated", onCreated);
  let evidence;
  try {
    await tab.$eval("#verb", (element, query) => { element.textContent = query; }, fixture.query);
    await tab.bringToFront();
    await tab.keyboard.press("Escape");
    await hoverForPopup(tab, popup, "#verb");
    const link = await popup.externalLink();
    const [target] = await Promise.all([
      browser.waitForTarget(target => target.type() === "page" && target.url() === destinationUrl, { timeout: 10_000 }),
      tab.keyboard.press("Enter"),
    ]);
    const destination = await target.page();
    const navigation = await destination.evaluate(() => ({ url: location.href, opener: window.opener !== null }));
    const afterOpen = await worker.evaluate(async () => {
      const probe = globalThis.__externalLinksProbe;
      await Promise.all(probe.pending);
      return { requests: probe.requests, creates: probe.creates };
    });
    const invalid = await settings.evaluate(() => chrome.runtime.sendMessage({
      target: "hoshidicts-worker", type: "hd_open_external", requestId: "external-invalid",
      url: "javascript:document.body.remove()",
    }));
    const afterInvalid = await worker.evaluate(() => globalThis.__externalLinksProbe.creates.length);
    await destination.close();
    await tab.bringToFront();
    await tab.keyboard.press("Escape");
    const restored = await hoverForPopup(tab, popup, "#verb");
    evidence = { link, navigation, afterOpen, afterInvalid, invalid, created: created.length,
      sourceUnchanged: tab.url() === sourceUrl, restored: restored?.text.includes("外部辞典 <reference>") };
  } finally {
    browser.off("targetcreated", onCreated);
    for (const target of created) {
      const page = await target.page();
      if (page && !page.isClosed()) await page.close();
    }
    try {
      await worker.evaluate(() => {
        const probe = globalThis.__externalLinksProbe;
        chrome.tabs.create = probe.create;
        chrome.runtime.onMessage.removeListener(probe.listener);
        delete globalThis.__externalLinksProbe;
      });
    } finally {
      await worker.detach?.();
    }
    const removed = await settings.evaluate(title => chrome.runtime.sendMessage({
      target: "hoshidicts-offscreen", type: "hd_remove", title,
    }), fixture.title);
    if (!removed.ok) throw new Error(removed.error);
    await tab.$eval("#verb", (element, html) => { element.innerHTML = html; }, originalVerb);
    await tab.bringToFront();
    await tab.keyboard.press("Escape");
  }
  check("external dictionary Enter activation creates one safe browser tab through the extension",
    evidence.link?.focused && evidence.link.href === destinationUrl && evidence.link.frames === 0
      && evidence.link.target === "_blank" && evidence.link.rel === "noopener noreferrer"
      && evidence.link.text === "外部辞典 <reference>"
      && evidence.navigation.url === destinationUrl && !evidence.navigation.opener
      && evidence.created === 1 && evidence.afterOpen.requests.length === 1 && evidence.afterOpen.creates.length === 1
      && evidence.afterOpen.requests[0].url === destinationUrl
      && evidence.afterOpen.creates[0].properties.url === destinationUrl
      && evidence.afterOpen.creates[0].properties.active === true
      && evidence.afterOpen.creates[0].openerTabId === undefined
      && evidence.invalid.ok === false && evidence.invalid.requestId === "external-invalid"
      && evidence.afterInvalid === 1 && evidence.sourceUnchanged && evidence.restored, JSON.stringify(evidence));
}

// 好き嫌い's kana allow two splits of すききらい (#459). The engine worker reads
// its kanji's KANJIDIC readings and sends the one that reads; the popup draws it.
async function checkKanjiReadingFurigana(settings, tab, popup) {
  const fixture = kanjiReadingFuriganaFixture();
  const originalVerb = await tab.$eval("#verb", element => element.innerHTML);
  await installMediaArchive(settings, fixture.archive);
  let evidence;
  try {
    const reply = await settings.evaluate(text => chrome.runtime.sendMessage({ target: "hoshidicts-offscreen",
      type: "hd_lookup", requestId: "e2e-kanji-reading-furigana", text, maxResults: 1 }), fixture.query);
    await tab.$eval("#verb", (element, query) => { element.textContent = query; }, fixture.query);
    await tab.bringToFront();
    await tab.keyboard.press("Escape");
    const shown = await hoverForPopup(tab, popup, "#verb", { accept: state => state.plain.includes(fixture.query) });
    evidence = { furigana: reply?.results?.[0]?.term?.furigana, rubies: shown?.furiganaAlignment.rubies,
      headword: shown?.text.includes("好すき嫌きらい") };
  } catch (error) {
    evidence = { error: error.message };
  } finally {
    await tab.keyboard.press("Escape");
    const removed = await settings.evaluate(title => chrome.runtime.sendMessage({
      target: "hoshidicts-offscreen", type: "hd_remove", title,
    }), fixture.title);
    if (!removed.ok) throw new Error(removed.error);
    await tab.$eval("#verb", (element, html) => { element.innerHTML = html; }, originalVerb);
  }
  check("an ambiguous headword's furigana is split by its kanji's KANJIDIC readings in the engine worker and the popup",
    JSON.stringify(evidence) === JSON.stringify({ furigana: [{ text: "好", reading: "す" }, { text: "き", reading: "" },
      { text: "嫌", reading: "きら" }, { text: "い", reading: "" }], rubies: 2, headword: true }),
    JSON.stringify(evidence));
}

// Issue #430: a custom link's %s is the sentence Anki gets, read the same way
// for a hover and for a selection inside an inline element or across ruby.
// The worker's tab creation is recorded instead of opening the URL.
async function checkCustomLinkSentence(browser, settings, tab, popup) {
  const writeButtons = customButtons => settings.evaluate(async buttons => {
    const { options } = await chrome.storage.local.get("options");
    const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
      baseRevision: options.revision, options: { customButtons: buttons } });
    if (!reply.ok) throw new Error(reply.error);
  }, customButtons);
  const { options } = await settings.evaluate(() => chrome.storage.local.get("options"));
  const worker = await activeExtensionWorker(browser, settings, "custom link sentence");
  const opened = {};
  try {
    await worker.evaluate(() => {
      const probe = { urls: [], create: chrome.tabs.create };
      chrome.tabs.create = async properties => { probe.urls.push(properties.url); return { id: -1 }; };
      globalThis.__customLinkProbe = probe;
    });
    await writeButtons([{ id: "e2e-sentence-link", type: "link", label: "Sentence",
      url: "https://example.test/?w=%w&r=%r&s=%s" }]);
    await tab.bringToFront();
    await tab.keyboard.press("Escape");
    await popup.waitForHidden();
    await tab.evaluate(() => {
      const lines = document.createElement("div");
      lines.id = "link-sentences";
      lines.innerHTML = '<p>昨日、<span id="link-verb">食べたかった</span>。とてもおいしかった。</p>'
        + '<p>彼は<ruby id="link-ruby">漢字<rt>かんじ</rt></ruby>を読む。</p>';
      document.body.prepend(lines);
    });
    const clickLink = async () => {
      const count = await worker.evaluate(() => globalThis.__customLinkProbe.urls.length);
      await popup.click(".gsm-hoshidicts-external-link-button");
      const url = await worker.evaluate(async before => {
        const { urls } = globalThis.__customLinkProbe;
        for (let attempt = 0; attempt < 50 && urls.length <= before; attempt++) {
          await new Promise(done => setTimeout(done, 100));
        }
        return urls.at(-1) ?? null;
      }, count);
      await tab.keyboard.press("Escape");
      await popup.waitForHidden();
      const params = new URL(url).searchParams;
      return Object.fromEntries(["w", "r", "s"].map(marker => [marker, params.get(marker)]));
    };
    const selectLink = async (selector, end, expression) => {
      await tab.$eval(selector, (element, offset) => {
        getSelection().setBaseAndExtent(element.firstChild, 0, element.firstChild, offset);
      }, end);
      await popup.waitForVisible(10_000, state => state.plain.includes(expression));
      return clickLink();
    };
    await hoverForPopup(tab, popup, "#link-verb", { accept: state => state.plain.includes("食べる") });
    opened.hover = await clickLink();
    opened.inline = await selectLink("#link-verb", 3, "食べる");
    opened.ruby = await selectLink("#link-ruby", 2, "漢字");
  } catch (error) {
    opened.error = error.message;
  } finally {
    await tab.evaluate(() => {
      getSelection().removeAllRanges();
      document.getElementById("link-sentences")?.remove();
    });
    await writeButtons(options.customButtons);
    try {
      await worker.evaluate(() => {
        chrome.tabs.create = globalThis.__customLinkProbe.create;
        delete globalThis.__customLinkProbe;
      });
    } finally {
      await worker.detach?.();
    }
  }
  check("a custom link's %s is the hovered or selected word's sentence without ruby readings",
    JSON.stringify(opened) === JSON.stringify({
      hover: { w: "食べる", r: "たべる", s: "昨日、食べたかった。" },
      inline: { w: "食べた", r: "", s: "昨日、食べたかった。" },
      ruby: { w: "漢字", r: "かんじ", s: "彼は漢字を読む。" },
    }), JSON.stringify(opened));
}

describe("popup", () => {
  step("frames and fullscreen", async () => {
    await tab.bringToFront();
    await checkFrameAndFullscreenPopups(tab, popup, pageUrl);
  });

  step("the popup stays in place", async () => {
    await checkPopupStaysInPlace(tab, popup);
  });

  step("switching tabs keeps the popup", async () => {
    await checkTabSwitchKeepsPopup(page, tab, popup, pageUrl);
  });

  step("deinflection disclosure", async () => {
    await checkDeinflectionDisclosure(page, tab, popup);
  });

  step("glossary cards open", async () => {
    await checkGlossaryCardsOpen(tab, popup);
  });

  step("external links", async () => {
    await checkExternalLinks(browser, page, tab, popup);
  });

  step("a custom link's sentence", async () => {
    await checkCustomLinkSentence(browser, page, tab, popup);
  });

  step("kanji reading furigana", async () => {
    await checkKanjiReadingFurigana(page, tab, popup);
  });
});
