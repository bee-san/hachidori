// SPDX-License-Identifier: GPL-3.0-or-later

// Settings → Advanced → Experimental features → Smaller Anki cards. Rewrites
// each dictionary body of an exported glossary as compact HTML. The live
// document's cascade resolves the scoped dictionary CSS as the popup does, and
// only what it means for the content is written out: generated text, hidden
// content, margins as spaces and changed list markers. The output rules follow
// the Compact HTML Cleanup Anki add-on (#354); none of its code is used.

// Kept with their own tag. Any other element becomes a <div> (or stays a <p>)
// when its computed display is block-level and is unwrapped when it is inline.
const SAME = new Set(["br", "code", "li", "ol", "rt", "ruby", "sub", "sup", "table", "td", "th", "tr", "ul"]);
const UNWRAP = new Set(["tbody", "tfoot", "thead"]);
// Their children must stay list items, rows, cells or ruby text, so the
// emphasis they ask for is carried by those children instead.
const STRUCTURAL = new Set(["ol", "ruby", "table", "tbody", "tfoot", "thead", "tr", "ul"]);
// The output elements that close an open <p> when Anki parses the field.
const BLOCKS = new Set(["div", "li", "ol", "p", "table", "ul"]);
const BLOCK_SELECTOR = [...BLOCKS].join();
const CONTAINERS = new Set(["div", "li", "p", "td", "th"]);
const INLINE = /^(?:inline|ruby|contents)/u;
const isBlock = node => node.nodeType === 1 && BLOCKS.has(node.localName);

// The strings of a computed `content` value, as the browser serialises them.
function generatedText(content) {
  let text = "";
  for (const [token, string] of content.matchAll(/"((?:[^"\\]|\\.)*)"|\//gu)) {
    if (token === "/") break; // alternative text for assistive technology
    text += string.replace(/\\(?:([0-9a-f]{1,6}) ?|(.))/giu,
      (_, hex, character) => hex ? String.fromCodePoint(Number.parseInt(hex, 16)) : character);
  }
  return text;
}

// Structured content asks for bold, italics, underline and strike-through with
// styles; <strong> and <em> are its only emphasis tags.
const emphasis = (name, { fontStyle, fontWeight, textDecorationLine }) => [
  (name === "strong" || fontWeight === "bold" || fontWeight === "bolder" || Number(fontWeight) >= 600) && "b",
  (name === "em" || fontStyle === "italic") && "i",
  textDecorationLine.includes("underline") && "u",
  textDecorationLine.includes("line-through") && "s",
];

// HTML's own marker for a list that no CSS restyled, which is what Anki shows
// once the dictionary's stylesheet is gone.
function defaultMarker(list) {
  if (list.localName === "ol") return "decimal";
  let depth = 0;
  for (let parent = list.parentElement; parent && depth < 2; parent = parent.parentElement) {
    if (parent.localName === "ul" || parent.localName === "ol") depth += 1;
  }
  return ["disc", "circle", "square"][depth];
}

// Only content-bearing attributes survive. `data-sc-content` is what Lapis,
// Kiku and Senren select dictionary sections by; a language is written only
// where it changes.
function keptAttributes(node) {
  const kept = [];
  for (const name of ["rowspan", "colspan"]) if (node.hasAttribute(name)) kept.push([name, node.getAttribute(name)]);
  const lang = node.getAttribute("lang");
  if (lang !== null && lang !== node.parentElement?.closest("[lang]")?.getAttribute("lang")) kept.push(["lang", lang]);
  const content = node.getAttribute("data-sc-content");
  if (content !== null) kept.push(["data-sc-content", content]);
  return kept;
}

