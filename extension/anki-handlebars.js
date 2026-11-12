// SPDX-License-Identifier: GPL-3.0-or-later
import { parse } from "./vendor/handlebars/parser.js";
import { normaliseAnkiMarkerName } from "./anki-marker-name.js";

// Only a literal marker name can plan resources before rendering. Walking the
// official AST includes both sides of conditionals, subexpressions and blocks.
export function inspectHandlebars(value) {
  const markers = [], errors = [];
  const contexts = new Set();
  let ast;
  try { ast = parse(value); } catch (error) { return { markers, contexts: [], errors: [error.message] }; }
  const visit = node => {
    if (!node || typeof node !== "object") return;
    if (node.type === "PathExpression") {
      // A block parameter can alias the root, as in context.selection. Keep
      // dependencies conservative rather than interpreting alias scopes here.
      for (const part of node.parts) if (part === "selection" || part === "groups") contexts.add(part);
    }
    // lookup can address root contexts through block aliases too. A computed
    // property may select either context, so both must be ready before render.
    if (node.path?.original === "lookup") {
      const key = node.params[1];
      if (key?.type === "StringLiteral") {
        if (key.value === "selection" || key.value === "groups") contexts.add(key.value);
      } else if (key?.type === "PathExpression" || key?.type === "SubExpression") {
        contexts.add("selection"); contexts.add("groups");
      }
    }
    if (["MustacheStatement", "SubExpression", "BlockStatement"].includes(node.type)
        && node.path?.original === "marker") {
      if (node.params.length !== 1 || node.params[0].type !== "StringLiteral" || node.hash?.pairs.length) {
        errors.push("The marker helper needs one literal marker name, for example {{marker \"glossary\"}}.");
      } else markers.push(normaliseAnkiMarkerName(node.params[0].value));
    }
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) child.forEach(visit);
      else if (child && typeof child === "object") visit(child);
    }
  };
  visit(ast);
  return { markers: [...new Set(markers)], contexts: [...contexts], errors };
}
