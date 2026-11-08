// SPDX-License-Identifier: GPL-3.0-or-later

// Advanced → Script Store (docs/user-scripts.md), behind the scriptStore
// experimental switch: the packages people share in bee-san/hachidori-scripts.
// Check for scripts reads the catalogue.json that the repository's
// tools/build-catalogue.mjs writes, and nothing is fetched before the user
// asks. Install copies a package into Advanced → User scripts with its slug and
// version; Update replaces an installed package's parts with the catalogue's
// once the version differs. A package's JavaScript then runs as the user's own
// scripts do, through the User Scripts API.

export const SCRIPT_STORE_REPOSITORY = "https://github.com/bee-san/hachidori-scripts";
export const SCRIPT_STORE_CATALOGUE = "https://raw.githubusercontent.com/bee-san/hachidori-scripts/main/catalogue.json";
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const TEXT_FIELDS = ["name", "description", "author", "version", "license"];
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

// The catalogue's packages, in its order. The repository's checks keep it in
// this shape, so anything else is refused whole.
export function parseCatalogue(value) {
  if (!value || typeof value !== "object" || value.schema !== 1 || !Array.isArray(value.scripts)) {
    throw new Error("its list is in a format this version of Hachidori cannot read");
  }
  const slugs = new Set();
  return value.scripts.map((entry) => {
    const valid = entry && typeof entry === "object" && typeof entry.slug === "string" && SLUG.test(entry.slug)
      && !slugs.has(entry.slug)
      && TEXT_FIELDS.every(field => typeof entry[field] === "string" && entry[field].trim() !== ""
        && !CONTROL_CHARACTERS.test(entry[field]))
      && typeof entry.javascript === "string" && typeof entry.css === "string"
      && (entry.javascript.trim() !== "" || entry.css.trim() !== "");
    if (!valid) throw new Error("its list has a package this version of Hachidori cannot read");
    slugs.add(entry.slug);
    const { slug, name, description, author, version, license, javascript, css } = entry;
    return { slug, name, description, author, version, license, javascript, css };
  });
}

export function createScriptStore({
  document,
  fetch,
  readScripts,
  saveScripts,
  createId = () => document.defaultView.crypto.randomUUID(),
}) {
  const list = document.getElementById("script-store-list");
  const check = document.getElementById("script-store-check");
  const status = document.getElementById("script-store-status");
  let catalogue = null;
  let rendered = null;

  function setStatus(message, tone = "") {
    status.className = tone ? `custom-dictionary-status is-${tone}` : "custom-dictionary-status";
    status.textContent = message;
  }

  const installedOf = entry => readScripts().find(script => script.store?.slug === entry.slug) ?? null;

  function action(entry) {
    const installed = installedOf(entry);
    if (installed?.store.version === entry.version) {
      const done = document.createElement("span");
      done.className = "script-store-installed";
      done.textContent = "Installed";
      return done;
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ghost";
    button.textContent = installed ? `Update to ${entry.version}` : "Install";
    button.setAttribute("aria-label", `${installed ? `Update ${entry.name} to` : "Install"} ${installed ? entry.version : entry.name}`);
    button.addEventListener("click", () => (installed ? update(installed, entry) : install(entry)));
    return button;
  }

  function createRow(entry) {
    const row = document.createElement("li");
    row.className = "script-store-row";
    row.dataset.slug = entry.slug;
    const text = document.createElement("div");
    text.className = "script-store-text";
    const name = document.createElement("strong");
    name.className = "script-store-name";
    name.textContent = entry.name;
    const description = document.createElement("p");
    description.className = "script-store-description";
    description.textContent = entry.description;
    const details = document.createElement("span");
    details.className = "script-store-details";
    const contents = [entry.javascript.trim() && "JavaScript", entry.css.trim() && "CSS"].filter(Boolean).join(" and ");
    const source = document.createElement("a");
    source.href = `${SCRIPT_STORE_REPOSITORY}/tree/main/scripts/${entry.slug}`;
    source.target = "_blank";
    source.rel = "noopener noreferrer";
    source.textContent = "Source";
    details.append(`${contents} · version ${entry.version} · ${entry.author} · ${entry.license} · `, source);
    text.append(name, description, details);
    row.append(text, action(entry));
    return row;
  }

  function render() {
    const key = JSON.stringify([catalogue, readScripts().map(script => script.store ?? null)]);
    if (key === rendered) return;
    rendered = key;
    list.replaceChildren(...(catalogue ?? []).map(createRow));
  }

  function focusRow(slug) {
    const row = [...list.children].find(item => item.dataset.slug === slug);
    (row?.querySelector("button") ?? row?.querySelector("a") ?? check).focus();
  }

  function install(entry) {
    saveScripts([...readScripts(), { id: createId(), name: entry.name, enabled: true, javascript: entry.javascript,
      css: entry.css, store: { slug: entry.slug, version: entry.version } }]);
    render();
    focusRow(entry.slug);
    setStatus(`Installed ${entry.name} in User scripts. It runs on the pages you open or reload.`, "ready");
  }

  function update(installed, entry) {
    saveScripts(readScripts().map(script => (script.id === installed.id
      ? { ...script, name: entry.name, javascript: entry.javascript, css: entry.css,
        store: { slug: entry.slug, version: entry.version } }
      : script)));
    render();
    focusRow(entry.slug);
    setStatus(`Updated ${entry.name} to version ${entry.version}.`, "ready");
  }

  check.addEventListener("click", async () => {
    check.disabled = true;
    setStatus("Checking…");
    try {
      const response = await fetch(SCRIPT_STORE_CATALOGUE, { cache: "no-store" });
      if (!response.ok) throw new Error(`GitHub answered HTTP ${response.status}`);
      catalogue = parseCatalogue(await response.json());
      render();
      setStatus(catalogue.length === 1 ? "1 script is in the Script Store." : `${catalogue.length} scripts are in the Script Store.`, "ready");
    } catch (error) {
      setStatus(`Could not check the Script Store: ${error.message}. Check your connection, then try again.`, "error");
    } finally {
      check.disabled = false;
      // A disabled button loses focus; give it back to whoever pressed it.
      if (document.activeElement === document.body) check.focus();
    }
  });

  return { render };
}
