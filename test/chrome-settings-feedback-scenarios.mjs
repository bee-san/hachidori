// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

export const SETTINGS_FEEDBACK_CHECK = "Settings size steppers keep quiet, stable feedback through autosave and expose failures";

export async function checkSettingsFeedback(browser, settingsUrl, check, screenshotDirectory) {
  const page = await browser.newPage();
  const evidence = { states: [] };
  const measure = async (name) => {
    const state = await page.evaluate(() => {
      const input = document.getElementById("opt-popup-width");
      const output = document.getElementById("options-status");
      const feedback = document.getElementById("options-feedback");
      const bounds = input.getBoundingClientRect();
      return {
        top: bounds.top, left: bounds.left, scrollY,
        height: feedback.getBoundingClientRect().height,
        color: getComputedStyle(output).color,
        background: getComputedStyle(feedback).backgroundColor,
        status: output.textContent, value: Number(input.value), focused: document.activeElement === input,
        previewWidth: document.getElementById("design-preview").style.width,
      };
    });
    evidence.states.push({ name, ...state });
    if (screenshotDirectory) {
      mkdirSync(screenshotDirectory, { recursive: true });
      await page.screenshot({ path: resolve(screenshotDirectory, `${name}.png`) });
    }
    return state;
  };
  try {
    await page.setViewport({ width: 1440, height: 1000 });
    await page.goto(`${settingsUrl}#design`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.getElementById("engine-status").textContent.startsWith("Ready")
      && document.getElementById("design-preview"), { timeout: 15_000, polling: 50 });
    await page.bringToFront();
    await page.waitForFunction(() => document.getElementById("options-status").textContent === "Saved.");
    await page.focus("#opt-popup-width");
    await page.evaluate(() => {
      const original = chrome.runtime.sendMessage.bind(chrome.runtime);
      window.__feedbackProbe = { calls: [], release: null, fail: false };
      chrome.runtime.sendMessage = async message => {
        if (message.type !== "hd_options_write") return original(message);
        const probe = window.__feedbackProbe;
        probe.calls.push(message);
        await new Promise(resolveReply => { probe.release = resolveReply; });
        probe.release = null;
        if (probe.fail) return { ok: false, error: "Feedback regression save failure" };
        return original(message);
      };
    });
    const initial = await measure("initial");
    const increment = async () => {
      const bounds = await page.$eval("#opt-popup-width", input => {
        const rect = input.getBoundingClientRect();
        return { x: rect.right - 18, y: rect.top + rect.height / 2 - 4 };
      });
      await page.mouse.click(bounds.x, bounds.y);
    };
    const pending = () => page.waitForFunction(() => typeof window.__feedbackProbe.release === "function", { polling: 50 });
    const release = () => page.evaluate(() => window.__feedbackProbe.release());
    const saved = () => page.waitForFunction(() => document.getElementById("options-status").textContent === "Saved.", { polling: 50 });
    await increment();
    await measure("dirty");
    await pending();
    await measure("saving");
    await increment();
    await measure("queued");
    await release();
    await pending();
    await release();
    await saved();
    await measure("saved");
    await increment();
    await measure("dirty-again");
    await pending();
    await release();
    await saved();
    const final = await measure("saved-again");
    evidence.persisted = await page.evaluate(async () => (await chrome.storage.local.get("options")).options.popupWidthPx);
    await page.evaluate(() => { window.__feedbackProbe.fail = true; });
    await increment();
    await pending();
    await release();
    await page.waitForFunction(() => !document.getElementById("options-conflict-actions").hidden);
    await measure("error");
    evidence.failure = await page.$eval("#options-status", output => ({
      text: output.textContent, error: output.classList.contains("is-error"),
      visible: output.checkVisibility() && output.getBoundingClientRect().height > 1,
    }));
    await page.evaluate(() => { window.__feedbackProbe.fail = false; });
    await page.click("#options-retry");
    await pending();
    await release();
    await saved();
    evidence.retried = await page.evaluate(async () => (await chrome.storage.local.get("options")).options.popupWidthPx);
    const normal = evidence.states.filter(state => state.name !== "error");
    check(SETTINGS_FEEDBACK_CHECK,
      normal.every(state => state.top === initial.top && state.left === initial.left
        && state.scrollY === initial.scrollY && state.height === initial.height
        && state.color === initial.color && state.background === initial.background && state.focused)
      && final.value === initial.value + 3 && evidence.persisted === final.value
      && normal.slice(1).every(state => state.previewWidth === `${state.value + 96}px`)
      && evidence.failure.visible && evidence.failure.error && evidence.failure.text.includes("Feedback regression save failure")
      && evidence.retried === final.value + 1,
      JSON.stringify(evidence));
    await page.$eval("#opt-popup-width", (input, value) => {
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, initial.value);
    await pending();
    await release();
    await saved();
    await page.$eval("#opt-media-texthooker-url", input => {
      input.value = "https://example.com";
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const validation = await measure("validation");
    if (!validation.status.includes("Texthooker must use") || validation.height <= initial.height) {
      throw new Error(`Rejected edits must retain prominent feedback: ${JSON.stringify(validation)}`);
    }
  } finally {
    await page.evaluate(() => window.__feedbackProbe?.release?.()).catch(() => {});
    await page.close();
  }
}