// `document` is the live extension document, whose cascade the popup shares;
// `root` is the exported glossary, still in its inert document.
export function compactAnkiGlossary(document, root) {
  const inert = root.ownerDocument;
  const view = document.defaultView;
  // The popup shows newlines in dictionary text through `white-space: pre-wrap`.
  const text = value => value.split("\n").flatMap((line, index) => {
    const nodes = index ? [inert.createElement("br")] : [];
    const collapsed = line.replace(/[\t\r ]+/gu, " ");
    if (collapsed) nodes.push(inert.createTextNode(collapsed));
    return nodes;
  });
  const pseudo = (node, which) => {
    const style = view.getComputedStyle(node, which);
    return style.display !== "none" && style.visibility === "visible" ? text(generatedText(style.content)) : [];
  };
  const wrap = (nodes, tags) => {
    for (const tag of nodes.length ? tags : []) {
      const element = inert.createElement(tag);
      element.append(...nodes);
      nodes = [element];
    }
    return nodes;
  };

  // Mounted only so the cascade can be read. Without `src` nothing is fetched,
  // and inside a hidden shadow tree nothing paints or styles the document.
  const styled = root.cloneNode(true);
  const sources = new Map();
  for (const image of styled.querySelectorAll("img[src]")) {
    sources.set(image, image.getAttribute("src"));
    image.removeAttribute("src");
  }
  function image(node, style) {
    const image = inert.createElement("img");
    if (sources.has(node)) image.setAttribute("src", sources.get(node));
    for (const name of ["alt", "width", "height"]) {
      if (node.hasAttribute(name)) image.setAttribute(name, node.getAttribute(name));
    }
    // The exported size, so em-sized marks keep it (#325).
    for (const property of ["width", "height", "max-width"]) {
      const value = node.style.getPropertyValue(property);
      if (value) image.style.setProperty(property, value);
    }
    // A keyword only: the computed value of a length is in the offscreen
    // document's pixels, not the card's.
    if (/^[a-z-]+$/u.test(style.verticalAlign) && style.verticalAlign !== "baseline") image.style.verticalAlign = style.verticalAlign;
    return image;
  }

  // `applied` is the emphasis the output around a node already gives; `pending`
  // is emphasis a structural parent asked for that the node has to carry.
  function compact(node, parentStyle, applied, pending) {
    if (node.nodeType === 3) return wrap(text(node.data), pending);
    const name = node.localName;
    if (node.nodeType !== 1 || name === "rp" || name === "style") return [];
    const style = view.getComputedStyle(node);
    if (style.display === "none" || style.visibility !== "visible") return [];
    if (name === "img") return [image(node, style)];
    const kept = keptAttributes(node);
    // An element that carries a kept attribute is kept, so a descendant can
    // rely on its `lang`.
    let tag = SAME.has(name) ? name : UNWRAP.has(name) ? (kept.length ? name : null)
      : INLINE.test(style.display) ? (kept.length ? "span" : null) : name === "p" ? "p" : "div";
    const wanted = [...new Set([...pending, ...emphasis(name, node.style)])]
      .filter(value => value && !applied.includes(value));
    const structural = STRUCTURAL.has(tag ?? name);
    let nodes = [...pseudo(node, "::before"),
      ...[...node.childNodes].flatMap(child => structural
        ? compact(child, style, applied, wanted) : compact(child, style, [...applied, ...wanted], [])),
      ...pseudo(node, "::after")];
    // A lone block inside another block adds nothing once CSS is gone.
    if (CONTAINERS.has(tag) && nodes.length === 1 && nodes[0].localName === "div" && !nodes[0].hasAttributes()) {
      nodes = [...nodes[0].childNodes];
    }
    if (tag === "p" && nodes.some(child => isBlock(child) || child.querySelector?.(BLOCK_SELECTOR))) tag = "div";
    // Nor does a block that only wraps other blocks.
    if ((tag === "div" || tag === "p") && kept.length === 0
      && nodes.every(child => isBlock(child) || (child.nodeType === 3 && /^ *$/u.test(child.data)))) tag = null;
    if (!structural) nodes = wrap(nodes, wanted);
    if (tag !== null) {
      const element = inert.createElement(tag);
      for (const [key, value] of kept) element.setAttribute(key, value);
      if (tag === "ul" || tag === "ol" || tag === "li") {
        // A list item inherits its marker; a list starts from HTML's default.
        const marker = style.listStyleType;
        if (marker !== (tag === "li" ? parentStyle.listStyleType : defaultMarker(node))) element.style.listStyleType = marker;
      }
      element.append(...nodes);
      nodes = [element];
    }
    if (style.display.startsWith("inline")) {
      if (Number.parseFloat(style.marginLeft) > 0) nodes.unshift(inert.createTextNode(" "));
      if (Number.parseFloat(style.marginRight) > 0) nodes.push(inert.createTextNode(" "));
    }
    return nodes;
  }

  const shell = document.createElement("div");
  shell.hidden = true;
  shell.attachShadow({ mode: "closed" }).append(styled);
  document.body.append(shell);
  const bodies = root.querySelectorAll(".gsm-hoshidicts-glossary-content");
  try {
    for (const [index, body] of styled.querySelectorAll(".gsm-hoshidicts-glossary-content").entries()) {
      const style = view.getComputedStyle(body);
      const replacement = inert.createElement("div");
      replacement.append(...[...body.childNodes].flatMap(child => compact(child, style, [], [])));
      replacement.normalize();
      // Margins and dictionary text can meet as doubled spaces.
      const walker = inert.createTreeWalker(replacement, view.NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) walker.currentNode.data = walker.currentNode.data.replace(/ {2,}/gu, " ");
      bodies[index].replaceWith(replacement);
    }
  } finally {
    shell.remove();
  }
  for (const style of root.querySelectorAll("style")) style.remove();
  root.style.cssText = "text-align: left;";
  return root.outerHTML;
}
