import assert from "node:assert/strict";
import test from "node:test";
import {
  effectiveDictionarySchedule, nextDictionaryUpdateCheck, nextManagedUpdateCheck,
} from "../extension/managed-dictionary-source.js";

const now = Date.parse("2026-09-07T12:00:00Z");
const hour = 60 * 60 * 1000;
const managed = patch => ({ isUpdatable: true, indexUrl: "https://example.com/index.json",
  downloadUrl: "https://example.com/dictionary.zip", ...patch });

test("per-dictionary schedules inherit by default and explicit policies override global Off", () => {
  assert.equal(effectiveDictionarySchedule(managed(), "daily"), "daily");
  assert.equal(effectiveDictionarySchedule(managed({ updateScheduleOverride: null }), "weekly"), "weekly");
  assert.equal(effectiveDictionarySchedule(managed({ updateScheduleOverride: "hourly" }), "off"), "hourly");
  assert.equal(nextDictionaryUpdateCheck(managed({ updateScheduleOverride: "off" }), "hourly", now), null);
  assert.equal(nextDictionaryUpdateCheck({ isUpdatable: false }, "hourly", now), null);
});

test("due times include disabled packages and advance after successful or failed attempts", () => {
  for (const [schedule, hours] of [["hourly", 1], ["daily", 24], ["weekly", 168], ["monthly", 720]]) {
    for (const status of ["up-to-date", "check-failed", "update-available"]) {
      const dictionary = managed({ enabled: false, updateScheduleOverride: schedule,
        lastUpdateCheck: { checkedAt: new Date(now - hour).toISOString(), status } });
      assert.equal(nextDictionaryUpdateCheck(dictionary, "off", now), now + (hours - 1) * hour);
    }
  }
  for (const checkedAt of [undefined, null, "invalid"]) {
    assert.equal(nextDictionaryUpdateCheck(managed({ lastUpdateCheck: { checkedAt } }), "daily", now), now);
  }
});

test("one aggregate due time selects only managed active schedules", () => {
  const checked = { checkedAt: new Date(now).toISOString() };
  assert.equal(nextManagedUpdateCheck([], "hourly", now), null);
  assert.equal(nextManagedUpdateCheck([managed({ updateScheduleOverride: "off" })], "daily", now), null);
  const dictionaries = [managed({ lastUpdateCheck: checked }),
    managed({ enabled: false, updateScheduleOverride: "hourly", lastUpdateCheck: checked }),
    { isUpdatable: false }];
  assert.equal(nextManagedUpdateCheck(dictionaries, "daily", now), now + hour);
  assert.equal(nextManagedUpdateCheck(dictionaries, "off", now), now + hour);
  assert.equal(nextManagedUpdateCheck([...dictionaries, managed()], "daily", now), now);
  assert.equal(nextManagedUpdateCheck([managed({ lastUpdateCheck: { checkedAt: new Date(now - 48 * hour).toISOString() } })], "daily", now), now);
});
