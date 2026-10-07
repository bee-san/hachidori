/*
 * The Settings library: navigation, themes, management, groups and kanji choices.
 *
 * Part of the real-Chrome suite (test/chrome-e2e.mjs); see test/README.md.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// The scenario's previous file: its steps run before the ones here.
import "./import.mjs";
import { describe } from "node:test";
import { dictionaryManagementScenarios } from "../chrome-dictionary-management-scenarios.mjs";
import {
  checkDictionaryRankLayout,
  DICTIONARY_RANK_CHECK,
} from "../chrome-dictionary-rank-scenarios.mjs";
import { checkLibraryNavigation } from "../chrome-library-navigation.mjs";
import { checkSettingsFirstFrameTheme } from "../chrome-settings-first-frame.mjs";
import { check, step } from "./harness.mjs";
import { fixtureId, genericPackage, opfsAfterBatch, replacedState } from "./import.mjs";
import {
  browser,
  FIXTURE_ALIAS,
  FIXTURE_ID,
  FIXTURE_KANJI_SELECTION_VALUE,
  FIXTURE_TERM_SELECTION_VALUE,
  generationExists,
  GENERIC_KANJI_ID,
  GENERIC_KANJI_SELECTION,
  GENERIC_KANJI_SELECTION_VALUE,
  launch,
  launchArgs,
  openDictionaryDetails,
  page,
  setDictionaryAliasInSettings,
  setDictionaryEnabledInSettings,
  settingsUrl,
  showSettingsSection,
} from "./session.mjs";
import { ankiSession } from "./settings.mjs";

async function replaceInputText(page, selector, value) {
  await page.$eval(selector, (input) => {
    input.focus();
    input.select();
  });
  await page.keyboard.type(value);
}

// Values that more than one step uses; the step that creates each one assigns it.
let originalSettingsTheme, setSettingsTheme, automaticSettingsThemes, narrowThemes, themeLayouts,
  orderAfterKeyboardMove, groupManagement, kanjiChooser;

describe("Settings library", () => {
  step("Settings navigation", async () => {
    await showSettingsSection(page, "dictionaries");
    await page.setViewport({ width: 1280, height: 900 });
    await checkLibraryNavigation(launch, launchArgs, page.url().split("#")[0], check);
    const libraryFirst = await page.evaluate(() => {
      window.scrollTo(0, 0);
      const row = document.querySelector("#dict-list .dict-row");
      const links = [...document.querySelectorAll(".settings-nav a")];
      const libraryLinks = [...document.querySelectorAll("#library-navigation a")];
      return document.querySelector("main > section")?.id === "dictionaries"
        && row.getBoundingClientRect().bottom < window.innerHeight
        // Word highlighting's link stays hidden until its experimental switch is on.
        && links.length === 10
        && links.filter((link) => link.checkVisibility()).length === 9
        && links.every((link) => document.getElementById(link.hash.slice(1))?.tagName === "SECTION")
        && JSON.stringify(libraryLinks.map(link => link.hash)) === JSON.stringify([
          "#dictionaries", "#add-dictionaries", "#updates", "#dictionary-groups", "#custom-dictionary",
        ])
        && libraryLinks.every((link) => document.getElementById(link.hash.slice(1))?.tagName === "SECTION");
    });
    const selectionActions = await page.evaluate(() => {
      const actions = document.getElementById("dict-bulk-actions");
      const selected = document.querySelector(".dict-selected");
      const initiallyHidden = actions.hidden;
      selected.click();
      const visibleWhenSelected = !actions.hidden;
      selected.click();
      return initiallyHidden && visibleWhenSelected && actions.hidden;
    });
    await page.setViewport({ width: 1280, height: 320 });
    await page.focus('.settings-nav a[href="#lookup"]');
    const shortWindowNavigation = await page.evaluate(() => {
      const rect = document.activeElement.getBoundingClientRect();
      return rect.top >= 0 && rect.bottom <= window.innerHeight;
    });
    await page.setViewport({ width: 320, height: 900 });
    await page.focus("#settings-section");
    // Native menu arrows are not delivered by headless macOS CDP. Type-ahead
    // exercises the select's real keyboard path without opening that OS menu.
    await page.keyboard.press("r");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => location.hash === "#lookup" && !document.getElementById("lookup").hidden
      && document.querySelector('.settings-nav [aria-current="page"]')?.hash === "#lookup");
    const pickerKeepsFocus = await page.evaluate(() => document.activeElement.id === "settings-section");
    originalSettingsTheme = await page.evaluate(async () =>
      (await chrome.storage.local.get("options")).options.popupTheme ?? "default");
    setSettingsTheme = async (theme, effectiveTheme = theme) => {
      await page.evaluate(async nextTheme => {
        const { options } = await chrome.storage.local.get("options");
        if ((options.popupTheme ?? "default") === nextTheme) return;
        const reply = await chrome.runtime.sendMessage({
          target: "hoshidicts-worker",
          type: "hd_options_write",
          requestId: "settings-theme-e2e",
          baseRevision: options.revision,
          options: { popupTheme: nextTheme },
        });
        if (!reply.ok) throw new Error(reply.error);
      }, theme);
      await page.waitForFunction(nextTheme =>
        document.documentElement.dataset.hoshidictsTheme === nextTheme,
      { polling: 50, timeout: 10_000 }, effectiveTheme);
    };
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
    await setSettingsTheme("auto", "light");
    automaticSettingsThemes = [];
    for (const scheme of ["light", "dark"]) {
      await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
      await page.waitForFunction(expected =>
        document.documentElement.dataset.hoshidictsTheme === expected, {}, scheme);
      automaticSettingsThemes.push(await page.evaluate(async () => ({
        effective: document.documentElement.dataset.hoshidictsTheme,
        stored: (await chrome.storage.local.get("options")).options.popupTheme,
      })));
    }
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
    narrowThemes = [];
    for (const theme of ["light", "default"]) {
      await setSettingsTheme(theme);
      await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme === "light" ? "dark" : "light" }]);
      narrowThemes.push(await page.evaluate(() => {
        const width = document.documentElement.clientWidth;
        const inputs = [...document.querySelectorAll("#lookup input, #lookup select")].filter(input => input.checkVisibility());
        return {
          theme: document.documentElement.dataset.hoshidictsTheme,
          noOverflow: document.documentElement.scrollWidth <= width,
          fieldsFit: inputs.every((input) => {
            const rect = input.getBoundingClientRect();
            return rect.width > 0 && rect.left >= 0 && rect.right <= width;
          }),
          statusExposed: !document.getElementById("options-status").closest("[hidden]")
            && document.getElementById("nav-status-lookup").textContent === "",
        };
      }));
    }
    await page.focus(".skip-link");
    await page.keyboard.press("Enter");
    const skipFocusedMain = await page.evaluate(() => document.activeElement.id === "settings-content"
      && !document.getElementById("lookup").hidden);
    const readingNode = await page.$("#lookup");
    await showSettingsSection(page, "updates");
    await page.goBack();
    await page.waitForFunction(() => !document.getElementById("lookup").hidden);
    const historyRetainedView = await page.evaluate((node) => node === document.getElementById("lookup"), readingNode);
    await readingNode.dispose();
    await page.goForward();
    await page.waitForFunction(() => !document.getElementById("updates").hidden);
    await page.setViewport({ width: 1280, height: 900 });
    await page.focus('#library-navigation a[href="#updates"]');
    await page.keyboard.press("Enter");
    const sameHashFocus = await page.evaluate(() => document.activeElement.id === "updates-heading");
    check(
      "Settings puts the library first and supports keyboard navigation at 320px",
      libraryFirst && selectionActions && skipFocusedMain && pickerKeepsFocus && shortWindowNavigation && historyRetainedView && sameHashFocus
        && narrowThemes.every((theme) => theme.noOverflow && theme.fieldsFit && theme.statusExposed),
      JSON.stringify({ libraryFirst, selectionActions, skipFocusedMain, pickerKeepsFocus, shortWindowNavigation, historyRetainedView, sameHashFocus, narrowThemes }),
    );
  });

  step("the Google Docs flag", async () => {
    themeLayouts = [];
    await showSettingsSection(page, "advanced");
    // The Google Docs switch registers a MAIN-world script for docs.google.com
    // from the service worker; the extension page can read the registry itself.
    const docsScripts = () => page.evaluate(() =>
      chrome.scripting.getRegisteredContentScripts({ ids: ["hachidori-google-docs"] }));
    const docsRegistered = async (expected) => {
      const deadline = Date.now() + 10_000;
      let scripts = await docsScripts();
      while ((scripts.length > 0) !== expected && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 100));
        scripts = await docsScripts();
      }
      return scripts;
    };
    const docsBefore = await docsScripts();
    await page.click("#opt-experimental-googleDocs");
    const docsOn = await docsRegistered(true);
    await page.click("#opt-experimental-googleDocs");
    const docsOff = await docsRegistered(false);
    const [docsScript] = docsOn;
    check(
      "the Google Docs flag registers its document_start MAIN-world script only while on",
      docsBefore.length === 0 && docsOn.length === 1 && docsOff.length === 0
        && docsScript.matches.join() === "*://docs.google.com/*" && docsScript.runAt === "document_start"
        && docsScript.world === "MAIN" && docsScript.allFrames === true
        && docsScript.js.length === 1 && docsScript.js[0].endsWith("google-docs-flag.js"),
      JSON.stringify({ docsBefore, docsOn, docsOff }),
    );
  });

  step("Settings follows every popup theme", async () => {
    for (const width of [320, 1280]) {
      await page.setViewport({ width, height: 900 });
      for (const theme of ["light", "default"]) {
        await setSettingsTheme(theme);
        for (const section of ["dictionaries", "lookup", "design", "audio", "anki", "keybinds", "custom-dictionary",
          "add-dictionaries", "updates", "dictionary-groups", "backup", "advanced"]) {
          await showSettingsSection(page, section);
          themeLayouts.push(await page.evaluate(({ theme, section }) => {
            const panel = document.getElementById(section);
            const primary = {
              dictionaries: "dict-search", lookup: "opt-hover-enabled", design: "opt-popup-columns",
              audio: "audio-source-add", anki: "anki-refresh", keybinds: "keybind-add",
              "custom-dictionary": "custom-dictionary-source",
              "add-dictionaries": "import-file", updates: "update-schedule", "dictionary-groups": "dict-group-name-new", backup: "backup-export",
              advanced: "opt-experimental-googleDocs",
            };
            const controls = [...panel.querySelectorAll("input, select, button, textarea, summary")]
              .filter((control) => control.checkVisibility());
            const statusId = { anki: "anki-status" }[section];
            const status = statusId ? document.getElementById(statusId) : null;
            const statusRect = status?.getBoundingClientRect();
            const statusStyle = status ? getComputedStyle(status) : null;
            return { theme, section, width: innerWidth,
              selectedTheme: document.documentElement.dataset.hoshidictsTheme,
              taskVisible: panel.querySelector("h1").checkVisibility() && document.getElementById(primary[section]).checkVisibility(),
              noOverflow: document.documentElement.scrollWidth <= innerWidth,
              controlsFit: controls.every((control) => {
                const rect = control.getBoundingClientRect();
                return rect.width > 0 && rect.left >= 0 && rect.right <= innerWidth + 1;
              }),
              statusFits: status === null || (status.checkVisibility()
                && (section === "anki"
                  ? statusStyle.display === "flex" && Number.parseFloat(statusStyle.fontSize) >= 12
                    && ["connected", "checking", "offline"].includes(status.dataset.state)
                  : statusStyle.display === "grid" && Number.parseFloat(statusStyle.fontSize) >= 16)
                && statusRect.left >= 0 && statusRect.right <= innerWidth + 1
                && getComputedStyle(status, "::before").content !== "none"),
            };
          }, { theme, section }));
        }
      }
    }
    const themes = await page.evaluate(() => HDReaderOptions.POPUP_THEME_GROUPS.flatMap(group =>
      group.themes.map(theme => theme.id)));
    const themePalettes = [];
    await page.setViewport({ width: 1280, height: 900 });
    await showSettingsSection(page, "design");
    // The Design preview is the production popup, themed in the same render as
    // Settings. Its pitch dictionary name is measured once reader.css applies;
    // a missing name fails that check below instead of ending the run here.
    await page.waitForFunction(() => {
      const source = document.getElementById("design-preview")?.contentDocument?.getElementById("preview-host")
        ?.shadowRoot?.querySelector(".gsm-hoshidicts-pitch-source");
      return source && getComputedStyle(source).fontWeight === "700";
    }, { timeout: 10_000 }).catch(() => {});
    for (const theme of themes.filter(theme => theme !== "auto")) {
      await setSettingsTheme(theme);
      themePalettes.push(await page.evaluate(expectedTheme => {
        const probe = document.createElement("span");
        probe.style.cssText = "position:fixed;visibility:hidden";
        document.body.append(probe);
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        const color = name => {
          probe.style.color = name.startsWith("--") ? `var(${name})` : name;
          const value = getComputedStyle(probe).color;
          context.clearRect(0, 0, 1, 1);
          context.fillStyle = value;
          context.fillRect(0, 0, 1, 1);
          return [...context.getImageData(0, 0, 1, 1).data.slice(0, 3)];
        };
        const luminance = name => color(name).map(part => part / 255)
          .map(part => part <= 0.04045 ? part / 12.92 : ((part + 0.055) / 1.055) ** 2.4)
          .reduce((sum, part, index) => sum + part * [0.2126, 0.7152, 0.0722][index], 0);
        const contrast = (first, second) => {
          const a = luminance(first);
          const b = luminance(second);
          return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        };
        const textPairs = [
          ["--text", "--surface"], ["--text-dim", "--surface"], ["--text-dim", "--bg"],
          ["--text-dim", "--surface-sunken"], ["--accent", "--accent-soft"],
          ["--accent", "--surface"], ["--accent-contrast", "--accent-fill"],
          ["--error", "--surface"], ["--ok", "--bg"],
        ];
        const textContrasts = Object.fromEntries(textPairs.map(([first, second]) =>
          [`${first}/${second}`, contrast(first, second)]));
        const root = getComputedStyle(document.documentElement);
        const previewHost = document.getElementById("design-preview")?.contentDocument?.getElementById("preview-host");
        const pitchSource = previewHost?.shadowRoot?.querySelector(".gsm-hoshidicts-pitch-source");
        const pitchStyle = pitchSource && getComputedStyle(pitchSource);
        const result = {
          expectedTheme,
          selectedTheme: document.documentElement.dataset.hoshidictsTheme,
          previewTheme: previewHost?.dataset.hoshidictsTheme,
          pitchSourceContrast: pitchStyle ? contrast(pitchStyle.color, pitchStyle.backgroundColor) : 0,
          palette: root.getPropertyValue("--hoshidicts-palette-primary").trim(),
          scheme: root.colorScheme,
          paletteScheme: root.getPropertyValue("--hoshidicts-palette-color-scheme").trim(),
          stylesheet: document.querySelector('link[href="render/reader.css"]') !== null,
          textContrast: Math.min(...Object.values(textContrasts)),
          textContrasts,
          controlContrast: Math.min(contrast("--border-strong", "--surface"),
            contrast("--border-strong", "--surface-sunken")),
        };
        probe.remove();
        return result;
      }, theme));
    }
    if (process.env.HACHIDORI_SETTINGS_THEME_SCREENSHOT) {
      await setSettingsTheme("miku");
      await showSettingsSection(page, "design");
      await page.setViewport({ width: 1280, height: 1000 });
      await page.evaluate(() => document.activeElement?.blur());
      await page.mouse.move(1275, 5);
      await page.screenshot({ path: process.env.HACHIDORI_SETTINGS_THEME_SCREENSHOT, fullPage: true });
    }
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
    await setSettingsTheme(originalSettingsTheme, originalSettingsTheme === "auto" ? "light" : originalSettingsTheme);
    await page.emulateMediaFeatures([]);
    check("Settings follows every popup theme and keeps each task view readable without horizontal overflow",
      themes.length === 43 && themePalettes.length === 42
        && JSON.stringify(automaticSettingsThemes) === JSON.stringify([
          { effective: "light", stored: "auto" }, { effective: "dark", stored: "auto" },
        ])
        && narrowThemes.every(({ theme, noOverflow, fieldsFit, statusExposed }) =>
          ["light", "default"].includes(theme) && noOverflow && fieldsFit && statusExposed)
        && themeLayouts.every((layout) => layout.selectedTheme === layout.theme
          && layout.taskVisible && layout.noOverflow && layout.controlsFit && layout.statusFits)
        && themePalettes.every((theme) => theme.selectedTheme === theme.expectedTheme && theme.palette
          && theme.scheme === theme.paletteScheme && theme.stylesheet
          && theme.textContrast >= 4.5 && theme.controlContrast >= 3),
      JSON.stringify({ automaticSettingsThemes, narrowThemes, themeLayouts, themePalettes }));
    check("Design names pitch dictionaries at 4.5:1 text contrast in every popup theme",
      themePalettes.length === 42 && themePalettes.every(theme => theme.previewTheme === theme.expectedTheme
        && theme.pitchSourceContrast >= 4.5),
      JSON.stringify(themePalettes.map(({ expectedTheme, previewTheme, pitchSourceContrast }) =>
        ({ expectedTheme, previewTheme, pitchSourceContrast }))));
  });

  step("the first Settings frame", async () => {
    await checkSettingsFirstFrameTheme(browser, settingsUrl, check, process.env.HACHIDORI_SETTINGS_THEME_FILMSTRIP);
    await ankiSession.detach();
  });

  step("the position input on a narrow page", async () => {
    await page.emulateMediaFeatures([]);
    await page.setViewport({ width: 480, height: 900 });
    await openDictionaryDetails(page, FIXTURE_ID);
    const narrowPosition = await page.evaluate(() => {
      const row = document.querySelector("#dict-list .dict-row");
      const actions = row?.querySelector(".dict-actions");
      const input = row?.querySelector(".dict-position-input");
      const inputRect = input?.getBoundingClientRect();
      const actionsRect = actions?.getBoundingClientRect();
      const rowRect = row?.getBoundingClientRect();
      const inputStyle = input ? getComputedStyle(input) : null;
      return {
        actionsRight: actionsRect?.right ?? 0,
        contentWidth: Number.parseFloat(inputStyle?.width ?? "0"),
        fontSize: Number.parseFloat(inputStyle?.fontSize ?? "0"),
        inputWidth: inputRect?.width ?? 0,
        pageWidth: document.documentElement.clientWidth,
        rowRight: rowRect?.right ?? 0,
        scrollWidth: document.documentElement.scrollWidth,
      };
    });
    check(
      "the dictionary position input stays compact on a narrow Settings page",
      narrowPosition.inputWidth > 0
        && Math.abs(narrowPosition.inputWidth - (narrowPosition.fontSize * 4.5)) <= 1
        && narrowPosition.actionsRight <= narrowPosition.rowRight + 1
        && narrowPosition.scrollWidth <= narrowPosition.pageWidth,
      JSON.stringify(narrowPosition),
    );
    await page.setViewport({ width: 800, height: 600 });
  });

  step("the enabled control and a term-only kanji import", async () => {
    const fixtureEnabled = await setDictionaryEnabledInSettings(page, "hachidori-fixture", true);
    check(
      "the Settings enabled control re-enables the preserved package",
      fixtureEnabled?.settled?.id === FIXTURE_ID,
      JSON.stringify(fixtureEnabled),
    );

    check(
      "importing a term-only single-kanji dictionary succeeds",
      genericPackage?.id === GENERIC_KANJI_ID
        && genericPackage.id !== fixtureId
        && generationExists(opfsAfterBatch, genericPackage.path),
      `dictionaryState: ${JSON.stringify(replacedState?.dictionaryState)}; OPFS paths: ${JSON.stringify(opfsAfterBatch)}`,
    );
  });

  step("filters and bulk updates", async () => {
    await page.waitForFunction(() => document.querySelectorAll("#dict-list .dict-row").length === 2, {
      timeout: 10_000,
      polling: 100,
    });
    const managementStarted = await page.evaluate(async (fixtureId) => {
      const { dictionaryState: current } = await chrome.storage.local.get("dictionaryState");
      const search = document.getElementById("dict-search");
      search.value = "ＦＩＸＴＵＲＥ ＡＬＩＡＳ";
      search.dispatchEvent(new Event("input", { bubbles: true }));
      const visibleIds = [...document.querySelectorAll("#dict-list .dict-row")]
        .map((row) => row.dataset.dictionaryId);
      document.getElementById("dict-select-visible").click();
      const selectedIds = [...document.querySelectorAll("#dict-list .dict-row")]
        .filter((row) => row.querySelector(".dict-selected")?.checked)
        .map((row) => row.dataset.dictionaryId);
      document.getElementById("dict-bulk-disable").click();
      return {
        baseRevision: current.revision,
        fixtureId,
        query: search.value,
        selectedIds,
        visibleIds,
      };
    }, FIXTURE_ID);
    const managementDisabled = await page.waitForFunction(async ({ baseRevision, fixtureId }) => {
      const { dictionaryState: current } = await chrome.storage.local.get("dictionaryState");
      const fixture = current?.dictionaries?.find((dictionary) => dictionary.id === fixtureId);
      const other = current?.dictionaries?.find((dictionary) => dictionary.id !== fixtureId);
      const selected = document.querySelector("#dict-list .dict-selected")?.checked === true;
      return current?.revision > baseRevision
        && fixture?.enabled === false
        && other?.enabled === true
        && selected
        && document.getElementById("dict-search")?.value === "ＦＩＸＴＵＲＥ ＡＬＩＡＳ"
        ? { revision: current.revision }
        : false;
    }, { timeout: 10_000, polling: 100 }, managementStarted).then((handle) => handle.jsonValue());
    await page.click("#dict-bulk-enable");
    const managementEnabled = await page.waitForFunction(async ({ revision, fixtureId }) => {
      const { dictionaryState: current } = await chrome.storage.local.get("dictionaryState");
      const fixture = current?.dictionaries?.find((dictionary) => dictionary.id === fixtureId);
      return current?.revision > revision && fixture?.enabled === true
        ? { revision: current.revision }
        : false;
    }, { timeout: 10_000, polling: 100 }, {
      fixtureId: FIXTURE_ID,
      revision: managementDisabled.revision,
    }).then((handle) => handle.jsonValue());
    check(
      "dictionary management filters and bulk-updates visible stable selections",
      managementStarted.query === "ＦＩＸＴＵＲＥ ＡＬＩＡＳ"
        && JSON.stringify(managementStarted.visibleIds) === JSON.stringify([FIXTURE_ID])
        && JSON.stringify(managementStarted.selectedIds) === JSON.stringify([FIXTURE_ID])
        && managementDisabled.revision > managementStarted.baseRevision
        && managementEnabled.revision > managementDisabled.revision,
      JSON.stringify({ managementStarted, managementDisabled, managementEnabled }),
    );
  });

  step("drag and keyboard positions", async () => {
    await page.evaluate(() => {
      const search = document.getElementById("dict-search");
      search.value = "";
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const orderBeforeDrag = await page.evaluate(async () => {
      const { dictionaryState: current } = await chrome.storage.local.get("dictionaryState");
      return {
        order: current.dictionaries.map((dictionary) => dictionary.id),
        revision: current.revision,
      };
    });
    const dragHandle = await page.$(
      `#dict-list .dict-row[data-dictionary-id="${GENERIC_KANJI_ID}"] .dict-drag`,
    );
    const dragTarget = await page.$(
      `#dict-list .dict-row[data-dictionary-id="${FIXTURE_ID}"]`,
    );
    await page.setDragInterception(true);
    await dragHandle.dragAndDrop(dragTarget);
    await page.setDragInterception(false);
    const orderAfterDrag = await page.waitForFunction(async ({ fixtureId, genericId, revision }) => {
      const { dictionaryState: current } = await chrome.storage.local.get("dictionaryState");
      const order = current?.dictionaries?.map((dictionary) => dictionary.id);
      return current?.revision > revision && order?.[0] === genericId && order?.[1] === fixtureId
        ? { order, revision: current.revision }
        : false;
    }, { timeout: 10_000, polling: 100 }, {
      fixtureId: FIXTURE_ID,
      genericId: GENERIC_KANJI_ID,
      revision: orderBeforeDrag.revision,
    }).then((handle) => handle.jsonValue());
    await openDictionaryDetails(page, FIXTURE_ID);
    await page.evaluate((fixtureId) => {
      const row = [...document.querySelectorAll("#dict-list .dict-row")]
        .find((candidate) => candidate.dataset.dictionaryId === fixtureId);
      const position = row.querySelector(".dict-position-input");
      position.value = "1";
      position.focus();
    }, FIXTURE_ID);
    await page.keyboard.press("Enter");
    orderAfterKeyboardMove = await page.waitForFunction(async ({ fixtureId, genericId, revision }) => {
      const { dictionaryState: current } = await chrome.storage.local.get("dictionaryState");
      const order = current?.dictionaries?.map((dictionary) => dictionary.id);
      const selected = [...document.querySelectorAll("#dict-list .dict-row")]
        .find((row) => row.dataset.dictionaryId === fixtureId)
        ?.querySelector(".dict-selected")?.checked === true;
      return current?.revision > revision && order?.[0] === fixtureId && order?.[1] === genericId && selected
        ? { order, revision: current.revision, selected }
        : false;
    }, { timeout: 10_000, polling: 100 }, {
      fixtureId: FIXTURE_ID,
      genericId: GENERIC_KANJI_ID,
      revision: orderAfterDrag.revision,
    }).then((handle) => handle.jsonValue());
    check(
      "drag and keyboard position controls share the persisted lookup order",
      JSON.stringify(orderBeforeDrag.order) === JSON.stringify([FIXTURE_ID, GENERIC_KANJI_ID])
        && JSON.stringify(orderAfterDrag.order) === JSON.stringify([GENERIC_KANJI_ID, FIXTURE_ID])
        && JSON.stringify(orderAfterKeyboardMove.order) === JSON.stringify(orderBeforeDrag.order)
        && orderAfterKeyboardMove.selected === true,
      JSON.stringify({ orderBeforeDrag, orderAfterDrag, orderAfterKeyboardMove }),
    );
  });

  step("an alias edit then a click", async () => {
    const aliasRowSelector = `#dict-list .dict-row[data-dictionary-id="${FIXTURE_ID}"]`;
    const beforeAliasBlurAction = orderAfterKeyboardMove.revision;
    await replaceInputText(page, `${aliasRowSelector} .dict-display-name`, "Blurred alias");
    await page.click(`${aliasRowSelector} .dict-down`, { delay: 150 });
    const aliasBlurAction = await page.evaluate(async ({ beforeRevision, dictionaryId }) => {
      const deadline = Date.now() + 3000;
      let current;
      do {
        current = (await chrome.storage.local.get("dictionaryState")).dictionaryState;
        if (current.revision >= beforeRevision + 2) break;
        await new Promise((resolveWait) => setTimeout(resolveWait, 50));
      } while (Date.now() < deadline);
      return {
        revision: current.revision,
        alias: current.dictionaries.find((dictionary) => dictionary.id === dictionaryId)?.displayName,
        lastDictionaryId: current.dictionaries.at(-1)?.id,
        focusedDictionaryId: document.activeElement?.closest(".dict-row")?.dataset.dictionaryId,
        detailsOpen: document.querySelector(`[data-dictionary-id="${dictionaryId}"] .dict-details`)?.open,
        aliasVisible: document.querySelector(`[data-dictionary-id="${dictionaryId}"] .dict-display-name`)?.checkVisibility(),
      };
    }, { beforeRevision: beforeAliasBlurAction, dictionaryId: FIXTURE_ID });
    check(
      "a delayed alias blur-then-click queues both dictionary edits",
      aliasBlurAction.revision >= beforeAliasBlurAction + 2
        && aliasBlurAction.alias === "Blurred alias"
        && aliasBlurAction.lastDictionaryId === FIXTURE_ID
        && aliasBlurAction.focusedDictionaryId === FIXTURE_ID
        && aliasBlurAction.detailsOpen && aliasBlurAction.aliasVisible,
      JSON.stringify({ beforeAliasBlurAction, aliasBlurAction }),
    );
    await page.click(`${aliasRowSelector} .dict-up`);
    await page.waitForFunction(async ({ dictionaryId, revision }) => {
      const current = (await chrome.storage.local.get("dictionaryState")).dictionaryState;
      return current.revision > revision && current.dictionaries[0]?.id === dictionaryId;
    }, { timeout: 10_000, polling: 100 }, {
      dictionaryId: FIXTURE_ID,
      revision: aliasBlurAction.revision,
    });
  });

  step("pointer reorder and confirmed bulk removal", async () => {
    await dictionaryManagementScenarios(page, check);
    check("dictionary pointer reorder and confirmed bulk removal persist across reload", true);
  });

  step("dictionary rank layout", async () => {
    check(DICTIONARY_RANK_CHECK, true, JSON.stringify(await checkDictionaryRankLayout(page)));
  });

  step("named groups", async () => {
    await showSettingsSection(page, "dictionary-groups");
    groupManagement = await page.evaluate(async ({ fixtureId, genericId }) => {
      const nameInput = document.getElementById("dict-group-name-new");
      const createButton = document.getElementById("dict-group-create");
      const error = document.getElementById("dict-group-error");
      if (!(nameInput instanceof HTMLInputElement)
          || !(createButton instanceof HTMLButtonElement)
          || !(error instanceof HTMLElement)) {
        return { error: "dictionary group controls were missing" };
      }

      const state = async () => (await chrome.storage.local.get("dictionaryState")).dictionaryState;
      const waitFor = async (revision, matches) => {
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          const current = await state();
          if (current.revision > revision && matches(current)) return current;
          await new Promise((resolveWait) => setTimeout(resolveWait, 50));
        }
        throw new Error("dictionary group state did not settle");
      };
      const groupRow = (id) => [...document.querySelectorAll("#dict-group-list .dict-group")]
        .find((row) => row.dataset.groupId === id);
      const memberRow = (groupId, dictionaryId) => [...groupRow(groupId)
        ?.querySelectorAll(".dict-group-member") ?? []]
        .find((row) => row.dataset.dictionaryId === dictionaryId);
      const addMember = async (groupId, dictionaryId) => {
        const before = await state();
        const row = groupRow(groupId);
        const select = row.querySelector(".dict-group-add-select");
        select.value = dictionaryId;
        row.querySelector(".dict-group-add").click();
        return waitFor(before.revision, (current) => current.groups
          .find((group) => group.id === groupId)?.dictionaryIds.includes(dictionaryId));
      };

      let current = await state();
      nameInput.value = "  Ｓtudy\t  Deck ";
      createButton.click();
      current = await waitFor(current.revision, (candidate) => candidate.groups?.length === 1);
      const studyGroupId = current.groups[0].id;
      const normalisedName = current.groups[0].name;
      const createRevision = current.revision;

      nameInput.value = "study deck";
      createButton.click();
      const duplicateError = error.textContent;
      nameInput.value = " Ａｌｌ ";
      createButton.click();
      const reservedError = error.textContent;
      const invalidRevision = (await state()).revision;

      nameInput.value = "Grammar";
      createButton.click();
      current = await waitFor(current.revision, (candidate) => candidate.groups?.length === 2);
      const grammarGroupId = current.groups.find((group) => group.name === "Grammar").id;
      const grammarUp = groupRow(grammarGroupId).querySelector(".dict-group-up");
      grammarUp.focus();
      grammarUp.click();
      current = await waitFor(current.revision, (candidate) => candidate.groups?.[0]?.id === grammarGroupId);
      const groupOrderAfterMove = current.groups.map((group) => group.name);
      const groupMoveFocusRetained = document.activeElement?.classList.contains("dict-group-down") === true
        && document.activeElement.closest(".dict-group")?.dataset.groupId === grammarGroupId;

      const rename = groupRow(studyGroupId).querySelector(".dict-group-name");
      rename.value = "Reading";
      rename.dispatchEvent(new Event("change", { bubbles: true }));
      current = await waitFor(current.revision, (candidate) => candidate.groups
        .find((group) => group.id === studyGroupId)?.name === "Reading");

      const studyAdd = groupRow(studyGroupId).querySelector(".dict-group-add");
      studyAdd.focus();
      current = await addMember(studyGroupId, fixtureId);
      const groupAddFocusRetained = document.activeElement?.classList.contains("dict-group-add") === true
        && document.activeElement.closest(".dict-group")?.dataset.groupId === studyGroupId;
      current = await addMember(studyGroupId, genericId);
      const membershipBeforeMove = current.groups
        .find((group) => group.id === studyGroupId).dictionaryIds;
      const genericUp = memberRow(studyGroupId, genericId).querySelector(".dict-group-member-up");
      genericUp.focus();
      genericUp.click();
      current = await waitFor(current.revision, (candidate) => candidate.groups
        .find((group) => group.id === studyGroupId)?.dictionaryIds[0] === genericId);
      const membershipAfterMove = current.groups
        .find((group) => group.id === studyGroupId).dictionaryIds;
      const memberMoveFocusRetained = document.activeElement?.classList.contains("dict-group-member-down") === true
        && document.activeElement.closest(".dict-group-member")?.dataset.dictionaryId === genericId;

      return {
        studyGroupId,
        normalisedName,
        duplicateError,
        reservedError,
        createRevision,
        invalidRevision,
        groupOrderAfterMove,
        groupMoveFocusRetained,
        groupAddFocusRetained,
        finalGroupOrder: current.groups.map((group) => group.name),
        membershipBeforeMove,
        membershipAfterMove,
        memberMoveFocusRetained,
      };
    }, { fixtureId: FIXTURE_ID, genericId: GENERIC_KANJI_ID });
    const groupedAlias = await setDictionaryAliasInSettings(page, "hachidori-fixture", "Grouped alias");
    if (!groupedAlias.settled) throw new Error(`Group alias did not settle: ${JSON.stringify(groupedAlias)}`);
    await showSettingsSection(page, "dictionary-groups");
    Object.assign(groupManagement, await page.evaluate(async ({ groupId, fixtureId }) => ({
      membershipAfterAlias: (await chrome.storage.local.get("dictionaryState")).dictionaryState.groups
        .find((group) => group.id === groupId).dictionaryIds,
      groupedAliasLabel: document.querySelector(`[data-group-id="${groupId}"] [data-dictionary-id="${fixtureId}"] .dict-group-member-name`)?.textContent,
    }), { groupId: groupManagement.studyGroupId, fixtureId: FIXTURE_ID }));
    const restoredAlias = await setDictionaryAliasInSettings(page, "hachidori-fixture", FIXTURE_ALIAS);
    if (!restoredAlias.settled) throw new Error(`Restored alias did not settle: ${JSON.stringify(restoredAlias)}`);
    await showSettingsSection(page, "dictionary-groups");
    check(
      "named groups normalize unique names and keep stable dictionary memberships",
      groupManagement.normalisedName === "Study Deck"
        && groupManagement.duplicateError?.includes("already exists")
        && groupManagement.reservedError?.includes("reserved")
        && groupManagement.invalidRevision === groupManagement.createRevision
        && groupManagement.groupMoveFocusRetained === true
        && groupManagement.groupAddFocusRetained === true
        && groupManagement.memberMoveFocusRetained === true
        && JSON.stringify(groupManagement.membershipAfterAlias)
          === JSON.stringify(groupManagement.membershipAfterMove)
        && groupManagement.groupedAliasLabel === "Grouped alias",
      JSON.stringify(groupManagement),
    );
    check(
      "group and member order controls persist their shared state order",
      JSON.stringify(groupManagement.groupOrderAfterMove) === JSON.stringify(["Grammar", "Study Deck"])
        && JSON.stringify(groupManagement.finalGroupOrder) === JSON.stringify(["Grammar", "Reading"])
        && JSON.stringify(groupManagement.membershipBeforeMove) === JSON.stringify([FIXTURE_ID, GENERIC_KANJI_ID])
        && JSON.stringify(groupManagement.membershipAfterMove) === JSON.stringify([GENERIC_KANJI_ID, FIXTURE_ID]),
      JSON.stringify(groupManagement),
    );
  });

  step("a group edit then a click", async () => {
    const editedGroupSelector = `[data-group-id="${groupManagement.studyGroupId}"]`;
    const beforeBlurAction = await page.evaluate(async () =>
      (await chrome.storage.local.get("dictionaryState")).dictionaryState.revision);
    await replaceInputText(page, `${editedGroupSelector} .dict-group-name`, "Focused reading");
    await page.click(`${editedGroupSelector} .dict-group-up`, { delay: 150 });
    const blurAction = await page.evaluate(async ({ beforeRevision, groupId }) => {
      const deadline = Date.now() + 3000;
      let current;
      do {
        current = (await chrome.storage.local.get("dictionaryState")).dictionaryState;
        if (current.revision >= beforeRevision + 2) break;
        await new Promise((resolveWait) => setTimeout(resolveWait, 50));
      } while (Date.now() < deadline);
      return {
        revision: current.revision,
        name: current.groups.find((group) => group.id === groupId)?.name,
        firstGroupId: current.groups[0]?.id,
        focusedGroupId: document.activeElement?.closest(".dict-group")?.dataset.groupId,
      };
    }, { beforeRevision: beforeBlurAction, groupId: groupManagement.studyGroupId });
    check(
      "a real blur-then-click queues both group edits and retains focus",
      blurAction.revision >= beforeBlurAction + 2
        && blurAction.name === "Focused reading"
        && blurAction.firstGroupId === groupManagement.studyGroupId
        && blurAction.focusedGroupId === groupManagement.studyGroupId,
      JSON.stringify({ beforeBlurAction, blurAction }),
    );
  });

  step("a newer external focus survives a group rerender", async () => {
    const externalFocus = await page.evaluate(async (groupId) => {
      const before = (await chrome.storage.local.get("dictionaryState")).dictionaryState;
      const input = document.querySelector(`[data-group-id="${groupId}"] .dict-group-name`);
      const picker = document.getElementById("settings-section");
      const outsideControl = picker.checkVisibility() ? picker : document.querySelector('.settings-nav a[href="#lookup"]');
      input.focus();
      input.value = "Externally focused reading";
      input.dispatchEvent(new Event("change", { bubbles: true }));
      outsideControl.focus();

      const deadline = Date.now() + 3000;
      let current;
      do {
        current = (await chrome.storage.local.get("dictionaryState")).dictionaryState;
        if (current.revision > before.revision) break;
        await new Promise((resolveWait) => setTimeout(resolveWait, 50));
      } while (Date.now() < deadline);
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
      return {
        preserved: document.activeElement === outsideControl,
        name: current.groups.find((group) => group.id === groupId)?.name,
      };
    }, groupManagement.studyGroupId);
    check(
      "a newer external focus survives a group rerender",
      externalFocus.preserved
        && externalFocus.name === "Externally focused reading",
      JSON.stringify(externalFocus),
    );
  });

  step("the kanji dictionary chooser", async () => {
    await showSettingsSection(page, "lookup");
    kanjiChooser = await page.evaluate(() => {
      const select = document.getElementById("opt-kanji-dictionary");
      return {
        exists: select instanceof HTMLSelectElement,
        options: select
          ? Array.from(select.options, option => ({ text: option.textContent, value: option.value }))
          : [],
      };
    });
    check(
      "the kanji dictionary chooser lists imported term and kanji dictionaries",
      kanjiChooser.exists
        && kanjiChooser.options.some(({ value }) => value === FIXTURE_KANJI_SELECTION_VALUE)
        && kanjiChooser.options.some(({ value }) => value === GENERIC_KANJI_SELECTION_VALUE),
      JSON.stringify(kanjiChooser),
    );
    check(
      "a combined archive exposes separate term and native kanji choices",
      kanjiChooser.options.some(({ value }) => value === FIXTURE_KANJI_SELECTION_VALUE)
        && kanjiChooser.options.some(({ value }) => value === FIXTURE_TERM_SELECTION_VALUE),
      JSON.stringify(kanjiChooser),
    );
  });

  step("stale kanji selections are pruned", async () => {
    const staleChoiceResults = [];
    for (const staleTitle of ["legacy selection {not-json", "123"]) {
      await page.evaluate(async (title) => {
        const storedOptions = (await chrome.storage.local.get("options")).options;
        await chrome.runtime.sendMessage({
          target: "hoshidicts-worker", type: "hd_options_write",
          baseRevision: storedOptions?.revision ?? 0,
          options: { kanjiClickDictionary: title },
        });
      }, staleTitle);
      const pruned = await page.waitForFunction(async () =>
        document.getElementById("opt-kanji-dictionary")?.value === ""
          && (await chrome.storage.local.get("options")).options?.kanjiClickDictionary === "",
      { timeout: 10_000, polling: 100 }).then(() => true).catch(() => false);
      staleChoiceResults.push({ pruned, title: staleTitle });
    }
    check(
      "stale title-only kanji selections are pruned",
      staleChoiceResults.every(({ pruned }) => pruned),
      JSON.stringify(staleChoiceResults),
    );
  });

  step("a legacy kanji selection migrates", async () => {
    await page.evaluate(async () => {
      const storedOptions = (await chrome.storage.local.get("options")).options;
      await chrome.runtime.sendMessage({
        target: "hoshidicts-worker", type: "hd_options_write",
        baseRevision: storedOptions?.revision ?? 0,
        options: { kanjiClickDictionary: "hachidori-fixture" },
      });
    });
    const migratedLegacySelection = await page.waitForFunction(async (value) => {
      const selected = document.getElementById("opt-kanji-dictionary")?.value;
      const saved = (await chrome.storage.local.get("options")).options?.kanjiClickDictionary;
      return selected === value && saved?.title === "hachidori-fixture" && saved?.kind === "kanji";
    }, { timeout: 10_000, polling: 100 }, FIXTURE_KANJI_SELECTION_VALUE)
      .then(() => true)
      .catch(() => false);
    check(
      "a legacy title-only kanji selection migrates to and persists its native capability",
      migratedLegacySelection,
      `chooser and storage: ${JSON.stringify(await page.evaluate(async () => ({
        value: document.getElementById("opt-kanji-dictionary")?.value,
        saved: (await chrome.storage.local.get("options")).options?.kanjiClickDictionary,
      })))}`,
    );
  });

  step("the selected kanji dictionary is saved", async () => {
    let savedKanjiDictionary = false;
    if (kanjiChooser.exists && kanjiChooser.options.some(({ value }) => value === GENERIC_KANJI_SELECTION_VALUE)) {
      await page.select("#opt-kanji-dictionary", GENERIC_KANJI_SELECTION_VALUE);
      savedKanjiDictionary = await page.waitForFunction(async (selection) => {
        const saved = (await chrome.storage.local.get("options")).options?.kanjiClickDictionary;
        return saved?.title === selection.title && saved?.kind === selection.kind;
      }, { timeout: 10_000, polling: 100 }, GENERIC_KANJI_SELECTION)
        .then(() => true)
        .catch(() => false);
    }
    check(
      "the selected kanji dictionary is saved",
      savedKanjiDictionary,
      `chooser: ${JSON.stringify(kanjiChooser)}`,
    );
    await page.evaluate(async () => {
      const storedOptions = (await chrome.storage.local.get("options")).options;
      await chrome.runtime.sendMessage({
        target: "hoshidicts-worker", type: "hd_options_write",
        baseRevision: storedOptions?.revision ?? 0,
        options: { maxResults: 1 },
      });
    });
  });
});
