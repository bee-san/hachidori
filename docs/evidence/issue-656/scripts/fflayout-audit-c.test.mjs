// Follow-up audit probe for PR #663 (#656), check 1 in Firefox
// (audit-hachi-issue-656-c): the search page header with the Anki Template
// menu at several widths and name lengths, in both documents (search.html and
// its sandboxed frame), in a popup window resized with windows.update, because
// WebDriver BiDi's setViewport refuses extension pages. Extends
// audit-hachi-issue-656-b's fflayout.test.mjs with the header's rows, the shell
// header's own overflow and whether the switch is wholly inside the window.
//   cd <worktree> && HACHIDORI_FIREFOX=... HACHIDORI_PUPPETEER=... \
//     HACHIDORI_FIREFOX_EXTENSION=<worktree>/test/tmp/firefox-extension \
//     AUDIT_ROOT=<worktree> AUDIT_LABEL=<label> node --test --test-force-exit fflayout.test.mjs
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

const ROOT = process.env.AUDIT_ROOT;
const LABEL = process.env.AUDIT_LABEL || "ff-159";
const OUT = process.env.OUT || "/local/home/skerraut/herd-synth3/reports/audit-hachi-issue-656-c-evidence/probes";
const session = await import(resolve(ROOT, "test/firefox-e2e/session.mjs"));
const WIDTHS = (process.env.WIDTHS || "600,560,520,512,500,480,460,420,320,240,200").split(",").map(Number);
const SWEEP = process.env.SWEEP === "1";
const STEP = Number(process.env.STEP || 4);
const NAMES = {
  single: ["Sentences with audio and a picture"],
  short: ["Sentences", "Words", "Kanji"],
  n25: ["Sentence cards with audio", "Words", "Kanji"],
  n34: ["Sentences with audio and a picture", "Words", "Kanji"],
  n55: ["Lapis sentence cards with audio, a picture and a sketch", "Words", "Kanji"],
};
const SETS = (process.env.SETS || "single,short,n25,n34,n55").split(",");

// Runs in either document and returns JSON text.
const MEASURE = () => {
  const header = document.querySelector(".search-header");
  const h1 = header.querySelector("h1");
  const select = header.querySelector(".search-template");
  const label = header.querySelector(".lookup-enable");
  const span = label.querySelector("span");
  const input = label.querySelector("input");
  const img = header.querySelector("img");
  const lines = (element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    return new Set([...range.getClientRects()].map(rect => Math.round(rect.top))).size;
  };
  const rect = (element) => {
    const r = element.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right };
  };
  const shown = Boolean(select && !select.hidden);
  let own = null;
  if (shown) {
    select.style.cssText = "flex: none; width: max-content; min-width: 0; max-width: none";
    own = select.getBoundingClientRect().width;
    select.style.cssText = "";
  }
  const at = (element) => {
    const r = element.getBoundingClientRect();
    return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === element;
  };
  const items = [["img", img], ["h1", h1], ["menu", shown ? select : null], ["label", label]]
    .filter(([, element]) => element && element.getClientRects().length);
  const rows = [];
  for (const [name, element] of items) {
    const r = element.getBoundingClientRect();
    const mid = r.top + r.height / 2;
    const row = rows.find(candidate => Math.abs(candidate.mid - mid) < 12 && r.top < candidate.bottom);
    if (row) { row.items.push(name); row.right = r.right; row.bottom = Math.max(row.bottom, r.bottom); }
    else rows.push({ mid, top: r.top, bottom: r.bottom, left: r.left, right: r.right, items: [name] });
  }
  const hr = header.getBoundingClientRect();
  const edges = items.map(([, element]) => element.getBoundingClientRect());
  const style = shown ? getComputedStyle(select) : null;
  return JSON.stringify({
    innerWidth, dpr: devicePixelRatio,
    minLeft: Math.min(...edges.map(r => r.left)), maxRight: Math.max(...edges.map(r => r.right)),
    imgLeft: img.getBoundingClientRect().left,
    header: { ...rect(header), clientWidth: header.clientWidth, scrollWidth: header.scrollWidth },
    img: rect(img),
    h1: { ...rect(h1), lines: lines(h1), fontSize: getComputedStyle(h1).fontSize },
    select: shown ? { ...rect(select), own, fontSize: style.fontSize, flex: style.flex, minWidth: style.minWidth,
      maxWidth: style.maxWidth } : null,
    label: { ...rect(label), lines: lines(span) },
    input: rect(input),
    reachable: { select: shown ? at(select) : null, input: at(input) },
    rows: rows.map(row => ({ items: row.items, startGap: Math.round((row.left - hr.left) * 100) / 100,
      endGap: Math.round((hr.right - row.right) * 100) / 100 })),
    wrap: getComputedStyle(header).flexWrap,
  });
};

