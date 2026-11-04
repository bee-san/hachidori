// Follow-up audit probe for PR #663 (#656), check 1 (audit-hachi-issue-656-c):
// the search page header with the Anki Template menu, in real Chrome, at several
// widths and name lengths, in both documents (search.html and its sandboxed
// frame). Extends audit-hachi-issue-656-b's layout.mjs with the header's rows
// (the title at the start of row 1, the menu and the Clipboard monitor at the
// ends of their rows), the shell header's own overflow, and rects to compare a
// one-Template header with main's.
//   node layout.mjs <worktree> <label> [chromeBuild]
// Environment:
//   FONTPREF=default20|min20  seed the profile's Default/Preferences
//   ZOOM=1.25                 chrome.tabs.setZoom on the search tab
//   CSS="<css>"               extra CSS appended to both documents (a mutation)
//   SETS=single,short,n25,n34,n55  which name sets
//   WIDTHS=600,...            the listed widths (default below)
//   SWEEP=1                   also sweep every 2 px from 640 down to 200
//   SHOTW=600,420,...         widths screenshotted for SHOTSETS (default n34)
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const [ROOT, LABEL, BUILD = "152.0.7977.75"] = process.argv.slice(2);
const OUT = process.env.OUT || "/local/home/skerraut/herd-synth3/reports/audit-hachi-issue-656-c-evidence/probes";
mkdirSync(OUT, { recursive: true });
const require = createRequire(resolve(ROOT, "test/tooling/package.json"));
const { default: puppeteer } = await import(require.resolve("puppeteer-core"));
const { Browser, computeExecutablePath } = await import(require.resolve("@puppeteer/browsers"));
const EXTENSION = resolve(ROOT, "extension");
const PROFILE = mkdtempSync(resolve(tmpdir(), `audit656c-${LABEL}-`));
const FONTPREF = process.env.FONTPREF || "";
const ZOOM = Number(process.env.ZOOM || 1);
const CSS = process.env.CSS || "";
const WIDTHS = (process.env.WIDTHS || "600,560,520,512,500,480,460,420,320").split(",").map(Number);
const SWEEP = process.env.SWEEP === "1";
const SHOTW = (process.env.SHOTW || "600,480,320").split(",").map(Number);
const SHOTSETS = (process.env.SHOTSETS || "n34").split(",");
const NAMES = {
  single: [[null, "Sentences with audio and a picture"]],
  short: [[null, "Sentences"], ["words", "Words"], ["kanji", "Kanji"]],
  n25: [[null, "Sentence cards with audio"], ["words", "Words"], ["kanji", "Kanji"]],
  n34: [[null, "Sentences with audio and a picture"], ["words", "Words"], ["kanji", "Kanji"]],
  n55: [[null, "Lapis sentence cards with audio, a picture and a sketch"], ["words", "Words"], ["kanji", "Kanji"]],
};
for (const [key, length] of [["n25", 25], ["n34", 34], ["n55", 55]]) {
  if (NAMES[key][0][1].length !== length) throw new Error(`${key} is ${NAMES[key][0][1].length} characters`);
}
const SETS = (process.env.SETS || "short,n25,n34,n55").split(",");
const results = { label: LABEL, build: BUILD, fontPref: FONTPREF, zoom: ZOOM, css: CSS, sets: {} };
const sleep = ms => new Promise(done => { setTimeout(done, ms); });

if (FONTPREF) {
  mkdirSync(resolve(PROFILE, "Default"), { recursive: true });
  const webprefs = FONTPREF === "default20" ? { default_font_size: 20 } : { minimum_font_size: 20 };
  writeFileSync(resolve(PROFILE, "Default/Preferences"), JSON.stringify({ webkit: { webprefs } }));
}

