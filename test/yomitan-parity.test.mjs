// SPDX-License-Identifier: GPL-3.0-or-later
// Dictionary markup against Yomitan's own renderer. Expected values are what
// yomidevs/yomitan@67db60d produces for the same input under the same jsdom;
// the generating function is named with each group, so no Yomitan checkout is
// needed at test time.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const { JSDOM } = require(require.resolve("jsdom", { paths: [process.env.HACHIDORI_JSDOM
  || resolve(process.env.XDG_CACHE_HOME || resolve(homedir(), ".cache"), "hachidori-e2e")] }));

function fixture(t) {
  const { window } = new JSDOM("<!doctype html><body></body>",
    { pretendToBeVisual: true, runScripts: "outside-only", url: "https://extension.test/" });
  for (const file of ["external-links.js", "render/glossary.js"]) {
    window.eval(readFileSync(new URL(`../extension/${file}`, import.meta.url), "utf8"));
  }
  t.after(() => window.close());
  const { document, HDGlossary } = window;
  return (content) => {
    const parent = document.createElement("div");
    HDGlossary.appendStructuredValue(document, parent, content,
      { nodes: 0, resolveMedia: () => new Promise(() => {}) }, 0);
    return parent.firstElementChild;
  };
}

// StructuredContentGenerator._setStructuredContentElementStyle on
// {tag: "span", style, content: "x"}: the resulting style attribute.
const YOMITAN_STYLES = [
  // JMdict [2026-09-18] draws every ⟶ cross-reference 30 % larger.
  [{ fontSize: "130%" }, "font-size: 130%;"],
  [{ fontSize: "small" }, "font-size: small;"],
  [{ fontSize: "calc(1em - 2px)" }, "font-size: calc(1em - 2px);"],
  [{ fontSize: ".5em" }, "font-size: 0.5em;"],
  [{ fontSize: "12pt" }, "font-size: 12pt;"],
  [{ marginLeft: "20em", paddingLeft: "300px" }, "margin-left: 20em; padding-left: 300px;"],
  [{ background: "linear-gradient(red, blue)" }, "background: linear-gradient(red, blue);"],
  [{ borderStyle: "solid", borderWidth: "thin" }, "border-style: solid; border-width: thin;"],
  // Numeric margin longhands are em, and the shorthand goes first whatever
  // the dictionary's key order.
  [{ marginTop: 0.5, marginBottom: -1, margin: "0 auto" }, "margin: 0.5em auto -1em;"],
  [{ padding: "1em 2em", paddingTop: "0" }, "padding: 0px 2em 1em;"],
  [{ textDecorationLine: ["underline", "overline"], textDecorationStyle: "wavy", textDecorationColor: "red" },
    "text-decoration: underline overline; text-decoration-style: wavy; text-decoration-color: red;"],
  [{ fontWeight: "bold", fontStyle: "italic", color: "color-mix(in srgb, red 50%, blue)" },
    "font-style: italic; font-weight: bold; color: color-mix(in srgb, red, blue);"],
  [{ verticalAlign: "super", textAlign: "center", whiteSpace: "pre-line", wordBreak: "keep-all", cursor: "help",
    listStyleType: "\"※ \"" },
  "vertical-align: super; text-align: center; word-break: keep-all; white-space: pre-line; cursor: help; list-style-type: \"※ \";"],
  [{ borderColor: "currentColor", borderRadius: "0.25em", clipPath: "inset(0 0 0 0)", textEmphasis: "filled red",
    textShadow: "1px 1px 2px red" },
  "text-emphasis: filled red; text-shadow: 1px 1px 2px red; border-color: currentcolor; border-radius: 0.25em; clip-path: inset(0 0 0 0);"],
  // Only strings are styles, apart from the numeric margin longhands above.
  [{ fontWeight: 700, fontSize: 14, margin: 1, padding: 2 }, null],
];

test("structured-content inline styles are applied as Yomitan applies them", t => {
  const render = fixture(t);
  for (const [style, expected] of YOMITAN_STYLES) {
    const span = render({ tag: "span", style, content: "x" });
    assert.equal(span.getAttribute("style"), expected, JSON.stringify(style));
  }
});

test("inline styles still refuse values that could fetch or read page state", t => {
  const render = fixture(t);
  for (const value of ["url(x)", "URL (x)", "no-repeat url(x)", "image-set(\"x.png\" 1x)",
    "-webkit-image-set(\"x.png\" 1x)", "cross-fade(url(x), red)", "paint(page-worklet)", "src(\"x\")",
    "attr(data-sc-x)", "var(--page-color)", "VAR (--page-color)", "--page-function(red)", "\\75 rl(x)",
    "linear-gradient(red, \\62 lue)"]) {
    const span = render({ tag: "span", style: { background: value, cursor: value, fontSize: "130%" }, content: "x" });
    assert.equal(span.getAttribute("style"), "font-size: 130%;", value);
  }
});

test("an image's border and border radius follow the same rule", t => {
  const render = fixture(t);
  const container = (image) => render({ tag: "img", path: "img/a.png", ...image })
    .querySelector(".gloss-image-container");
  const styled = container({ border: "thin dotted red", borderRadius: "50% / 10%" });
  assert.equal(styled.style.getPropertyValue("border"), "thin dotted red");
  assert.equal(styled.style.getPropertyValue("border-radius"), "50% / 10%");
  const refused = container({ border: "var(--page-border)", borderRadius: "attr(data-sc-r)" });
  assert.equal(refused.style.getPropertyValue("border"), "");
  assert.equal(refused.style.getPropertyValue("border-radius"), "");
});