test("audit layout probe", { timeout: 2_400_000 }, async () => {
  const results = { label: LABEL, sets: {} };
  try {
    await session.startSession();
    results.version = await session.browser.version();
    for (const set of SETS) {
      await session.writeOptions(session.page, { anki: await session.evaluateJson(session.page, async (json) => {
        const names = JSON.parse(json);
        const { options } = await chrome.storage.local.get("options");
        const anki = globalThis.HDReaderOptions.normaliseOptions(options).anki;
        return JSON.stringify(globalThis.HDReaderOptions.normaliseAnki({ url: anki.url, apiKey: anki.apiKey,
          templates: names.map((name, index) => ({ ...anki.templates[0], id: index === 0 ? anki.templates[0].id : `t${index}`, name })) }));
      }, JSON.stringify(NAMES[set])) });
      const windowId = await session.evaluateJson(session.page, async () => {
        const url = chrome.runtime.getURL("search.html");
        for (const context of await chrome.runtime.getContexts({ contextTypes: ["TAB"], documentUrls: [url] })) {
          await chrome.windows.remove(context.windowId).catch(() => {});
        }
        const created = await chrome.windows.create({ url, type: "popup", width: 640, height: 640 });
        return JSON.stringify(created.id);
      });
      await session.sleep(1500);
      const search = await session.findPage("search.html");
      const frame = await session.childFrame(search, "search-frame.html");
      await session.waitFor(() => frame.evaluate(() => !document.getElementById("search-submit").disabled), { timeout: 60_000 });
      if (set !== "single") {
        await session.waitFor(() => frame.evaluate(() => !document.querySelector("select.search-template").hidden), { timeout: 30_000 });
        await session.waitFor(() => search.evaluate(() => !document.getElementById("search-template").hidden), { timeout: 30_000 });
      } else {
        await session.sleep(800);
      }
      const chromeDelta = await search.evaluate(() => window.outerWidth - window.innerWidth);
      results.chromeDelta = chromeDelta;
      const measure = async () => {
        const shell = JSON.parse(await search.evaluate(MEASURE));
        const copy = JSON.parse(await frame.evaluate(MEASURE));
        const keys = ["x", "y", "width", "height"];
        const delta = (a, b) => Math.max(...keys.map(k => Math.abs(a[k] - b[k])));
        const sel = copy.select;
        const sixEm = sel ? 6 * parseFloat(sel.fontSize) : null;
        const wrapped = copy.h1.lines > 1 || copy.label.lines > 1;
        const rows = copy.rows;
        const rowOf = name => rows.findIndex(row => row.items.includes(name));
        const titleAtStart = rowOf("h1") === 0 && rows[0].items[0] === "img" && rows[0].items[1] === "h1" && Math.abs(rows[0].startGap) < 0.5;
        const labelRow = rowOf("label");
        const labelAtEnd = labelRow >= 0 && rows[labelRow].items.at(-1) === "label" && rows[labelRow].endGap < 0.5;
        const menuRow = rowOf("menu");
        const menuAtEnd = menuRow < 0 ? null : (rows[menuRow].items.at(-1) === "menu" ? rows[menuRow].endGap < 0.5
          : rows[menuRow].items.at(-1) === "label" && rows[menuRow].items.at(-2) === "menu" && labelAtEnd);
        return {
          innerWidth: shell.innerWidth, lines: [copy.h1.lines, copy.label.lines], shellLines: [shell.h1.lines, shell.label.lines],
          menu: sel ? Math.round(sel.width * 100) / 100 : null, own: sel ? Math.round(sel.own * 100) / 100 : null, sixEm,
          menuAtMin: sel ? Math.abs(sel.width - sixEm) < 0.5 : null, belowMin: sel ? sel.width < sixEm - 0.5 : null,
          wrapped, wrapBeforeMin: sel ? wrapped && sel.width > sixEm + 0.5 : null,
          overflow: copy.header.scrollWidth > copy.header.clientWidth || copy.label.right > copy.header.right + 0.5
            || shell.input.right > shell.innerWidth || shell.label.right > shell.header.right + 0.5
            || shell.header.scrollWidth > shell.header.clientWidth
            || copy.minLeft < copy.header.x - 0.5 || shell.minLeft < shell.header.x - 0.5
            || copy.maxRight > copy.header.right + 0.5 || shell.maxRight > shell.header.right + 0.5 || shell.imgLeft < -0.01,
          startOverflow: copy.minLeft < copy.header.x - 0.5 || shell.minLeft < shell.header.x - 0.5,
          switchInside: shell.input.right <= shell.innerWidth + 0.01 && shell.input.x >= -0.01,
          rows: rows.map(row => row.items.join("+")), titleAtStart, labelAtEnd, menuAtEnd, wrapRule: copy.wrap,
          header: { width: copy.header.width, clientWidth: copy.header.clientWidth, scrollWidth: copy.header.scrollWidth,
            height: copy.header.height },
          geometry: { header: [copy.header.x, copy.header.y, copy.header.width, copy.header.height],
            h1: [copy.h1.x, copy.h1.y, copy.h1.width, copy.h1.height], label: [copy.label.x, copy.label.y, copy.label.width, copy.label.height] },
          switchRight: shell.input.right, reachable: shell.reachable,
          aligned: { h1: delta(shell.h1, copy.h1), select: sel && shell.select ? delta(shell.select, sel) : (sel || shell.select ? 999 : 0),
            label: delta(shell.label, copy.label), input: delta(shell.input, copy.input), img: delta(shell.img, copy.img),
            header: delta(shell.header, copy.header) },
        };
      };
      const setWidth = async (width) => {
        await session.evaluateJson(session.page, async (id, outer) => {
          await chrome.windows.update(id, { width: outer });
          return "null";
        }, windowId, width + chromeDelta);
        await session.waitFor(() => search.evaluate(target => innerWidth === target, width), { timeout: 5000, interval: 50 });
        await session.sleep(80);
      };
      const byWidth = {};
      for (const width of WIDTHS) {
        await setWidth(width);
        byWidth[width] = await measure();
        const m = byWidth[width];
        console.log(`PROBE ${set} ${width} css=${m.innerWidth} lines=${m.lines} shellLines=${m.shellLines} menu=${m.menu} own=${m.own}`
          + ` 6em=${m.sixEm} atMin=${m.menuAtMin} wrapBeforeMin=${m.wrapBeforeMin} overflow=${m.overflow} switchInside=${m.switchInside}`
          + ` rows=${JSON.stringify(m.rows)} h=${m.header.height} titleStart=${m.titleAtStart} labelEnd=${m.labelAtEnd} menuEnd=${m.menuAtEnd}`
          + ` reach=${JSON.stringify(m.reachable)} maxDelta=${Math.max(...Object.values(m.aligned)).toFixed(3)}`);
      }
      let sweep = null;
      if (SWEEP) {
        sweep = [];
        for (let width = 640; width >= 200; width -= STEP) {
          await setWidth(width);
          const m = await measure();
          sweep.push({ width, innerWidth: m.innerWidth, lines: m.lines, shellLines: m.shellLines, menu: m.menu, menuAtMin: m.menuAtMin,
            belowMin: m.belowMin, wrapBeforeMin: m.wrapBeforeMin, overflow: m.overflow, startOverflow: m.startOverflow,
            switchInside: m.switchInside,
            reachable: m.reachable, rows: m.rows, titleAtStart: m.titleAtStart, labelAtEnd: m.labelAtEnd, menuAtEnd: m.menuAtEnd,
            height: m.header.height, geometry: m.geometry, maxDelta: Math.max(...Object.values(m.aligned)) });
        }
        const first = predicate => sweep.find(predicate)?.width ?? null;
        const layouts = [...new Set(sweep.map(m => m.rows.join(" | ")))];
        const summary = { firstMenuAtMin: first(m => m.menuAtMin === true), firstWrap: first(m => m.lines.some(n => n > 1)),
          firstTitleWrap: first(m => m.lines[0] > 1), firstLabelWrap: first(m => m.lines[1] > 1),
          firstRowBreak: first(m => m.rows.length > 1),
          firstOverflow: first(m => m.overflow), firstStartOverflow: first(m => m.startOverflow),
          firstUnreachable: first(m => !m.reachable.input || m.reachable.select === false),
          firstSwitchOutside: first(m => !m.switchInside),
          anyWrapBeforeMin: sweep.filter(m => m.wrapBeforeMin === true).map(m => m.width),
          anyBelowMin: sweep.filter(m => m.belowMin === true).map(m => m.width),
          notTitleAtStart: sweep.filter(m => !m.titleAtStart).map(m => m.width),
          notLabelAtEnd: sweep.filter(m => !m.labelAtEnd).map(m => m.width),
          notMenuAtEnd: sweep.filter(m => m.menuAtEnd === false).map(m => m.width),
          shellLinesDiffer: sweep.filter(m => JSON.stringify(m.lines) !== JSON.stringify(m.shellLines)).map(m => m.width),
          maxDelta: Math.max(...sweep.map(m => m.maxDelta)) };
        const layoutRanges = layouts.map((layout) => {
          const widths = sweep.filter(m => m.rows.join(" | ") === layout).map(m => m.width);
          return { layout, from: Math.max(...widths), to: Math.min(...widths), count: widths.length,
            heights: [...new Set(sweep.filter(m => m.rows.join(" | ") === layout).map(m => Math.round(m.height)))] };
        });
        console.log(`PROBE ${set} sweep ${JSON.stringify(summary)}`);
        for (const range of layoutRanges) console.log(`PROBE ${set}   ${range.from}..${range.to} (${range.count}) ${range.layout} heights=${range.heights}`);
        sweep = { ...summary, layoutRanges, points: sweep };
      }
      results.sets[set] = { names: NAMES[set], byWidth, sweep };
      await session.evaluateJson(session.page, async (id) => { await chrome.windows.remove(id); return "null"; }, windowId);
      await session.sleep(500);
    }
  } catch (error) {
    results.error = String(error?.stack ?? error);
    throw error;
  } finally {
    writeFileSync(resolve(OUT, `${LABEL}.json`), JSON.stringify(results, null, 1));
  }
});
