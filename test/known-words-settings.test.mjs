// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { openSettings, settle } from "./language-settings-harness.mjs";

test("known words sends one batch, reports additions and keeps failed text for retry", async t => {
  let finish;
  const settings = openSettings(t, { hash: "#word-highlighting", onMessage: message => {
    if (message.type === "hd_known_words_add") return new Promise(resolve => { finish = resolve; });
  } });
  await settings.page.start();
  const { el, window, messages } = settings;
  const input = el("known-words-input");
  const button = el("known-words-add");
  const status = el("known-words-status");
  const paste = text => { input.value = text; input.dispatchEvent(new window.Event("input", { bubbles: true })); };
  const requests = () => messages.filter(message => message.type === "hd_known_words_add");
  assert.equal(button.disabled, true);
  paste(" \n ");
  assert.equal(button.disabled, true);
  paste(" 猫 \n犬\n犬\n");
  button.click();
  button.click();
  assert.equal(input.disabled, true);
  assert.equal(requests().length, 1);
  assert.equal(requests()[0].text, " 猫 \n犬\n犬\n");
  finish({ ok: true, added: 2 });
  await settle();
  assert.equal(input.value, "");
  assert.equal(status.textContent, "2 words marked as known.");
  assert.equal(button.disabled, true);
  paste("学校");
  button.click();
  finish({ ok: false, error: "Storage is full" });
  await settle();
  assert.equal(input.value, "学校");
  assert.equal(button.disabled, false);
  assert.match(status.textContent, /Storage is full/u);
  button.click();
  finish({ ok: true, added: 0 });
  await settle();
  assert.equal(input.value, "");
  assert.equal(status.textContent, "All pasted words are already known.");
  assert.equal(messages.filter(message => message.type === "hd_options_write").length, 0,
    "the textbox never writes reader options");
});
