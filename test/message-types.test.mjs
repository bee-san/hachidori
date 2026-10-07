// SPDX-License-Identifier: GPL-3.0-or-later
// extension/message-types.js lists every `hd_*` runtime message type. These
// checks keep it equal to the names the extension's code writes, so a misspelt
// or forgotten type fails here rather than at run time.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const EXTENSION = new URL("../extension/", import.meta.url);
const REGISTRY = "message-types.js";
const REGISTRY_SOURCE = readFileSync(new URL(REGISTRY, EXTENSION), "utf8");
// Imported from its source so it runs as an ES module, as it does when an
// extension module imports it; Node would load the file itself as CommonJS.
await import(`data:text/javascript,${encodeURIComponent(REGISTRY_SOURCE)}`);
const { MESSAGE_TYPES } = globalThis.HDMessageTypes;

// One token at `lastIndex`. Where an operand may start, a `/` opens a regular
// expression; elsewhere it divides.
function tokenPattern(operandMayStart) {
  return new RegExp([
    String.raw`(?<space>\s+)`,
    String.raw`(?<comment>\/\/.*|\/\*[\s\S]*?\*\/)`,
    String.raw`(?<string>"(?:[^"\\\n]|\\[\s\S])*"|'(?:[^'\\\n]|\\[\s\S])*')`,
    ...(operandMayStart ? [String.raw`(?<regex>\/(?:[^\\/\n[]|\\.|\[(?:[^\\\]\n]|\\.)*\])+\/\p{ID_Continue}*)`] : []),
    String.raw`(?<word>[\p{ID_Continue}$]+)`,
    String.raw`(?<punctuator>\+\+|--|[\s\S])`,
  ].join("|"), "uy");
}
const OPERAND_TOKEN = tokenPattern(true);
const OPERATOR_TOKEN = tokenPattern(false);
// A template's text up to its end or its next substitution.
const TEMPLATE_TEXT = /(?:[^`\\$]|\\[\s\S]|\$(?!\{))*(?:`|\$\{)/uy;
// Words an operand may follow.
const BEFORE_OPERAND = new Set(["await", "case", "delete", "do", "else", "in", "instanceof", "new", "of", "return",
  "throw", "typeof", "void", "yield"]);

// The source with its comments blanked out and its newlines kept. Strings,
// templates and regular expressions stay as written, so a `//` or a quote in
// one of them opens nothing.
function withoutComments(source) {
  const substitutions = []; // the braces open inside each enclosing `${`
  let kept = "";
  let at = 0;
  let operandMayStart = true;
  const templateText = () => {
    TEMPLATE_TEXT.lastIndex = at;
    const text = TEMPLATE_TEXT.exec(source)?.[0];
    if (text === undefined) throw new SyntaxError(`unterminated template literal at offset ${at}`);
    kept += text;
    at += text.length;
    operandMayStart = text.endsWith("${");
    if (operandMayStart) substitutions.push(0);
  };
  while (at < source.length) {
    const pattern = operandMayStart ? OPERAND_TOKEN : OPERATOR_TOKEN;
    pattern.lastIndex = at;
    const { 0: text, groups } = pattern.exec(source);
    at += text.length;
    if (groups.comment !== undefined) {
      kept += text.replaceAll(/[^\n]/gu, " ");
      continue;
    }
    kept += text;
    if (groups.space !== undefined) continue;
    if (text === "\"" || text === "'") throw new SyntaxError(`unterminated string at offset ${at - 1}`);
    if (text === "`") {
      templateText();
      continue;
    }
    if (substitutions.length > 0 && (text === "{" || text === "}")) {
      if (text === "}" && substitutions.at(-1) === 0) {
        substitutions.pop();
        templateText();
        continue;
      }
      substitutions[substitutions.length - 1] += text === "{" ? 1 : -1;
    }
    operandMayStart = groups.word === undefined
      ? groups.punctuator !== undefined && ![")", "]", "++", "--"].includes(text)
      : BEFORE_OPERAND.has(text);
  }
  return kept;
}

const names = source => [...withoutComments(source).matchAll(/\bhd_\w+/gu)].map(([name]) => name);

// Every `hd_*` name the extension's code writes outside comments, with the
// first file that writes it.
const used = new Map();
for (const path of readdirSync(EXTENSION, { recursive: true }).map(path => path.replaceAll("\\", "/")).sort()) {
  if (!path.endsWith(".js") || path.startsWith("vendor/") || path === REGISTRY) continue;
  for (const name of names(readFileSync(new URL(path, EXTENSION), "utf8"))) {
    if (!used.has(name)) used.set(name, path);
  }
}

test("comments are blanked, but not strings, templates or regular expressions holding // or quotes", () => {
  const source = [
    'send("hd_a"); // "hd_b"',
    String.raw`/* hd_c */ const pattern = /"|\/\/hd_d/u; // hd_e`,
    `const url = \`//\${host}/\${\`\${'hd_f'}\`}//\` + '//' + "hd_g"; // hd_h`,
    "const half = total / 2; // hd_i /",
    "const third = size(box) / 3; // hd_n /",
    "const plain = `hd_j`; /* hd_k",
    "hd_l */ handlers.hd_m(message);",
  ].join("\n");
  assert.deepEqual(names(source), ["hd_a", "hd_d", "hd_f", "hd_g", "hd_j", "hd_m"]);
});

test("message-types.js also loads as a classic script", () => {
  const script = vm.createContext({});
  vm.runInContext(REGISTRY_SOURCE, script);
  assert.deepEqual([...script.HDMessageTypes.MESSAGE_TYPES], MESSAGE_TYPES);
});

test("every hd_* name in the extension's code is a registered message type", () => {
  const registered = new Set(MESSAGE_TYPES);
  assert.deepEqual([...used].filter(([name]) => !registered.has(name)).map(([name, path]) => `${name} in ${path}`), [],
    "register these in extension/message-types.js, or correct their spelling");
});

test("every registered message type is still sent or handled", () => {
  // Any use in code counts: a send, a handler, a comparison, a routing list or
  // a reply type. A mention in a comment does not.
  assert.deepEqual(MESSAGE_TYPES.filter(name => !used.has(name)), [],
    "nothing in extension/ uses these outside comments; remove them from extension/message-types.js");
});

test("the registry lists each message type once, in order", () => {
  assert.deepEqual(MESSAGE_TYPES, [...new Set(MESSAGE_TYPES)].sort());
});
