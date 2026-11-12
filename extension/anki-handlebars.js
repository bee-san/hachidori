// SPDX-License-Identifier: GPL-3.0-or-later
import { parse } from "./vendor/handlebars/parser.js";

// Only a literal marker name can plan resources before rendering. Walking the
// official AST includes both sides of conditionals, subexpressions and blocks.
export function inspectHandlebars(value) {
  const markers = [], errors = [];
  let ast;
  try { ast = parse(value); } catch (error) { return { markers, errors: [error.message] }; }
  const visit = node => {
    if (!node || typeof node !== "object") return;
    if (["MustacheStatement", "SubExpression", "BlockStatement"].includes(node.type)
        && node.path?.original === "marker") {
      if (node.params.length !== 1 || node.params[0].type !== "StringLiteral" || node.hash?.pairs.length) {
        errors.push("The marker helper needs one literal marker name, for example {{marker \"glossary\"}}.");
      } else markers.push(node.params[0].value.toLowerCase());
    }
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) child.forEach(visit);
      else if (child && typeof child === "object") visit(child);
    }
  };
  visit(ast);
  return { markers: [...new Set(markers)], errors };
}
