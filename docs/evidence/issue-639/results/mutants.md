# Mutations on head 0401d0f1

Each mutation applied alone to a fresh worktree of the head; the suite named must fail, and did. `chrome` is `node test/chrome-clipboard-monitor.mjs`, `firefox-e2e` is `node test/run.mjs firefox-e2e`.

| mutation | file | change | suite | how it failed |
| --- | --- | --- | --- | --- |
| no-baseline | `extension/search-clipboard.js` | `if (canChange) change(text);` → `change(text);` | chrome (exit 1) | AssertionError [ERR_ASSERTION]: text on the clipboard before the page opened is not searched |
| no-note-hold | `extension/search.js` | `if (!reader.isLookupWorthy(text) \|\| reader.holdsNote()) return;` → `if (!reader.isLookupWorthy(text)) return;` | chrome (exit 1) | AssertionError [ERR_ASSERTION]: the Note draft is kept |
| no-worthy | `extension/search.js` | `if (!reader.isLookupWorthy(text) \|\| reader.holdsNote()) return;` → `if (reader.holdsNote()) return;` | chrome (exit 1) | AssertionError [ERR_ASSERTION]: text without Japanese is not searched |
| no-own-copy | `extension/search.js` | `if (!monitor.running) return; monitor.stop();` → `return;` | chrome (exit 1) | AssertionError [ERR_ASSERTION]: text copied on the search page is not searched: {"switchOn":true,"value":"漢字","query":"漢字","focused":false} |
| offscreen-any-sender | `extension/offscreen.js` | `\|\| sender.id !== chrome.runtime.id \|\| sender.url !== expectedBackgroundUrl(chrome)) return false;` → `) return false;` | chrome (exit 1) | AssertionError [ERR_ASSERTION]: the offscreen document gave Settings no text: {"worker":{"type":"hd_clipboard_read_result","requestId":null,"ok":false,"error":" |
| no-length | `extension/search.js` | `const text = clipboardSearchText(copied);` → `const text = copied;` | chrome (exit 1) | timed out waiting for the long copy's first 1,000 characters (chrome-clipboard-monitor.mjs:234) |
| laid-out | `extension/search-clipboard.js` | `event.preventDefault();` → `(removed)` | chrome (exit 1) | timed out waiting for the long copy's first 1,000 characters (chrome-clipboard-monitor.mjs:234) |
| ff-no-remove | `extension/search.js` | `: chrome.permissions.remove(CLIPBOARD_PERMISSION);` → `: Promise.resolve(true);` | firefox-e2e (exit 1) | ✖ the search page's clipboard monitor (17423.267327ms) |
| ff-no-read | `extension/search-clipboard.js` | `if (firefox) return navigator.clipboard.readText();` → `if (firefox) return "";` | firefox-e2e (exit 1) | ✖ the search page's clipboard monitor (36962.996241ms) |

Also on this head: the worker accepting any sender (`!searchPageSender(sender)` removed in `extension/background.js`) fails chrome-clipboard-monitor.mjs: Settings got the clipboard's text.
