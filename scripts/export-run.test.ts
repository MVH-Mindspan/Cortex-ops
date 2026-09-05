import { test } from "node:test";
import assert from "node:assert/strict";
import { unexplainedStale } from "./export-run.ts";
import type { StaleEntry } from "./manifest.ts";

const EARLIER = "2026-08-01T00:00:00.000Z";
const NOW = "2026-09-03T00:00:00.000Z";

function staleEntry(
  key: string,
  notionId?: string,
  since = EARLIER
): StaleEntry {
  return { key, since, ...(notionId ? { notion_id: notionId } : {}) };
}

test("unexplainedStale: a stale key whose page this run saw is explained", () => {
  // The run listed p1 and skipped it (excluded, untitled or archived), so its
  // key going stale is this export's own doing, not a missing page. It stays
  // explained however long it sits in the stale list.
  const stale = [staleEntry("sop-template.md", "p1")];
  assert.deepEqual(unexplainedStale(stale, new Set(["p1"])), []);
});

test("unexplainedStale: a renamed page's old key is explained once the page is seen again", () => {
  // p1 exported as refills.md last run and as prescription-refills.md this
  // run: the old key is stale, but the page is right there in the page set.
  const stale = [staleEntry("refills.md", "p1", NOW)];
  assert.deepEqual(unexplainedStale(stale, new Set(["p1", "p2"])), []);
});

test("unexplainedStale: a vanished page stays unexplained on consecutive runs", () => {
  const seenIds = new Set(["p2"]);
  // First run: p1 is gone from Notion, so its key going stale is unexplained
  // and the guard can trip.
  const first = [staleEntry("refills.md", "p1", NOW)];
  assert.deepEqual(unexplainedStale(first, seenIds), ["refills.md"]);
  // Next run, with the entry carried forward by reconcileManifest keeping its
  // id: still unexplained, so the guard does not quietly disarm itself.
  const carried = [staleEntry("refills.md", "p1", EARLIER)];
  assert.deepEqual(unexplainedStale(carried, seenIds), ["refills.md"]);
});

test("unexplainedStale: an entry with no id is unexplained", () => {
  // A manifest written before ids were recorded, or a hand-written one: there
  // is no id to check, so the key cannot be explained away.
  const stale = [staleEntry("orphan.md")];
  assert.deepEqual(unexplainedStale(stale, new Set(["p1"])), ["orphan.md"]);
});

test("unexplainedStale: returns only the unexplained keys, in input order", () => {
  const stale = [
    staleEntry("seen.md", "p1"),
    staleEntry("gone.md", "p2"),
    staleEntry("orphan.md")
  ];
  assert.deepEqual(unexplainedStale(stale, new Set(["p1"])), [
    "gone.md",
    "orphan.md"
  ]);
});

test("unexplainedStale: does not mutate its input", () => {
  const stale = [staleEntry("seen.md", "p1"), staleEntry("gone.md", "p2")];
  assert.deepEqual(unexplainedStale(stale, new Set(["p1"])), ["gone.md"]);
  assert.deepEqual(stale, [
    staleEntry("seen.md", "p1"),
    staleEntry("gone.md", "p2")
  ]);
});
