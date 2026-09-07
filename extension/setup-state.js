// First-run setup state shared by the service worker, the startup page and Settings.
// SPDX-License-Identifier: GPL-3.0-or-later

export const SETUP_STATE_KEY = "setupState";
export const SETUP_STATE_SCHEMA_VERSION = 1;
export const STARTUP_PAGE = "startup.html";
// Setup advances through the first three stages; "complete" is terminal.
export const SETUP_STAGES = Object.freeze(["dictionaries", "anki", "practice", "complete"]);

// Initial preferences for a new installation. They are written once into the
// stored options, so an extension update never changes an existing user's
// reader defaults or overrides a later edit.
export const FIRST_INSTALL_OPTIONS = Object.freeze({
  showCompactDefinitionSummary: true,
  compactDefinitionSummaryCount: 3,
});

export function initialSetupState(startedAt) {
  return {
    schemaVersion: SETUP_STATE_SCHEMA_VERSION,
    revision: 1,
    startedAt,
    stage: SETUP_STAGES[0],
    completedAt: null,
  };
}

/**
 * @returns {null | {schemaVersion: 1, revision: number, startedAt: string, stage: string, completedAt: string | null}}
 */
export function normaliseSetupState(value) {
  if (value === undefined || value === null) return null;
  if (value?.schemaVersion !== SETUP_STATE_SCHEMA_VERSION) {
    throw new Error(`unsupported setup state schema ${String(value?.schemaVersion)}`);
  }
  if (!Number.isSafeInteger(value.revision) || value.revision < 1
      || typeof value.startedAt !== "string"
      || !SETUP_STAGES.includes(value.stage)
      || (value.completedAt !== null && typeof value.completedAt !== "string")) {
    throw new Error("the setup state is malformed");
  }
  return {
    schemaVersion: SETUP_STATE_SCHEMA_VERSION,
    revision: value.revision,
    startedAt: value.startedAt,
    stage: value.stage,
    completedAt: value.completedAt,
  };
}

export function setupIncomplete(state) {
  return state !== null && state.stage !== "complete";
}

// Setup only moves forward: a stale or unexpected write can neither reopen a
// finished setup nor return to an earlier stage.
export function advanceSetupState(current, stage, now) {
  if (!SETUP_STAGES.includes(stage)) throw new Error("the setup stage is invalid");
  if (SETUP_STAGES.indexOf(stage) <= SETUP_STAGES.indexOf(current.stage)) {
    throw new Error("the setup stage cannot move backwards");
  }
  return {
    ...current,
    revision: current.revision + 1,
    stage,
    completedAt: stage === "complete" ? now : null,
  };
}
