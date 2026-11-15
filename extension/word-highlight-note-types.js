// SPDX-License-Identifier: GPL-3.0-or-later
// Reading → Word highlighting → Other note types (#700): note types beside the
// first Template's whose notes, in any deck, give a word its status, each with
// the field that holds the word. Anki's note types and their fields come from
// the same discovery Anki settings uses; nothing here contacts Anki on a page.

export function createWordHighlightNoteTypes({ document, readNoteTypes, editNoteTypes, send }) {
  const element = id => document.getElementById(id);
  const list = element("word-highlight-note-type-list");
  const typeSelect = element("word-highlight-note-type");
  const fieldSelect = element("word-highlight-note-field");
  const add = element("word-highlight-note-type-add");
  const status = element("word-highlight-note-type-status");
  let models = null;
  let loading = false;
  let sequence = 0;

  const choices = (select, placeholder, names) => {
    select.replaceChildren(new document.defaultView.Option(placeholder, ""),
      ...names.map(name => new document.defaultView.Option(name, name)));
  };
  const listed = (noteType, field) => readNoteTypes().some(entry => entry.noteType === noteType && entry.field === field);
  const renderAdd = () => {
    add.disabled = !typeSelect.value || !fieldSelect.value || listed(typeSelect.value, fieldSelect.value);
  };

  // `model` "" asks for the note types alone; a note type also brings its fields.
  async function discover(model) {
    const reply = await send("hd_anki_discover", { model });
    if (!reply.ok) throw new Error(reply.error);
    if (!reply.connected) throw new Error(reply.errors.join(" ") || "Anki is not reachable.");
    return reply;
  }

  async function loadModels() {
    loading = true;
    status.textContent = "Reading note types from Anki…";
    try {
      models = (await discover("")).models;
      choices(typeSelect, "Choose a note type", models);
      status.textContent = "";
    } catch (error) {
      status.textContent = `Could not read note types from Anki: ${error.message}`;
    } finally {
      loading = false;
    }
  }

  async function loadFields() {
    const model = typeSelect.value;
    const request = ++sequence;
    choices(fieldSelect, "Choose the word field", []);
    fieldSelect.disabled = true;
    renderAdd();
    if (!model) return;
    try {
      const reply = await discover(model);
      if (request !== sequence) return;
      choices(fieldSelect, "Choose the word field", reply.fields);
      fieldSelect.disabled = false;
    } catch (error) {
      if (request === sequence) status.textContent = `Could not read the fields of ${model}: ${error.message}`;
    }
  }

  function renderList() {
    list.replaceChildren(...readNoteTypes().map((entry, index) => {
      const item = document.createElement("li");
      const name = document.createElement("span");
      name.textContent = `${entry.noteType}: ${entry.field}`;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "ghost";
      remove.textContent = "Remove";
      remove.setAttribute("aria-label", `Remove ${entry.noteType}: ${entry.field}`);
      remove.addEventListener("click", () => {
        editNoteTypes(readNoteTypes().filter((_, at) => at !== index));
        status.textContent = `Removed ${entry.noteType}.`;
        render();
        typeSelect.focus();
      });
      item.append(name, remove);
      return item;
    }));
  }

  typeSelect.addEventListener("change", () => { void loadFields(); });
  fieldSelect.addEventListener("change", renderAdd);
  add.addEventListener("click", () => {
    const entry = { noteType: typeSelect.value, field: fieldSelect.value };
    editNoteTypes([...readNoteTypes(), entry]);
    status.textContent = `Added ${entry.noteType}.`;
    render();
  });

  function render() {
    renderList();
    renderAdd();
    // The note types are read when the section first shows, and again on a
    // later visit if Anki could not be reached.
    if (models === null && !loading) void loadModels();
  }

  return { render };
}
