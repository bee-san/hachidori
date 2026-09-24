// hachidori-themes/scripts/theme-js.eslint.config.mjs — the lint gate for themes/*/theme.js (issue #334).
// A theme module may only touch what the reader hands it (`view`, `api`). Everything
// below is a hard error in CI; the same rules are what a reviewer checks by eye.
const FORBIDDEN_GLOBALS = [
  "window", "document", "globalThis", "self", "top", "parent", "frames",
  "chrome", "browser", "navigator", "location", "history",
  "fetch", "XMLHttpRequest", "WebSocket", "EventSource", "sendBeacon", "importScripts",
  "localStorage", "sessionStorage", "indexedDB", "caches", "cookieStore",
  "setTimeout", "setInterval", "requestAnimationFrame", "requestIdleCallback", "queueMicrotask",
  "eval", "Function", "Worker", "SharedWorker", "postMessage", "open", "alert", "confirm", "prompt",
  "MutationObserver", "IntersectionObserver", "ResizeObserver", "PerformanceObserver",
];

export default [
  {
    files: ["themes/*/theme.js"],
    languageOptions: { ecmaVersion: 2024, sourceType: "module", globals: {} },
    rules: {
      "no-undef": "error",                       // with an empty globals map every free identifier is an error
      "no-restricted-globals": ["error", ...FORBIDDEN_GLOBALS],
      "no-restricted-syntax": ["error",
        { selector: "ImportDeclaration", message: "theme.js must not import." },
        { selector: "ImportExpression", message: "theme.js must not import()." },
        { selector: "ExportNamedDeclaration", message: "theme.js has exactly one default export." },
        { selector: "ExportAllDeclaration", message: "theme.js has exactly one default export." },
        { selector: "AwaitExpression", message: "hooks are synchronous." },
        { selector: "FunctionDeclaration[async=true], FunctionExpression[async=true], ArrowFunctionExpression[async=true]", message: "hooks are synchronous." },
        { selector: "NewExpression[callee.name=/^(Function|Worker|SharedWorker|WebSocket|XMLHttpRequest|EventSource)$/]", message: "not available to themes." },
        { selector: "MemberExpression[property.name=/^(innerHTML|outerHTML|insertAdjacentHTML|srcdoc)$/]", message: "build DOM with api.el(); no HTML strings." },
        { selector: "CallExpression[callee.property.name=/^(setAttribute|setAttributeNS)$/][arguments.0.value=/^on/i]", message: "no inline event handler attributes." },
        { selector: "TaggedTemplateExpression", message: "no tagged templates." },
        { selector: "WithStatement", message: "no with." },
      ],
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
      "no-script-url": "error",
    },
  },
];
