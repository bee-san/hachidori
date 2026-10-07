/*
 * Reading the popup from Node: the shadow DOM driver and hover helpers.
 *
 * Part of the real-Chrome suite (test/chrome-e2e.mjs); see test/README.md.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// puppeteer's `pierce/` selectors cannot reach the popup: they walk
// element.shadowRoot from an injected script, and that property is null for a
// root attached with mode "closed". CDP's DOM domain can -- DOM.getDocument with
// pierce:true reports the closed root and its subtree -- so every read of the
// popup goes through a session instead of a selector.
async function popupReader(page, depth = 0) {
  const cdp = await page.createCDPSession();
  await cdp.send("DOM.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Accessibility.enable");

  async function resolvePopupObject() {
    // nodeIds live only until the next getDocument, so each operation re-walks.
    const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
    let nodeId = null;
    const walk = node => {
      const attributes = node.attributes || [];
      for (let i = 0; i < attributes.length; i += 2) {
        if (attributes[i] === "class" && String(attributes[i + 1]).includes("gsm-hoshidicts-popup")
            && attributes[attributes.indexOf("data-hoshidicts-depth") + 1] === String(depth)) {
          nodeId = node.nodeId;
        }
      }
      for (const shadow of node.shadowRoots || []) walk(shadow);
      for (const child of node.children || []) walk(child);
    };
    walk(root);
    if (nodeId === null) return null;
    const { object } = await cdp.send("DOM.resolveNode", { nodeId });
    return object;
  }

  async function state() {
    const object = await resolvePopupObject();
    if (object === null) return null;
    const { result } = await cdp.send("Runtime.callFunctionOn", {
      objectId: object.objectId,
      returnByValue: true,
      // The headword is furigana ruby, so its textContent interleaves the reading
      // into the expression -- 食べる with a た over 食 reads "食たべる". `text`
      // keeps that (it is what a reader sees); `plain` drops the <rt> so an
      // assertion can name the expression itself.
      // `tags`, `lists`, `tables` and `bold` report elements rather than text:
      // a renderer that flattened the structured content to a single text node
      // reads identically in `text`, so nothing text-based can tell a <ul> from
      // two lines of prose. `bold` carries the computed weight because the
      // fixture's span is bold through a style object, not through <b>.
      functionDeclaration: `function () {
        const stripped = this.cloneNode(true);
        for (const rt of stripped.querySelectorAll("rt, rp")) rt.remove();
        const flat = node => (node.textContent || "").replace(/\\s+/g, " ").trim();
        const view = this.ownerDocument.defaultView;
        const noteForm = this.querySelector(".gsm-hoshidicts-note-form");
        const noteActions = noteForm?.querySelector(".gsm-hoshidicts-note-actions");
        const noteFormRect = noteForm?.getBoundingClientRect();
        const noteActionsRect = noteActions?.getBoundingClientRect();
        // Each headword reading must be centred over the text it reads (た over
        // 食, not over 食べ), and pitch contours must join into one line. Chrome
        // reports a native <rt>'s whole column for its text, wherever ruby-align
        // draws the glyphs, so plain ruby can only be checked through its style.
        // Pitch ruby is laid out as flex boxes, whose text geometry is real.
        const expression = this.querySelector(".gsm-hoshidicts-expression");
        const pitchRubies = [...(expression?.querySelectorAll(".gsm-hoshidicts-pitch-ruby") ?? [])];
        const textRects = node => {
          const range = this.ownerDocument.createRange();
          const walker = this.ownerDocument.createTreeWalker(node, NodeFilter.SHOW_TEXT);
          const rects = [];
          while (walker.nextNode()) {
            range.selectNodeContents(walker.currentNode);
            rects.push(range.getBoundingClientRect());
          }
          return rects;
        };
        const textCentre = node => {
          const rects = textRects(node);
          return (Math.min(...rects.map(rect => rect.left)) + Math.max(...rects.map(rect => rect.right))) / 2;
        };
        const spread = values => values.length ? Math.max(...values) - Math.min(...values) : 0;
        const pitchCentring = pitchRubies.map(ruby => Math.abs(
          textCentre(ruby.querySelector("rt")) - textCentre(ruby.querySelector(".gsm-hoshidicts-pitch-base"))));
        const contourRects = pitchRubies
          .map(ruby => ruby.querySelector(".gsm-hoshidicts-pitch-contour").getBoundingClientRect());
        const contourGaps = contourRects.slice(1)
          .map((rect, index) => Math.abs(rect.left - contourRects[index].right));
        // A kanji segment's base is taller than a kana one (its link has a
        // dotted underline), yet every segment's contour and text must share
        // one row. A rise or drop must also span the 2px lines it joins, or
        // its outer corner is notched: its border image fills the mora's
        // padding box and reaches out by its own borders, the lines' width.
        const transitions = [...(expression?.querySelectorAll(".gsm-hoshidicts-pitch-mora[data-pitch-transition]") ?? [])];
        // The overline furigana style draws the pitch list's Yomitan text
        // instead: a line over each high mora and a hook where the pitch
        // drops, both in the popup's text colour.
        const overlines = [...(expression?.querySelectorAll('[data-pitch-style="overline"]'
          + ' > .pronunciation-mora[data-pitch="high"] > .pronunciation-mora-line') ?? [])]
          .map(line => view.getComputedStyle(line));
        return {
          hidden: this.hasAttribute("hidden"),
          height: this.getBoundingClientRect().height,
          text: flat(this),
          plain: flat(stripped),
          images: Array.from(this.querySelectorAll("img"), img => img.getAttribute("src") || ""),
          imageStates: Array.from(this.querySelectorAll(".gloss-image-link"), link => {
            const text = link.querySelector(".gloss-image-link-text");
            return {
              state: link.dataset.imageLoadState,
              label: link.getAttribute("aria-label"),
              width: link.querySelector("img")?.naturalWidth ?? 0,
              errorVisible: text?.textContent.includes("Image failed to load")
                && text.getBoundingClientRect().width > 16,
            };
          }),
          tags: Array.from(this.querySelectorAll("*"), el => el.tagName.toLowerCase()),
          lists: Array.from(this.querySelectorAll("ul"), ul =>
            Array.from(ul.children, li => li.tagName.toLowerCase() + ":" + flat(li))),
          tables: Array.from(this.querySelectorAll("table"), table =>
            Array.from(table.rows, row =>
              Array.from(row.cells, cell => cell.tagName.toLowerCase() + ":" + flat(cell)))),
          bold: Array.from(this.querySelectorAll("*"))
            .filter(el => Number.parseInt(view.getComputedStyle(el).fontWeight, 10) >= 600)
            .map(el => el.tagName.toLowerCase() + ":" + flat(el)),
          tabs: Array.from(this.querySelectorAll(".gsm-hoshidicts-tab"), flat),
          hasBack: this.querySelector(".gsm-hoshidicts-kanji-back") !== null,
          closeControl: (() => {
            const control = this.querySelector(".gsm-hoshidicts-popup-close");
            return control ? { label: control.getAttribute("aria-label"), text: flat(control) } : null;
          })(),
          focusedClass: this.getRootNode().activeElement?.className || "",
          focusedKanjiIndex: Array.from(this.querySelectorAll(".gsm-hoshidicts-kanji-link"))
            .indexOf(this.getRootNode().activeElement),
          noteOpen: noteForm !== null && !noteForm.hidden,
          noteButtonDisplay: (() => {
            const button = this.querySelector(".gsm-hoshidicts-note-button");
            return button ? view.getComputedStyle(button).display : null;
          })(),
          noteTerm: noteForm?.querySelector('[name="term"]')?.value ?? null,
          noteReading: noteForm?.querySelector('[name="reading"]')?.value ?? null,
          noteDefinition: noteForm?.querySelector('[name="definition"]')?.value ?? null,
          noteError: noteForm?.querySelector(".gsm-hoshidicts-note-error")?.textContent ?? "",
          failure: (() => {
            const alert = this.querySelector(".gsm-hoshidicts-lookup-failure");
            return alert ? {
              detail: alert.querySelector(".gsm-hoshidicts-lookup-failure-detail")?.textContent ?? "",
              kind: alert.dataset.kind ?? "",
              role: alert.getAttribute("role"),
              title: alert.querySelector(".gsm-hoshidicts-lookup-failure-title")?.textContent ?? "",
            } : null;
          })(),
          noteFits: noteForm === null || noteForm.hidden
            || (noteForm.scrollHeight <= noteForm.clientHeight + 1
              && noteActionsRect.top >= noteFormRect.top - 1
              && noteActionsRect.bottom <= noteFormRect.bottom + 1),
          furiganaAlignment: {
            rubyAlign: expression ? view.getComputedStyle(expression).rubyAlign : null,
            rubies: expression?.querySelectorAll("ruby").length ?? 0,
            pitchRubies: pitchRubies.length,
            pitchCentring: Math.max(0, ...pitchCentring),
            contourGap: Math.max(0, ...contourGaps),
            contourTopSpread: spread(contourRects.map(rect => rect.top)),
            baseTextSpread: spread(pitchRubies.flatMap(ruby =>
              textRects(ruby.querySelector(".gsm-hoshidicts-pitch-base")).map(rect => rect.top))),
            transitions: transitions.length,
            transitionsCoverLines: transitions.every(mora => {
              const stroke = view.getComputedStyle(mora, "::after");
              const style = view.getComputedStyle(mora);
              return stroke.top === "0px" && stroke.bottom === "0px" && stroke.borderImageOutset === "1 0"
                && stroke.borderTopWidth === style.borderTopWidth && stroke.borderBottomWidth === style.borderBottomWidth;
            }),
            overlines: overlines.length,
            hooks: overlines.filter(line => line.borderRightStyle === "solid").length,
            overlinesInTextColour: overlines.every(line => line.borderTopStyle === "solid"
              && line.borderTopColor === view.getComputedStyle(this).color),
          },
        };
      }`,
    });
    return result.value;
  }

  const visible = s => !!s && !s.hidden && s.height > 0 && s.text !== "";

  async function waitForVisible(timeoutMs = 15_000, accept = null) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const current = await state();
      if (visible(current) && (typeof accept !== "function" || accept(current))) return current;
      if (Date.now() >= deadline) return null;
      await new Promise(r => setTimeout(r, 250));
    }
  }

  // A popup that never appeared and a popup that went away are the same state
  // here on purpose: both are read only after an assertion has proved the popup
  // was showing, so neither can pass vacuously.
  async function waitForHidden(timeoutMs = 6_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        if (!visible(await state())) return true;
      } catch (error) {
        // A child can be pruned between getDocument and resolveNode. That
        // vanished snapshot is not proof of hiding: inspect again in case a
        // replacement child exists, within the same polling deadline.
        if (error.originalMessage !== "No node with given id found"
            || !error.message.includes("(DOM.resolveNode)")) throw error;
      }
      if (Date.now() >= deadline) return false;
      await new Promise(r => setTimeout(r, 150));
    }
  }

  async function click(selector) {
    const object = await resolvePopupObject();
    if (object === null) return false;
    const { result } = await cdp.send("Runtime.callFunctionOn", {
      objectId: object.objectId,
      returnByValue: true,
      arguments: [{ value: selector }],
      functionDeclaration: `function (target) {
        const element = this.querySelector(target);
        if (!element) return false;
        element.click();
        return true;
      }`,
    });
    return result.value === true;
  }

  async function externalLink() {
    const object = await resolvePopupObject();
    if (object === null) return null;
    const { result } = await cdp.send("Runtime.callFunctionOn", {
      objectId: object.objectId, returnByValue: true,
      functionDeclaration: `function () {
        const link = this.querySelector('a[data-external="true"]');
        if (!link) return null;
        link.focus();
        return { href: link.href, target: link.target, rel: link.rel,
          text: link.querySelector(".gloss-link-text").textContent,
          focused: this.getRootNode().activeElement === link,
          frames: this.querySelectorAll("iframe").length };
      }`,
    });
    return result.value;
  }

  async function selectGlossaryText() {
    const object = await resolvePopupObject();
    if (object === null) return "";
    const { result } = await cdp.send("Runtime.callFunctionOn", {
      objectId: object.objectId,
      returnByValue: true,
      functionDeclaration: `function () {
        const glossary = this.querySelector(".gloss-item");
        if (!glossary) return "";
        const selection = this.ownerDocument.defaultView.getSelection();
        selection.selectAllChildren(glossary);
        return selection.toString();
      }`,
    });
    return result.value;
  }

  async function definitionTextRect(text) {
    const object = await resolvePopupObject();
    if (object === null) return null;
    const { result } = await cdp.send("Runtime.callFunctionOn", {
      objectId: object.objectId,
      returnByValue: true,
      arguments: [{ value: text }],
      functionDeclaration: `function (text) {
        for (const glossary of this.querySelectorAll(".gsm-hoshidicts-glossary-content")) {
          const walker = this.ownerDocument.createTreeWalker(glossary, NodeFilter.SHOW_TEXT);
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            if (node.parentElement?.closest("a, button, input, select, textarea, [contenteditable]")) continue;
            const offset = (node.nodeValue || "").indexOf(text);
            if (offset < 0) continue;
            const first = String.fromCodePoint(text.codePointAt(0));
            const range = this.ownerDocument.createRange();
            range.setStart(node, offset);
            range.setEnd(node, offset + first.length);
            const rect = range.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) continue;
            return {
              glossary: glossary.textContent,
              rect: rect.toJSON(),
              text: range.toString(),
            };
          }
        }
        return null;
      }`,
    });
    return result.value ?? null;
  }

  async function compactSummaryTextRect(text) {
    const object = await resolvePopupObject();
    if (object === null) return null;
    const { result } = await cdp.send("Runtime.callFunctionOn", {
      objectId: object.objectId,
      returnByValue: true,
      arguments: [{ value: text }],
      functionDeclaration: `function (text) {
        const summary = this.querySelector(".gsm-hoshidicts-compact-definition-summary");
        if (!summary) return null;
        const walker = this.ownerDocument.createTreeWalker(summary, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const offset = (node.nodeValue || "").indexOf(text);
          if (offset < 0) continue;
          const first = String.fromCodePoint(text.codePointAt(0));
          const range = this.ownerDocument.createRange();
          range.setStart(node, offset);
          range.setEnd(node, offset + first.length);
          const rect = range.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) continue;
          return { rect: rect.toJSON(), text: range.toString() };
        }
        return null;
      }`,
    });
    return result.value ?? null;
  }

  async function writeNote(values, submit = false) {
    const object = await resolvePopupObject();
    if (object === null) return null;
    const { result } = await cdp.send("Runtime.callFunctionOn", {
      objectId: object.objectId,
      returnByValue: true,
      arguments: [{ value: values }, { value: submit }],
      functionDeclaration: `function (next, shouldSubmit) {
        const form = this.querySelector(".gsm-hoshidicts-note-form");
        if (!form || form.hidden) return null;
        for (const [name, value] of Object.entries(next)) {
          const control = form.elements.namedItem(name);
          if (!(control instanceof HTMLElement) || !("value" in control)) return null;
          control.value = String(value);
          control.dispatchEvent(new Event("input", { bubbles: true }));
        }
        if (shouldSubmit) form.requestSubmit();
        return Object.fromEntries(["term", "reading", "definition"].map(name => [
          name,
          form.elements.namedItem(name)?.value ?? null,
        ]));
      }`,
    });
    return result.value ?? null;
  }

  async function imagePreview(index = 0, action = "read") {
    const object = await resolvePopupObject();
    if (object === null) return null;
    const { result } = await cdp.send("Runtime.callFunctionOn", {
      objectId: object.objectId,
      returnByValue: true,
      arguments: [{ value: index }, { value: action }],
      functionDeclaration: `function (index, action) {
        const root = this.getRootNode();
        const scroll = this.querySelector(".gsm-hoshidicts-content-scroll");
        const links = [...this.querySelectorAll(".gloss-image-link")];
        const link = links[index];
        const image = link?.querySelector("img");
        if (action === "focus") link.focus();
        else if (action === "blur") link.blur();
        else if (action === "scroll") scroll.scrollTop += scroll.scrollTop > 0 ? -30 : 30;
        else if (action === "mouseenter" || action === "mouseleave") link.dispatchEvent(new Event(action));
        const preview = root.querySelector(".gsm-hoshidicts-image-hover-preview");
        const expanded = preview?.querySelector("img");
        const view = this.ownerDocument.defaultView;
        return {
          scrollTop: scroll.scrollTop,
          sourceRect: image?.getBoundingClientRect().toJSON(),
          focusedImage: links.indexOf(root.activeElement),
          images: links.map(link => {
            const image = link.querySelector("img");
            const container = link.querySelector(".gloss-image-container");
            const content = link.closest(".gsm-hoshidicts-glossary-content");
            const rect = container.getBoundingClientRect();
            return { source: image.src, width: image.naturalWidth, height: image.naturalHeight,
              tabStop: link.getAttribute("tabindex"), href: link.getAttribute("href"),
              linkClasses: [...link.classList], imageClasses: [...image.classList],
              structuredData: Object.fromEntries([...link.attributes]
                .filter(attribute => attribute.name.startsWith("data-sc-"))
                .map(attribute => [attribute.name, attribute.value])),
              filter: view.getComputedStyle(image).filter,
              margin: view.getComputedStyle(link).margin,
              imageRect: image.getBoundingClientRect().toJSON(),
              overflow: content ? { clientWidth: content.clientWidth, scrollWidth: content.scrollWidth } : null,
              display: { width: rect.width, height: rect.height, rect: rect.toJSON(), inlineWidth: container.style.width,
                fontSize: Number.parseFloat(view.getComputedStyle(container).fontSize) } };
          }),
          theme: root.host?.dataset.hoshidictsTheme ?? null,
          textColor: view.getComputedStyle(this).color,
          hiddenHeads: [...this.querySelectorAll("[data-sc付録] [data-sc-head]")]
            .map(node => ({ display: view.getComputedStyle(node).display, text: node.textContent })),
          preview: preview ? {
            rect: preview.getBoundingClientRect().toJSON(),
            source: expanded.src, width: expanded.naturalWidth, height: expanded.naturalHeight,
            sibling: preview.parentNode === this.parentNode,
            appearance: preview.dataset.appearance,
            hiddenFromAccessibility: preview.getAttribute("aria-hidden"),
            pointerEvents: view.getComputedStyle(preview).pointerEvents,
            animation: view.getComputedStyle(expanded).animationName,
            background: view.getComputedStyle(preview).backgroundColor,
          } : null,
        };
      }`,
    });
    return result.value ?? null;
  }

  // A dictionary card is a plain box, as in Yomitan: its title is a label, not
  // a control, and its definitions are laid out without any activation.
  async function glossaryCard() {
    const object = await resolvePopupObject();
    if (object === null) return null;
    const { result } = await cdp.send("Runtime.callFunctionOn", {
      objectId: object.objectId, returnByValue: true, awaitPromise: true,
      functionDeclaration: `async function () {
        const cards = [...this.querySelectorAll(".gsm-hoshidicts-glossary-card")];
        const card = cards[0];
        if (!card) return null;
        const title = card.querySelector(":scope > .gsm-hoshidicts-glossary-card-title");
        const view = this.ownerDocument.defaultView;
        await new Promise(resolve => view.requestAnimationFrame(() => view.requestAnimationFrame(resolve)));
        const rect = title.getBoundingClientRect();
        const body = card.querySelector(".gsm-hoshidicts-definitions");
        return {
          count: cards.length,
          tags: cards.map(other => other.tagName),
          inDisclosure: cards.some(other => other.closest("details") !== null),
          label: title.textContent,
          dictionary: title.title,
          titleTag: title.tagName,
          cursor: view.getComputedStyle(title).cursor,
          marker: view.getComputedStyle(title, "::before").content,
          cardHeight: card.getBoundingClientRect().height,
          bodyHeight: body.getBoundingClientRect().height,
          titlePoint: { x: rect.x + 6, y: rect.y + rect.height / 2 },
        };
      }`,
    });
    return result.value ?? null;
  }

  async function deinflection(action = "read") {
    const object = await resolvePopupObject();
    if (object === null) return null;
    const { result } = await cdp.send("Runtime.callFunctionOn", {
      objectId: object.objectId,
      returnByValue: true,
      awaitPromise: true,
      arguments: [{ value: action }],
      functionDeclaration: `async function (action) {
        const details = this.querySelector(".gsm-hoshidicts-deinflection");
        const toolbar = this.querySelector(".gsm-hoshidicts-result-chrome");
        const summary = details?.querySelector("summary");
        if (!summary) return null;
        const list = details.querySelector("ol");
        const lastStep = list.lastElementChild;
        const glossary = this.querySelector(".gsm-hoshidicts-glossary-content");
        if (action === "focus") summary.focus();
        else if (action === "blur") summary.blur();
        else if (action === "last-step") lastStep.scrollIntoView({ block: "end" });
        else if (action === "glossary") glossary.scrollIntoView({ block: "center" });
        const view = this.ownerDocument.defaultView;
        await new Promise(resolve => view.requestAnimationFrame(() => view.requestAnimationFrame(resolve)));
        const root = this.getRootNode();
        const note = this.querySelector(".gsm-hoshidicts-note-button");
        const noteRect = note.getBoundingClientRect();
        const termInput = this.querySelector(".gsm-hoshidicts-note-term");
        const reachable = element => {
          const rect = element.getBoundingClientRect();
          return element.contains(root.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
        };
        return {
          count: this.querySelectorAll(".gsm-hoshidicts-deinflection").length,
          language: view.navigator.language,
          open: details.open,
          focused: root.activeElement === summary,
          path: summary.textContent,
          label: summary.getAttribute("aria-label"),
          stepsLabel: list.getAttribute("aria-label"),
          steps: [...list.children].map(item => ({
            name: item.querySelector(".gsm-hoshidicts-deinflection-step-name").textContent,
            description: item.querySelector(".gsm-hoshidicts-deinflection-step-description")?.textContent ?? "",
          })),
          whitespace: view.getComputedStyle(details.querySelector(".gsm-hoshidicts-deinflection-endpoint")).whiteSpace,
          marker: view.getComputedStyle(summary).listStyleType,
          summaryDisplay: view.getComputedStyle(summary).display,
          popupRect: this.getBoundingClientRect().toJSON(),
          detailsRect: details.getBoundingClientRect().toJSON(),
          listRect: list.getBoundingClientRect().toJSON(),
          lastStepRect: lastStep.getBoundingClientRect().toJSON(),
          noteRect: noteRect.toJSON(),
          noteReachable: !note.disabled && note.contains(root.elementFromPoint(
            noteRect.x + noteRect.width / 2, noteRect.y + noteRect.height / 2)),
          toolbarScrollTop: toolbar.scrollTop,
          lastStepReachable: reachable(lastStep),
          glossaryReachable: reachable(glossary),
          noteInputFocused: root.activeElement === termInput,
          noteInputReachable: termInput !== null && reachable(termInput),
        };
      }`,
    });
    return result.value ?? null;
  }

  async function nested(action = "read") {
    const object = await resolvePopupObject();
    if (!object) return null;
    const { result } = await cdp.send("Runtime.callFunctionOn", {
      objectId: object.objectId, returnByValue: true,
      arguments: [{ value: action }],
      functionDeclaration: `function (action) {
        const root = this.getRootNode();
        const link = this.querySelector("a[data-hoshidicts-query]");
        if (action === "focus-link") link.focus();
        if (action === "remember") { root.__nestedParent = this; root.__nestedAnchor = link; }
        if (action === "blur") root.activeElement?.blur();
        const rect = this.getBoundingClientRect();
        const linkRect = link?.getBoundingClientRect();
        const linkFragment = link && [...link.getClientRects()]
          .find(fragment => fragment.width > 0 && fragment.height > 0);
        return {
          depth: Number(this.dataset.hoshidictsDepth), rect: rect.toJSON(),
          toolbar: this.dataset.toolbarPosition,
          linkRect: linkRect?.toJSON(),
          linkPoint: linkFragment && {
            x: linkFragment.x + linkFragment.width / 2,
            y: linkFragment.y + linkFragment.height / 2,
          },
          query: link?.dataset.hoshidictsQuery, reading: link?.dataset.hoshidictsReading,
          linkFocused: root.activeElement === link,
          sameParent: root.querySelector('[data-hoshidicts-depth="0"]') === root.__nestedParent,
          sameAnchor: root.__nestedAnchor?.isConnected === true,
          depths: [...root.querySelectorAll(".gsm-hoshidicts-popup")].filter(popup => !popup.hidden)
            .map(popup => Number(popup.dataset.hoshidictsDepth)),
          imagesReady: [...this.querySelectorAll("img")].every(image => image.complete && image.naturalWidth === 16),
          viewport: { width: innerWidth, height: innerHeight },
        };
      }`,
    });
    return result.value;
  }

  async function sourcePaint(action = "read", sourceSelector = null) {
    const object = await resolvePopupObject();
    if (!object) return null;
    const { result, exceptionDetails } = await cdp.send("Runtime.callFunctionOn", {
      objectId: object.objectId, returnByValue: true, arguments: [{ value: action }, { value: sourceSelector }],
      functionDeclaration: `function (action, sourceSelector) {
        const root = this.getRootNode();
        const layer = root.querySelector(".gsm-hoshidicts-source-highlight-layer");
        if (action === "remember") root.__sourcePaintOwner = layer?.firstElementChild;
        if (action === "cover-parent") {
          const rect = layer.firstElementChild.firstElementChild.getBoundingClientRect();
          this.style.left = rect.left + "px";
          this.style.top = rect.top + "px";
          root.dispatchEvent(new Event("scroll"));
        }
        const sameOwner = layer?.firstElementChild === root.__sourcePaintOwner;
        if (action === "forget") delete root.__sourcePaintOwner;
        const ownerRects = [...(layer?.children || [])].map(group => [...group.children].map(mark => ({
          ...mark.getBoundingClientRect().toJSON(), pointerEvents: getComputedStyle(mark).pointerEvents,
        })));
        let source;
        if (sourceSelector) {
          const element = document.querySelector(sourceSelector);
          const clip = element.getBoundingClientRect();
          const left = clip.left + element.clientLeft, top = clip.top + element.clientTop;
          const expected = [...element.querySelectorAll("b,i")].flatMap(part => {
            const range = document.createRange();
            range.selectNodeContents(part.firstChild);
            return [...range.getClientRects()].map(rect => ({ left: Math.max(left, rect.left), top: Math.max(top, rect.top),
              right: Math.min(left + element.clientWidth, rect.right), bottom: Math.min(top + element.clientHeight, rect.bottom) }))
              .filter(rect => rect.right > rect.left && rect.bottom > rect.top);
          });
          source = { expected, html: element.innerHTML, className: element.className, selection: getSelection().toString(),
            cover: document.querySelector("[data-e17-painted-cover]")?.getBoundingClientRect().toJSON() };
        }
        return { groups: layer?.children.length || 0, sameOwner,
          rects: ownerRects.flat(), ownerRects, source };
      }`,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.text);
    return result.value;
  }

  async function retainedControls(action = "read") {
    const object = await resolvePopupObject();
    if (!object) return null;
    const { result } = await cdp.send("Runtime.callFunctionOn", {
      objectId: object.objectId, returnByValue: true, arguments: [{ value: action }],
      functionDeclaration: `function (action) {
        const root = this.getRootNode();
        if (action === "focus-tab") this.querySelector('[role="tab"][aria-selected="true"]').focus();
        if (action === "remember") {
          root.__retainedControls?.observer.disconnect();
          const form = this.querySelector("form");
          const input = form.elements.definition;
          input.focus();
          input.setSelectionRange(2, 7);
          const saved = { form, input, detached: false, panel: this.querySelector('.gsm-hoshidicts-tab-panel') };
          const observer = new MutationObserver(records => {
            saved.detached ||= records.some(record => [...record.removedNodes].includes(form));
          });
          observer.observe(this, { childList: true });
          saved.observer = observer;
          root.__retainedControls = saved;
        }
        if (action === "remember-panel") root.__retainedControls.panel = this.querySelector('.gsm-hoshidicts-tab-panel');
        const saved = root.__retainedControls;
        const input = saved?.input;
        const rect = input?.getBoundingClientRect();
        // Reachability concerns this pane's own rows: a child pane hanging
        // from a source link may legitimately overlap them, as in Yomitan.
        const ownTopmost = (x, y) => root.elementsFromPoint(x, y).find(element => this.contains(element));
        return {
          toolbar: this.dataset.toolbarPosition,
          sameForm: this.querySelector('form') === saved?.form,
          mounted: saved?.form.isConnected && !saved.form.hidden && !saved.detached
            && !saved.observer.takeRecords().some(record => [...record.removedNodes].includes(saved.form)),
          draft: input?.value, selection: [input?.selectionStart, input?.selectionEnd],
          inputFocused: root.activeElement === input,
          inputReachable: rect && ownTopmost(rect.x + rect.width / 2, rect.y + rect.height / 2) === input,
          inputRect: rect?.toJSON(), popupRect: this.getBoundingClientRect().toJSON(),
          scrollTop: this.querySelector(".gsm-hoshidicts-content-scroll").scrollTop,
          centerOwner: rect && ownTopmost(rect.x + rect.width / 2, rect.y + rect.height / 2)?.className,
          tabFocused: root.activeElement === this.querySelector('[role="tab"][aria-selected="true"]'),
          replaced: this.querySelector('.gsm-hoshidicts-tab-panel') !== saved?.panel,
        };
      }`,
    });
    return result.value;
  }

  async function dictionaryTabs(action = "read", key = null) {
    const object = await resolvePopupObject();
    if (!object) return null;
    const reply = await cdp.send("Runtime.callFunctionOn", {
      objectId: object.objectId, returnByValue: true,
      arguments: [{ value: action }, { value: key }],
      functionDeclaration: function (action, key) {
        const root = this.getRootNode();
        const scroll = this.querySelector(".gsm-hoshidicts-content-scroll");
        // A retired child shell is reused while its next lookup is pending.
        // Polling must wait for its content, just as for an absent popup.
        if (action === "read" && scroll === null) return null;
        const tabs = [...this.querySelectorAll('[role="tab"]')];
        if (action === "scroll") scroll.scrollTop = key;
        const tabKey = button => button.dataset.dictionary ? `dictionary:${button.dataset.dictionary}`
          : button.dataset.groupId ? `group:${button.dataset.groupId}`
            : button.dataset.favourites === "true" ? "favourites" : "all";
        if (action === "select" || action === "focus") {
          const button = tabs.find(button => tabKey(button) === key);
          if (!button) throw new Error(`Missing dictionary tab: ${key}`);
          if (action === "select") button.click(); else button.focus();
        }
        if (action === "cleanup") {
          root.__retainedControls?.observer.disconnect();
          delete root.__retainedControls;
          delete root.__nestedParent;
          delete root.__nestedAnchor;
          delete this.__dictionaryTabs;
          return true;
        }
        const panel = this.querySelector(".gsm-hoshidicts-tab-panel");
        const selected = tabs.find(button => button.getAttribute("aria-selected") === "true");
        const cards = [...this.querySelectorAll(".gsm-hoshidicts-glossary-card")];
        if (action === "remember") this.__dictionaryTabs = {
          panel, selected, tabs: new Map(tabs.map(button => [tabKey(button), button])), cards,
          link: this.querySelector("a[data-hoshidicts-query]"),
          images: new Map([...this.querySelectorAll("img")].map(image => [image, image.closest(".gloss-image-link")])),
        };
        const saved = this.__dictionaryTabs;
        const metadataCapsule = this.querySelector(".gsm-hoshidicts-primary-metadata-capsule");
        const metadataStrip = this.querySelector(".gsm-hoshidicts-metadata-strip");
        const primaryEntry = this.querySelector(".gsm-hoshidicts-entry");
        const primaryHeader = this.querySelector(".gsm-hoshidicts-primary-header");
        const primaryFrequencies = this.querySelector(".gsm-hoshidicts-primary-frequencies");
        const lookupCount = this.querySelector(".gsm-hoshidicts-lookup-stats:not([hidden])");
        const lookupCountRect = lookupCount?.getBoundingClientRect();
        const capsuleRect = metadataCapsule?.getBoundingClientRect();
        const entryRect = primaryEntry?.getBoundingClientRect();
        const capsuleStyle = metadataCapsule ? getComputedStyle(metadataCapsule) : null;
        const primaryFrequencyStyle = primaryFrequencies ? getComputedStyle(primaryFrequencies) : null;
        const entries = [...this.querySelectorAll(".gsm-hoshidicts-entry")].map((entry, index) => ({
          expression: entry.dataset.expression,
          aria: (index === 0 ? this.querySelector(".gsm-hoshidicts-primary-header") : entry)
            ?.querySelector(".gsm-hoshidicts-expression")?.getAttribute("aria-label"),
          cards: [...entry.querySelectorAll(".gsm-hoshidicts-glossary-card")].map(card => ({
            dictionary: card.querySelector(".gsm-hoshidicts-glossary-card-title").title,
            label: card.querySelector(".gsm-hoshidicts-glossary-card-title").textContent,
            bodies: [...card.querySelectorAll(".gsm-hoshidicts-glossary-content")].map(body => body.innerHTML),
            // Each body's visible text: Yomitan's gloss separators are hidden.
            text: [...card.querySelectorAll(".gsm-hoshidicts-glossary-content")].map(body =>
              [...body.querySelectorAll(".gloss-content")].map(content => content.textContent).join("")),
          })),
        }));
        // Attribute insertion order is not DOM meaning. Compare the complete
        // ordered body DOM, retaining every node and attribute name/value.
        if (action === "matches") return entries.length === key.length && entries.every((entry, index) => {
          const expected = key[index];
          return entry.expression === expected.expression && entry.aria === expected.aria
            && entry.cards.length === expected.cards.length && entry.cards.every((card, cardIndex) => {
              const other = expected.cards[cardIndex];
              return card.dictionary === other.dictionary && card.bodies.length === other.bodies.length
                && card.bodies.every((html, bodyIndex) => {
                  const left = this.ownerDocument.createElement("template");
                  const right = this.ownerDocument.createElement("template");
                  left.innerHTML = html; right.innerHTML = other.bodies[bodyIndex];
                  return left.content.isEqualNode(right.content);
                });
            });
        });
        return {
          hidden: this.hidden, entries, scrollTop: scroll.scrollTop,
          customOutline: getComputedStyle(this).outlineColor,
          showMore: Boolean(this.querySelector(".gsm-hoshidicts-show-more")),
          toolbar: this.dataset.toolbarPosition,
          tabs: tabs.map(button => ({ key: tabKey(button), label: button.textContent, title: button.title,
            selected: button.getAttribute("aria-selected") === "true", focused: root.activeElement === button,
            tabIndex: button.tabIndex, controls: button.getAttribute("aria-controls"), id: button.id,
            aria: button.getAttribute("aria-label"),
            same: saved?.tabs.get(tabKey(button)) === button,
          })),
          selected: selected ? tabKey(selected) : null,
          panelId: panel?.id, labelledBy: panel?.getAttribute("aria-labelledby"),
          samePanel: panel === saved?.panel, sameSelected: selected === saved?.selected,
          sameCards: cards.length === saved?.cards.length && cards.every((card, index) => card === saved.cards[index]),
          sameAnchor: saved?.link?.isConnected === true && this.contains(saved.link),
          images: [...this.querySelectorAll("img")].map(image => ({ src: image.getAttribute("src") || "",
            same: saved?.images.has(image) && saved.images.get(image) === image.closest(".gloss-image-link"),
            path: image.closest(".gloss-image-link")?.dataset.path,
            complete: image.complete, width: image.naturalWidth, height: image.naturalHeight })),
          imageSources: [...this.querySelectorAll(".gloss-image-source")].map(label => ({
            text: label.textContent, dictionary: label.dataset.dictionary, title: label.title,
            outsideThumbnail: !label.closest(".gsm-hoshidicts-compact-definition-image"),
          })),
          metadata: {
            frequencyNames: [...this.querySelectorAll(".gsm-hoshidicts-frequency-source")].map(node => node.textContent),
            frequencies: [...this.querySelectorAll(".gsm-hoshidicts-frequency-value")].map(node => Number(node.dataset.frequency)),
            frequencyText: primaryFrequencies?.textContent ?? "",
            // The first entry's tags are the same bordered two-tone tags as a
            // later entry's metadata row: no label, no wrapping pill.
            frequencyTagsUniform: (() => {
              const primary = primaryFrequencies?.querySelector(".gsm-hoshidicts-tag-frequency");
              if (!primary || primaryFrequencies.className !== "gsm-hoshidicts-primary-frequencies") return false;
              const style = getComputedStyle(primary);
              const body = getComputedStyle(primary.querySelector(".gsm-hoshidicts-frequency-body"));
              const later = this.querySelector(".gsm-hoshidicts-frequency-metadata .gsm-hoshidicts-tag-frequency");
              const laterStyle = later ? getComputedStyle(later) : style;
              return style.borderTopStyle === "solid" && style.borderRadius === "4px"
                && primaryFrequencyStyle.borderTopStyle === "none"
                && primaryFrequencyStyle.backgroundColor === "rgba(0, 0, 0, 0)"
                && body.backgroundColor !== "rgba(0, 0, 0, 0)"
                && !primary.querySelector(".gsm-hoshidicts-primary-frequency-label")
                && laterStyle.borderTopColor === style.borderTopColor
                && laterStyle.borderRadius === style.borderRadius && laterStyle.fontSize === style.fontSize;
            })(),
            // Hidden per-dictionary tags (averages on) have no boxes to clip.
            clippedFrequencies: [...this.querySelectorAll(".gsm-hoshidicts-primary-frequencies .gsm-hoshidicts-frequency-value")]
              .filter(node => node.getClientRects().length > 0).some(node => {
                const value = node.getBoundingClientRect();
                const tag = node.closest(".gsm-hoshidicts-tag-frequency").getBoundingClientRect();
                const capsule = node.closest(".gsm-hoshidicts-primary-metadata-capsule").getBoundingClientRect();
                return value.right > Math.min(tag.right, capsule.right) + 1 || value.left < Math.max(tag.left, capsule.left) - 1;
              }),
            hiddenFrequencyDictionaries: [...this.querySelectorAll(".gsm-hoshidicts-tag-frequency[hidden]")]
              .filter(tag => tag.getClientRects().length === 0).map(tag => tag.dataset.dictionary),
            pitch: this.querySelectorAll(".gsm-hoshidicts-tag-pitch").length,
            ruby: [...this.querySelectorAll(".gsm-hoshidicts-pitch-reading")].map(node => node.dataset.pitchDictionary),
            rubyStyles: [...this.querySelectorAll(".gsm-hoshidicts-pitch-contour")]
              .map(node => node.dataset.pitchStyle ?? "contour"),
            ipa: [...this.querySelectorAll(".gsm-hoshidicts-ipa-body")].map(node => node.textContent),
            ipaFits: [...this.querySelectorAll(".gsm-hoshidicts-ipa-body")].every(node => {
              const body = node.getBoundingClientRect();
              const tag = node.parentNode.getBoundingClientRect();
              const bounds = this.getBoundingClientRect();
              return body.left >= tag.left - 1 && body.right <= tag.right + 1
                && tag.left >= bounds.left - 1 && tag.right <= bounds.right + 1;
            }),
            ipaSourceLabels: this.querySelectorAll(".gsm-hoshidicts-ipa-source").length,
            ipaTitles: [...this.querySelectorAll(".gsm-hoshidicts-tag-ipa")].map(node => node.title),
            grammar: this.querySelectorAll(".gsm-hoshidicts-primary-grammar-tag").length,
            definitionTags: this.querySelectorAll(".gsm-hoshidicts-definition-tags").length,
            capsuleAria: metadataCapsule?.getAttribute("aria-label") ?? null,
            frequencyInsideCapsule: [...this.querySelectorAll(".gsm-hoshidicts-primary-frequencies")]
              .every(node => node.parentElement === metadataCapsule),
            grammarInsideCapsule: [...this.querySelectorAll(".gsm-hoshidicts-primary-grammar")]
              .every(node => node.parentElement === metadataCapsule),
            insidePrimaryEntry: Boolean(metadataCapsule) && metadataCapsule.closest(".gsm-hoshidicts-entry") === primaryEntry,
            outsideHeader: !primaryHeader?.contains(metadataCapsule),
            insideResult: Boolean(capsuleRect && entryRect
              && capsuleRect.top >= entryRect.top - 1 && capsuleRect.bottom <= entryRect.bottom + 1),
            // Same row: baseline-aligned tags sit a little lower than the
            // lookup pill's top, so overlap is the row test, not equal tops.
            // The count arrives later, so it follows the tags (#486).
            besideLookupCount: Boolean(capsuleRect && lookupCountRect && !metadataCapsule.hidden
              && capsuleRect.top < lookupCountRect.bottom && capsuleRect.bottom > lookupCountRect.top
              && lookupCountRect.left >= capsuleRect.right),
            plain: Boolean(capsuleStyle
              && capsuleStyle.borderTopStyle === "none"
              && capsuleStyle.backgroundColor === "rgba(0, 0, 0, 0)"),
            separateFromTabStrip: !metadataStrip?.contains(metadataCapsule),
            tabStripOnly: !metadataStrip || [...metadataStrip.children]
              .every(node => node.classList.contains("gsm-hoshidicts-tab-list")),
          },
          rect: this.getBoundingClientRect().toJSON(), viewport: { width: innerWidth, height: innerHeight },
          grids: [...this.querySelectorAll(".gsm-hoshidicts-glossary-grid")].map(grid => ({
            width: grid.clientWidth, rect: grid.getBoundingClientRect().toJSON(), height: grid.style.height,
            gap: Number.parseFloat(getComputedStyle(grid).columnGap),
            masonry: grid.classList.contains("gsm-hoshidicts-glossary-grid-masonry"),
            cards: [...grid.children].map(card => ({ rect: card.getBoundingClientRect().toJSON(),
              offsetHeight: card.offsetHeight, width: card.style.width, transform: card.style.transform,
              visibility: card.style.visibility,
            })),
          })),
        };
      }.toString(),
    });
    if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description || reply.exceptionDetails.text);
    return reply.result.value;
  }

  async function compactSummaries() {
    const object = await resolvePopupObject();
    if (!object) return [];
    const reply = await cdp.send("Runtime.callFunctionOn", {
      objectId: object.objectId, returnByValue: true,
      functionDeclaration: function () {
        return [...this.querySelectorAll(".gsm-hoshidicts-compact-definition-summary")].map(summary => ({
          dictionary: summary.dataset.hoshidictsDictionary,
          items: [...summary.querySelectorAll("li")].map(item => item.textContent),
          thumbnailCount: summary.querySelectorAll(".gsm-hoshidicts-compact-definition-image").length,
          image: [...summary.querySelectorAll("img")].map(image => ({
            src: image.getAttribute("src"), complete: image.complete,
            width: image.naturalWidth, height: image.naturalHeight, hidden: image.hidden,
            rect: image.getBoundingClientRect().toJSON(),
            state: image.closest(".gloss-image-link").dataset.imageLoadState,
          })),
        }));
      }.toString(),
    });
    return reply.result.value;
  }
  async function audio(action = "read", index = 0) {
    const object = await resolvePopupObject();
    if (!object) return null;
    const reply = await cdp.send("Runtime.callFunctionOn", {
      objectId: object.objectId, returnByValue: true, arguments: [{ value: action }, { value: index }],
      functionDeclaration: function (action, index) {
        const root = this.getRootNode();
        const button = this.querySelectorAll(".gsm-hoshidicts-audio-button")[index];
        if (action === "play") button.click();
        const candidate = this.querySelectorAll(".gsm-hoshidicts-audio-choices div button")[index];
        if (action === "candidate") candidate.scrollIntoView({ block: "nearest" });
        const menu = this.querySelector(".gsm-hoshidicts-audio-choices");
        const menuRect = menu?.getBoundingClientRect();
        const popupRect = this.getBoundingClientRect();
        const candidateRect = candidate?.getBoundingClientRect();
        const buttonRect = button?.getBoundingClientRect();
        const scroller = this.querySelector(".gsm-hoshidicts-content-scroll");
        // Beside Audio: 4px below or above it, overlapping it horizontally, inside the popup.
        const gap = menuRect && buttonRect && (menuRect.top >= buttonRect.bottom
          ? menuRect.top - buttonRect.bottom : buttonRect.top - menuRect.bottom);
        return { text: this.textContent, button: button?.textContent, audioBusy: button?.getAttribute("aria-busy"),
          audioState: button?.dataset.state, audioHidden: button?.hidden,
          feedback: [...this.querySelectorAll(".gsm-hoshidicts-audio-status")].map(node => node.textContent),
          choices: [...this.querySelectorAll(".gsm-hoshidicts-audio-choices div button")].map(node => node.textContent),
          menu: Boolean(this.querySelector(".gsm-hoshidicts-audio-choices")),
          menuBeside: Boolean(menuRect && Math.abs(gap - 4) <= 1.5 && menuRect.height > 100
            && menuRect.left <= buttonRect.right && menuRect.right >= buttonRect.left
            && menuRect.left > popupRect.left && menuRect.right < popupRect.right
            && menuRect.top > popupRect.top && menuRect.bottom < popupRect.bottom),
          menuRect: menuRect?.toJSON(),
          definitions: scroller && { scrollTop: scroller.scrollTop, rect: scroller.getBoundingClientRect().toJSON() },
          candidatePoint: candidateRect && { x: candidateRect.x + candidateRect.width / 2, y: candidateRect.y + candidateRect.height / 2 },
          buttonRect: buttonRect?.toJSON(),
          focused: root.activeElement?.className, rect: this.getBoundingClientRect().toJSON() };
      }.toString(),
    });
    if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description || reply.exceptionDetails.text);
    return reply.result.value;
  }
  async function anki() {
    const object = await resolvePopupObject();
    if (!object) return null;
    const reply = await cdp.send("Runtime.callFunctionOn", {
      objectId: object.objectId, returnByValue: true,
      functionDeclaration: function () {
        const feedback = this.querySelector(".gsm-hoshidicts-mining-feedback");
        const controls = [...this.querySelectorAll(".gsm-hoshidicts-anki-control")];
        const adds = [...this.querySelectorAll(".gsm-hoshidicts-mine-button")];
        const successProbe = this.ownerDocument.createElement("span");
        successProbe.style.color = "var(--hoshidicts-success)";
        this.append(successProbe);
        const successColor = getComputedStyle(successProbe).color;
        successProbe.remove();
        const primaryActions = this.querySelector(".gsm-hoshidicts-primary-header .gsm-hoshidicts-entry-actions");
        const actionKind = node => {
          if (node.classList.contains("gsm-hoshidicts-mine-button")) return "add";
          if (node.classList.contains("gsm-hoshidicts-audio-control")) return "audio";
          if (node.classList.contains("gsm-hoshidicts-note-button")) return "note";
          if (node.classList.contains("gsm-hoshidicts-external-link-button")) return "external";
          return node.className;
        };
        return { rect: this.getBoundingClientRect().toJSON(), hidden: this.hidden,
          order: primaryActions ? [...primaryActions.children].map(actionKind) : [],
          feedback: feedback ? { hidden: feedback.hidden, text: feedback.textContent, kind: feedback.dataset.kind ?? null } : null,
          controls: adds.map((add, index) => {
            const control = controls[index];
            const icon = add.querySelector(".gsm-hoshidicts-mine-icon");
            const style = getComputedStyle(add);
            return { hidden: add.hidden, text: add.textContent,
              title: add.title, icon: icon?.dataset.icon ?? icon?.textContent ?? "",
              state: add.dataset.state, disabled: add.disabled,
              ariaBusy: add.getAttribute("aria-busy"),
              ariaLabel: add.getAttribute("aria-label"),
              focused: add.getRootNode().activeElement === add,
              color: style.color, borderColor: style.borderColor,
              successColored: style.color === successColor && style.borderColor === successColor,
              output: control?.querySelector("output")?.textContent ?? "",
              action: add.dataset.action,
              rect: add.getBoundingClientRect().toJSON() };
          }) };
      }.toString(),
    });
    return reply.result.value;
  }
  // Mark as known and Ignore in the pinned header's row (#520).
  async function wordStatus() {
    const object = await resolvePopupObject();
    if (!object) return null;
    const reply = await cdp.send("Runtime.callFunctionOn", {
      objectId: object.objectId, returnByValue: true,
      functionDeclaration: function () {
        const row = this.querySelector(".gsm-hoshidicts-primary-header > .gsm-hoshidicts-entry-actions");
        const kind = node => node.dataset.wordStatus
          ?? [["mine-button", "add"], ["audio-control", "audio"], ["note-button", "note"]]
            .find(([name]) => node.classList.contains(`gsm-hoshidicts-${name}`))?.[1] ?? node.className;
        return { order: row ? [...row.children].filter(node => !node.hidden).map(kind) : [],
          buttons: [...(row?.querySelectorAll(":scope > .gsm-hoshidicts-word-status-button") ?? [])].map(button => ({
            status: button.dataset.wordStatus, pressed: button.getAttribute("aria-pressed"),
            label: button.getAttribute("aria-label"), busy: button.getAttribute("aria-busy") === "true" })) };
      }.toString(),
    });
    return reply.result.value;
  }
  async function focusAnki(index = 0) {
    const object = await resolvePopupObject();
    if (!object) return false;
    const reply = await cdp.send("Runtime.callFunctionOn", {
      objectId: object.objectId, returnByValue: true, arguments: [{ value: index }],
      functionDeclaration: function (buttonIndex) {
        const button = this.querySelectorAll(".gsm-hoshidicts-mine-button")[buttonIndex];
        button?.focus();
        return button?.getRootNode().activeElement === button;
      }.toString(),
    });
    return reply.result.value;
  }
  async function ankiAccessibility(index = 0) {
    const popup = await resolvePopupObject();
    if (!popup) return null;
    const { result, exceptionDetails } = await cdp.send("Runtime.callFunctionOn", {
      objectId: popup.objectId, arguments: [{ value: index }],
      functionDeclaration: function (buttonIndex) {
        return this.querySelectorAll(".gsm-hoshidicts-mine-button")[buttonIndex] ?? null;
      }.toString(),
    });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
    if (!result.objectId) return null;
    try {
      const { node } = await cdp.send("DOM.describeNode", { objectId: result.objectId });
      const { nodes } = await cdp.send("Accessibility.getPartialAXTree", {
        backendNodeId: node.backendNodeId, fetchRelatives: false,
      });
      const ax = nodes.find(candidate => !candidate.ignored) ?? nodes[0];
      const property = name => {
        const value = ax?.properties?.find(candidate => candidate.name === name)?.value;
        if (value?.type === "boolean") return Boolean(value.value);
        return value?.value ?? null;
      };
      return {
        role: ax?.role?.value ?? null,
        name: ax?.name?.value ?? null,
        disabled: property("disabled"),
        busy: property("busy"),
        focusable: property("focusable"),
      };
    } finally {
      await cdp.send("Runtime.releaseObject", { objectId: result.objectId });
    }
  }
  async function lookupStatistics(action = "read") {
    const object = await resolvePopupObject();
    if (!object) return null;
    const reply = await cdp.send("Runtime.callFunctionOn", {
      objectId: object.objectId, returnByValue: true, arguments: [{ value: action }],
      functionDeclaration: function (action) {
        const root = this.getRootNode();
        const line = this.querySelector(".gsm-hoshidicts-lookup-stats");
        if (action === "remember") {
          root.__lookupStatisticsView = {
            popup: this,
            line,
            panel: this.querySelector(".gsm-hoshidicts-tab-panel"),
          };
        }
        if (action === "cleanup") {
          delete root.__lookupStatisticsView;
          return null;
        }
        const saved = root.__lookupStatisticsView;
        return {
          hidden: line?.hidden ?? true,
          text: line?.textContent ?? "",
          popupHidden: this.hidden,
          samePopup: saved?.popup === this,
          sameLine: saved?.line === line,
          samePanel: saved?.panel === this.querySelector(".gsm-hoshidicts-tab-panel"),
        };
      }.toString(),
    });
    return reply.result.value;
  }
  async function definitionBlur() {
    const object = await resolvePopupObject();
    if (!object) return null;
    const reply = await cdp.send("Runtime.callFunctionOn", {
      objectId: object.objectId, returnByValue: true,
      functionDeclaration: function () {
        const definitions = this.querySelector(".gsm-hoshidicts-definitions");
        const rect = definitions?.getBoundingClientRect();
        return {
          state: this.dataset.definitionBlurState ?? "revealed",
          definitionsState: definitions?.dataset.definitionBlurState ?? "revealed",
          definitionsPoint: rect && { x: rect.x + rect.width / 2, y: rect.y + Math.min(rect.height / 2, 12) },
          audioAttempted: Boolean(this.querySelector('.gsm-hoshidicts-audio-button[aria-busy]')),
          countText: this.querySelector(".gsm-hoshidicts-lookup-stats")?.textContent ?? "",
        };
      }.toString(),
    });
    return reply.result.value;
  }
  // Where the popup actually is on the page, for assertions about what a
  // screenshot of that page may contain.
  async function rect() {
    const object = await resolvePopupObject();
    if (object === null) return null;
    const reply = await cdp.send("Runtime.callFunctionOn", {
      objectId: object.objectId, returnByValue: true,
      functionDeclaration: function () {
        const box = this.getBoundingClientRect();
        return { x: box.x, y: box.y, width: box.width, height: box.height };
      }.toString(),
    });
    return reply.result.value;
  }

  return {
    anki, ankiAccessibility, audio, click, compactSummaries, compactSummaryTextRect, definitionBlur, definitionTextRect, dictionaryTabs, deinflection, externalLink, focusAnki, glossaryCard, imagePreview,
    lookupStatistics, nested, rect, sourcePaint, retainedControls, selectGlossaryText, state, visible,
    waitForVisible, waitForHidden, wordStatus, writeNote,
  };
}

// Content scripts have their own Highlight constructor; changing the page's
// main-world global would leave the production path untested.
async function forceSourceFallback(tab, settings) {
  const cdp = await tab.createCDPSession();
  const contexts = [];
  cdp.on("Runtime.executionContextCreated", ({ context }) => contexts.push(context.id));
  await cdp.send("Runtime.enable");
  const extensionId = new URL(settings.url()).host;
  let contextId;
  for (const id of contexts) {
    const { result } = await cdp.send("Runtime.evaluate", { contextId: id,
      expression: `typeof HDPopup === "object" && globalThis.chrome?.runtime?.id === ${JSON.stringify(extensionId)}` });
    if (result.value === true) { contextId = id; break; }
  }
  if (contextId === undefined) { await cdp.detach(); throw new Error("Hachidori content world not found"); }
  const evaluate = async expression => {
    const { exceptionDetails } = await cdp.send("Runtime.evaluate", { contextId, expression });
    if (exceptionDetails) throw new Error(exceptionDetails.text);
  };
  const toggle = async () => {
    for (const enabled of [false, true]) {
      await settings.evaluate(async sourceHighlightEnabled => {
        const { options } = await chrome.storage.local.get("options");
        const reply = await chrome.runtime.sendMessage({ target: "hoshidicts-worker", type: "hd_options_write",
          baseRevision: options.revision, options: { sourceHighlightEnabled } });
        if (!reply.ok) throw new Error(reply.error);
      }, enabled);
      await tab.evaluate(() => new Promise(done => setTimeout(done, 100)));
    }
  };
  await evaluate("globalThis.__sourceHighlightConstructor = globalThis.Highlight; globalThis.Highlight = undefined");
  await toggle();
  return async () => {
    try {
      await evaluate("globalThis.Highlight = globalThis.__sourceHighlightConstructor; delete globalThis.__sourceHighlightConstructor");
      await toggle();
    } finally { await cdp.detach(); }
  };
}

// The content script runs at document_idle and builds its host lazily, on the
// first hover, so there is nothing in the DOM to wait for beforehand: a mouse
// move that lands before its listeners attach is simply lost. So re-fire
// mousemove until the popup answers, instead of sleeping long enough to hope the
// script was ready -- the popup appearing is the only real synchronisation here.
async function hoverForPopup(page, popup, selector, {
  accept = null,
  charFraction = 0.15,
  attempts = 12,
  point = null,
} = {}) {
  const box = point ?? await (await page.$(selector)).boundingBox();
  // Aim at the first glyph rather than the centre, so the scan starts at the
  // beginning of the word and `matched` covers the whole inflection.
  const x = point ? point.x : box.x + box.width * charFraction;
  const y = point ? point.y : box.y + box.height / 2;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    // mousemove only fires when the position changes, so step off the word
    // before stepping back onto it.
    await page.mouse.move(2, 2);
    await page.mouse.move(x, y);
    const state = await popup.waitForVisible(1500, accept);
    if (state !== null) return state;
  }
  return null;
}

export { forceSourceFallback, hoverForPopup, popupReader };
