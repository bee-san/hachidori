// SPDX-License-Identifier: GPL-3.0-or-later
// The parts of CodeMirror that extension/code-editor.js uses. build.mjs
// bundles this file, and the pinned packages it imports, into
// extension/vendor/codemirror/codemirror.js.
export { EditorState } from "@codemirror/state";
export { EditorView, highlightSpecialChars, keymap, lineNumbers, placeholder } from "@codemirror/view";
export { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
export { search, searchKeymap } from "@codemirror/search";
export { HighlightStyle, bracketMatching, ensureSyntaxTree, indentOnInput, syntaxHighlighting } from "@codemirror/language";
export { forEachDiagnostic, lintGutter, lintKeymap, linter, setDiagnosticsEffect } from "@codemirror/lint";
export { javascriptLanguage } from "@codemirror/lang-javascript";
export { cssLanguage } from "@codemirror/lang-css";
export { tags } from "@lezer/highlight";