const browser = await puppeteer.launch({
  executablePath: computeExecutablePath({ cacheDir: resolve(ROOT, "test/tmp/browsers"), browser: Browser.CHROME, buildId: BUILD }),
  enableExtensions: true, headless: true, userDataDir: PROFILE, protocolTimeout: 240_000,
  args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", `--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
});
let exitCode = 0;
try {
  results.version = await browser.version();
  const worker = await browser.waitForTarget(t => t.type() === "service_worker" && t.url().startsWith("chrome-extension://"),
    { timeout: 60_000 });
  const id = new URL(worker.url()).host;
  const searchUrl = `chrome-extension://${id}/search.html`;
  const frameUrl = `chrome-extension://${id}/search-frame.html`;
  const settings = await browser.newPage();
  await settings.goto(`chrome-extension://${id}/settings.html`, { waitUntil: "load" });
  for (const page of await browser.pages()) if (page.url().endsWith("/startup.html")) await page.close();
  const setTemplates = list => settings.evaluate(async (list) => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const { options } = await chrome.storage.local.get("options");
      const anki = globalThis.HDReaderOptions.normaliseOptions(options).anki;
      const next = globalThis.HDReaderOptions.normaliseAnki({ url: anki.url, apiKey: anki.apiKey,
        templates: list.map(([tid, name]) => ({ ...anki.templates[0], id: tid ?? anki.templates[0].id, name })) });
      const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
        baseRevision: options?.revision ?? 0, options: { anki: next } });
      if (reply?.ok) return next.templates.map(t => t.name);
      if (!reply?.conflict) throw new Error(reply?.error ?? "no reply");
    }
    throw new Error("conflicts");
  }, list);

  // What each document lays out in its header.
  const measureIn = target => target.evaluate((css) => {
    if (css && !document.getElementById("audit-css")) {
      const style = document.createElement("style");
      style.id = "audit-css";
      style.textContent = css;
      document.head.append(style);
    }
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
      return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
    };
    const shown = Boolean(select && !select.hidden);
    const style = select ? getComputedStyle(select) : null;
    // The menu's own width, as it lays out without the flex rules.
    let own = null;
    if (shown) {
      select.style.cssText = "flex: none; width: max-content; min-width: 0; max-width: none";
      own = select.getBoundingClientRect().width;
      select.style.cssText = "";
    }
    const center = r => [r.x + r.width / 2, r.y + r.height / 2];
    const at = (element) => {
      const [x, y] = center(element.getBoundingClientRect());
      return document.elementFromPoint(x, y) === element;
    };
    // The header's rows: its laid-out children grouped by their vertical centre.
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
    // The leftmost and rightmost edges of the header's laid-out children: with
    // justify-content: flex-end an overflowing line spills past the header's
    // start, which scrollWidth does not count.
    const edges = items.map(([, element]) => element.getBoundingClientRect());
    const minLeft = Math.min(...edges.map(r => r.left));
    const maxRight = Math.max(...edges.map(r => r.right));
    return {
      innerWidth, dpr: devicePixelRatio,
      minLeft, maxRight, imgLeft: img.getBoundingClientRect().left,
      header: { ...rect(header), clientWidth: header.clientWidth, scrollWidth: header.scrollWidth },
      img: rect(img),
      h1: { ...rect(h1), lines: lines(h1), fontSize: getComputedStyle(h1).fontSize },
      select: shown ? { ...rect(select), own, fontSize: style.fontSize, minWidth: style.minWidth, maxWidth: style.maxWidth,
        flex: style.flex, hidden: select.hidden, value: select.value } : null,
      label: { ...rect(label), lines: lines(span), fontSize: getComputedStyle(span).fontSize },
      input: rect(input),
      reachable: { select: shown ? at(select) : null, input: at(input) },
      rows: rows.map(row => ({ items: row.items, startGap: Math.round((row.left - hr.left) * 100) / 100,
        endGap: Math.round((hr.right - row.right) * 100) / 100, top: Math.round(row.top - hr.top) })),
      wrapRule: getComputedStyle(header).flexWrap, justify: getComputedStyle(header).justifyContent,
      h1MarginRight: getComputedStyle(h1).marginRight,
    };
  }, CSS);

  const frames = async (tab) => {
    for (let i = 0; i < 300; i += 1) {
      const frame = tab.frames().find(f => f.url() === frameUrl);
      if (frame) return frame;
      await sleep(50);
    }
    throw new Error("no frame");
  };
  const settle = target => target.evaluate(() => new Promise(done => {
    requestAnimationFrame(() => requestAnimationFrame(() => done()));
  }));
  // Both documents' headers, and how they compare.
  async function measure(tab, frame) {
    await settle(tab);
    await settle(frame);
    const [shell, copy] = [await measureIn(tab), await measureIn(frame)];
    const keys = ["x", "y", "width", "height"];
    const delta = (a, b) => Math.max(...keys.map(k => Math.abs(a[k] - b[k])));
    const sel = copy.select;
    const sixEm = sel ? 6 * parseFloat(sel.fontSize) : null;
    const wrapped = copy.h1.lines > 1 || copy.label.lines > 1;
    const startOverflow = copy.minLeft < copy.header.x - 0.5 || shell.minLeft < shell.header.x - 0.5;
    const endOverflow = copy.maxRight > copy.header.right + 0.5 || shell.maxRight > shell.header.right + 0.5;
    const overflow = copy.header.scrollWidth > copy.header.clientWidth || copy.label.right > copy.header.right + 0.5
      || shell.input.right > shell.innerWidth || shell.label.right > shell.header.right + 0.5
      || shell.header.scrollWidth > shell.header.clientWidth || startOverflow || endOverflow
      || shell.imgLeft < -0.01;
    const rows = copy.rows;
    const rowOf = name => rows.findIndex(row => row.items.includes(name));
    // The title starts row 1 (after the icon); the label ends its row at the
    // header's end; the menu ends its row, or is just before the label on it.
    const titleAtStart = rowOf("h1") === 0 && rows[0].items[0] === "img" && rows[0].items[1] === "h1" && Math.abs(rows[0].startGap) < 0.5;
    const labelRow = rowOf("label");
    const labelAtEnd = labelRow >= 0 && rows[labelRow].items.at(-1) === "label" && rows[labelRow].endGap < 0.5;
    const menuRow = rowOf("menu");
    const menuAtEnd = menuRow < 0 ? null : (rows[menuRow].items.at(-1) === "menu" ? rows[menuRow].endGap < 0.5
      : rows[menuRow].items.at(-1) === "label" && rows[menuRow].items.at(-2) === "menu" && labelAtEnd);
    return {
      innerWidth: shell.innerWidth, dpr: shell.dpr,
      lines: [copy.h1.lines, copy.label.lines], shellLines: [shell.h1.lines, shell.label.lines],
      menu: sel ? Math.round(sel.width * 100) / 100 : null, own: sel ? Math.round(sel.own * 100) / 100 : null,
      sixEm, menuAtMin: sel ? Math.abs(sel.width - sixEm) < 0.5 : null, belowMin: sel ? sel.width < sixEm - 0.5 : null,
      atOwn: sel ? Math.abs(sel.width - sel.own) < 0.5 : null,
      gapToLabel: sel && menuRow === labelRow ? Math.round((copy.label.x - sel.right) * 100) / 100 : null,
      labelEndsHeader: Math.abs(copy.label.right - copy.header.right) < 0.5,
      wrapped, wrapBeforeMin: sel ? wrapped && sel.width > sixEm + 0.5 : null, overflow, startOverflow, endOverflow,
      startSpill: Math.round(Math.max(copy.header.x - copy.minLeft, 0) * 100) / 100, imgLeft: shell.imgLeft,
      // What the chrome-e2e step's 320-pixel check computes (frame header taller
      // than 40 px and scrollWidth <= clientWidth; the shell's switch inside).
      e2ePredicate: copy.header.height > 40 && copy.header.scrollWidth <= copy.header.clientWidth && shell.input.right <= shell.innerWidth,
      rows: rows.map(row => row.items.join("+")), rowCount: rows.length, titleAtStart, labelAtEnd, menuAtEnd,
      header: { width: copy.header.width, clientWidth: copy.header.clientWidth, scrollWidth: copy.header.scrollWidth,
        height: copy.header.height, shellScrollWidth: shell.header.scrollWidth, shellClientWidth: shell.header.clientWidth },
      switchRight: shell.input.right, switchInside: shell.input.right <= shell.innerWidth + 0.01 && shell.input.x >= -0.01,
      reachable: shell.reachable,
      aligned: {
        h1: delta(shell.h1, copy.h1), select: sel && shell.select ? delta(shell.select, sel) : (sel || shell.select ? 999 : 0),
        label: delta(shell.label, copy.label), input: delta(shell.input, copy.input), img: delta(shell.img, copy.img),
        header: delta(shell.header, copy.header),
      },
      geometry: { header: [copy.header.x, copy.header.y, copy.header.width, copy.header.height],
        h1: [copy.h1.x, copy.h1.y, copy.h1.width, copy.h1.height], label: [copy.label.x, copy.label.y, copy.label.width, copy.label.height],
        input: [shell.input.x, shell.input.y, shell.input.width, shell.input.height] },
      fonts: { h1: copy.h1.fontSize, select: sel?.fontSize ?? null, label: copy.label.fontSize },
      css: { wrap: copy.wrapRule, justify: copy.justify, h1MarginRight: copy.h1MarginRight,
        ...(sel ? { flex: sel.flex, minWidth: sel.minWidth, maxWidth: sel.maxWidth } : {}) },
    };
  }

  for (const set of SETS) {
    const names = await setTemplates(NAMES[set]);
    const tab = await browser.newPage();
    await tab.setViewport({ width: WIDTHS[0], height: 640 });
    await tab.goto(searchUrl, { waitUntil: "load" });
    const frame = await frames(tab);
    await tab.waitForFunction(() => !document.querySelector(".search-shell-header").hidden, { polling: 100, timeout: 60_000 });
    await frame.waitForFunction(() => !document.getElementById("search-submit").disabled, { polling: 100, timeout: 60_000 });
    if (set !== "single") {
      await tab.waitForFunction(() => !document.getElementById("search-template")?.hidden, { polling: 100, timeout: 60_000 });
      await frame.waitForFunction(() => !document.querySelector("select.search-template")?.hidden, { polling: 100, timeout: 60_000 });
    } else {
      await sleep(500);
    }
    await tab.evaluate(() => document.fonts.ready);
    await frame.evaluate(() => document.fonts.ready);
    if (ZOOM !== 1) {
      results.zoomApplied = await tab.evaluate(async (zoom) => {
        const current = await chrome.tabs.getCurrent();
        await chrome.tabs.setZoom(current.id, zoom);
        return chrome.tabs.getZoom(current.id);
      }, ZOOM);
      await sleep(500);
    }
    const byWidth = {};
    for (const width of WIDTHS) {
      await tab.setViewport({ width, height: 640 });
      await sleep(150);
      byWidth[width] = await measure(tab, frame);
    }
    if (SHOTSETS.includes(set)) {
      for (const width of SHOTW) {
        await tab.setViewport({ width, height: 640 });
        await sleep(200);
        await settle(tab);
        await tab.screenshot({ path: resolve(OUT, `${LABEL}-${set}-${width}.png`), clip: { x: 0, y: 0, width, height: 150 } });
      }
    }
    let sweep = null;
    if (SWEEP) {
      sweep = [];
      for (let width = 640; width >= 200; width -= 2) {
        await tab.setViewport({ width, height: 640 });
        await sleep(40);
        const m = await measure(tab, frame);
        sweep.push({ width, innerWidth: m.innerWidth, lines: m.lines, shellLines: m.shellLines, menu: m.menu, menuAtMin: m.menuAtMin,
          belowMin: m.belowMin, wrapBeforeMin: m.wrapBeforeMin, overflow: m.overflow, startOverflow: m.startOverflow,
          startSpill: m.startSpill, imgLeft: m.imgLeft, e2ePredicate: m.e2ePredicate, reachable: m.reachable,
          switchRight: m.switchRight, switchInside: m.switchInside, rows: m.rows, titleAtStart: m.titleAtStart,
          labelAtEnd: m.labelAtEnd, menuAtEnd: m.menuAtEnd, height: m.header.height, geometry: m.geometry,
          maxDelta: Math.max(...Object.values(m.aligned)) });
      }
    }
    // The first width (from wide to narrow) where the title or label wraps, the
    // first where the menu is at 6em, and the first that overflows.
    const first = predicate => sweep?.find(predicate)?.width ?? null;
    const layouts = sweep ? [...new Set(sweep.map(m => m.rows.join(" | ")))] : null;
    results.sets[set] = { names, byWidth, sweep: sweep && {
      firstMenuAtMin: first(m => m.menuAtMin === true), firstWrap: first(m => m.lines.some(n => n > 1)),
      firstTitleWrap: first(m => m.lines[0] > 1), firstLabelWrap: first(m => m.lines[1] > 1),
      firstRowBreak: first(m => m.rows.length > 1),
      firstOverflow: first(m => m.overflow), firstStartOverflow: first(m => m.startOverflow),
      firstUnreachable: first(m => !m.reachable.input || m.reachable.select === false),
      firstSwitchOutside: first(m => !m.switchInside),
      e2ePredicateFalse: sweep.filter(m => !m.e2ePredicate).map(m => m.width),
      anyWrapBeforeMin: sweep.filter(m => m.wrapBeforeMin === true).map(m => m.width),
      anyBelowMin: sweep.filter(m => m.belowMin === true).map(m => m.width),
      notTitleAtStart: sweep.filter(m => !m.titleAtStart).map(m => m.width),
      notLabelAtEnd: sweep.filter(m => !m.labelAtEnd).map(m => m.width),
      notMenuAtEnd: sweep.filter(m => m.menuAtEnd === false).map(m => m.width),
      shellLinesDiffer: sweep.filter(m => JSON.stringify(m.lines) !== JSON.stringify(m.shellLines)).map(m => m.width),
      layouts, layoutRanges: layouts.map(layout => {
        const widths = sweep.filter(m => m.rows.join(" | ") === layout).map(m => m.width);
        return { layout, from: Math.max(...widths), to: Math.min(...widths), count: widths.length,
          heights: [...new Set(sweep.filter(m => m.rows.join(" | ") === layout).map(m => Math.round(m.height)))] };
      }),
      maxDelta: Math.max(...sweep.map(m => m.maxDelta)),
      points: sweep } };
    for (const [width, m] of Object.entries(byWidth)) {
      console.log(`${set} ${width} css=${m.innerWidth} lines=${m.lines} menu=${m.menu} own=${m.own} 6em=${m.sixEm} atMin=${m.menuAtMin}`
        + ` wrapBeforeMin=${m.wrapBeforeMin} overflow=${m.overflow} startOverflow=${m.startOverflow} startSpill=${m.startSpill}`
        + ` imgLeft=${Math.round(m.imgLeft * 10) / 10} e2ePredicate=${m.e2ePredicate} switchInside=${m.switchInside} reach=${JSON.stringify(m.reachable)}`
        + ` rows=${JSON.stringify(m.rows)} h=${m.header.height} titleStart=${m.titleAtStart} labelEnd=${m.labelAtEnd} menuEnd=${m.menuAtEnd}`
        + ` maxDelta=${Math.max(...Object.values(m.aligned)).toFixed(3)} gapToLabel=${m.gapToLabel}`);
    }
    if (sweep) {
      const s = results.sets[set].sweep;
      const { points, layoutRanges, layouts: _layouts, ...summary } = s;
      console.log(`${set} sweep: ${JSON.stringify(summary)}`);
      for (const range of layoutRanges) console.log(`${set}   ${range.from}..${range.to} (${range.count}) ${range.layout} heights=${range.heights}`);
    }
    if (ZOOM !== 1) {
      await tab.evaluate(async () => {
        const current = await chrome.tabs.getCurrent();
        await chrome.tabs.setZoom(current.id, 0);
      });
    }
    await tab.close();
  }
} catch (error) {
  exitCode = 1;
  results.error = String(error?.stack ?? error);
  console.error(error);
} finally {
  writeFileSync(resolve(OUT, `${LABEL}.json`), JSON.stringify(results, null, 1));
  await browser.close().catch(() => {});
  rmSync(PROFILE, { recursive: true, force: true });
  process.exit(exitCode);
}
