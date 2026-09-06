import { test } from "node:test";
import assert from "node:assert/strict";
import { pruneKeys, reconcileManifest, suspiciousDrop } from "./manifest.ts";
import type { Manifest, ManifestFile } from "./manifest.ts";

const EARLIER = "2026-08-01T00:00:00.000Z";
const NOW = "2026-09-02T12:00:00.000Z";

function file(key: string, notionId: string): ManifestFile {
  return {
    key,
    title: key.replace(/\.md$/, ""),
    notion_id: notionId,
    last_edited: EARLIER
  };
}

test("reconcileManifest: first run with no previous manifest marks nothing stale", () => {
  const exported = [file("refills.md", "p1"), file("check-in.md", "p2")];
  const { next, stale } = reconcileManifest(null, exported, new Set(), NOW);
  assert.deepEqual(stale, []);
  assert.deepEqual(next, {
    exported_at: NOW,
    files: [file("check-in.md", "p2"), file("refills.md", "p1")],
    stale: []
  });
});

test("reconcileManifest: a renamed page's old key becomes stale as of now", () => {
  const previous: Manifest = {
    exported_at: EARLIER,
    files: [file("refills.md", "p1"), file("check-in.md", "p2")],
    stale: []
  };
  const exported = [
    file("prescription-refills.md", "p1"),
    file("check-in.md", "p2")
  ];
  const { next, stale } = reconcileManifest(previous, exported, new Set(), NOW);
  assert.deepEqual(stale, ["refills.md"]);
  assert.deepEqual(next.stale, [
    { key: "refills.md", since: NOW, notion_id: "p1" }
  ]);
  assert.deepEqual(
    next.files.map((f) => f.key),
    ["check-in.md", "prescription-refills.md"]
  );
  assert.equal(next.exported_at, NOW);
});

test("reconcileManifest: a failed page keeps its key and its previous entry", () => {
  const previous: Manifest = {
    exported_at: EARLIER,
    files: [file("refills.md", "p1"), file("check-in.md", "p2")],
    stale: []
  };
  const exported = [file("check-in.md", "p2")];
  const { next, stale } = reconcileManifest(
    previous,
    exported,
    new Set(["refills.md"]),
    NOW
  );
  assert.deepEqual(stale, []);
  assert.deepEqual(next.stale, []);
  // The old object is still in R2, so the manifest must not forget it.
  assert.deepEqual(next.files, [
    file("check-in.md", "p2"),
    file("refills.md", "p1")
  ]);
});

test("reconcileManifest: a previously stale key is carried forward with its original since", () => {
  const previous: Manifest = {
    exported_at: EARLIER,
    files: [file("check-in.md", "p2")],
    stale: [{ key: "refills.md", since: EARLIER }]
  };
  const exported = [file("check-in.md", "p2")];
  const { next, stale } = reconcileManifest(previous, exported, new Set(), NOW);
  assert.deepEqual(stale, ["refills.md"]);
  assert.deepEqual(next.stale, [{ key: "refills.md", since: EARLIER }]);
});

test("reconcileManifest: a carried-over stale entry keeps its notion id", () => {
  // Without this the key could never be tied back to a page again and would
  // count as unexplained on every later run (see scripts/export-run.ts).
  const previous: Manifest = {
    exported_at: EARLIER,
    files: [file("check-in.md", "p2")],
    stale: [{ key: "refills.md", since: EARLIER, notion_id: "p1" }]
  };
  const exported = [file("check-in.md", "p2")];
  const { next } = reconcileManifest(previous, exported, new Set(), NOW);
  assert.deepEqual(next.stale, [
    { key: "refills.md", since: EARLIER, notion_id: "p1" }
  ]);
});

test("reconcileManifest: a newly stale key takes the notion id of its previous file", () => {
  const previous: Manifest = {
    exported_at: EARLIER,
    files: [file("refills.md", "p1"), file("check-in.md", "p2")],
    stale: []
  };
  const { next } = reconcileManifest(
    previous,
    [file("check-in.md", "p2")],
    new Set(),
    NOW
  );
  assert.deepEqual(next.stale, [
    { key: "refills.md", since: NOW, notion_id: "p1" }
  ]);
});

test("reconcileManifest: a key that is exported again leaves the stale list", () => {
  const previous: Manifest = {
    exported_at: EARLIER,
    files: [],
    stale: [{ key: "refills.md", since: EARLIER }]
  };
  const exported = [file("refills.md", "p1")];
  const { next, stale } = reconcileManifest(previous, exported, new Set(), NOW);
  assert.deepEqual(stale, []);
  assert.deepEqual(next.stale, []);
  assert.deepEqual(next.files, [file("refills.md", "p1")]);
});

test("reconcileManifest: an exported key wins over a failed page's old entry with the same key", () => {
  // Page p1 was "Refills", got renamed and then failed to export this run;
  // a new page p2 titled "Refills" took over the refills.md key.
  const previous: Manifest = {
    exported_at: EARLIER,
    files: [file("refills.md", "p1")],
    stale: []
  };
  const exported = [file("refills.md", "p2")];
  const failed = new Set(["rx-refills.md", "refills.md"]);
  const { next, stale } = reconcileManifest(previous, exported, failed, NOW);
  assert.deepEqual(stale, []);
  assert.deepEqual(next.files, [file("refills.md", "p2")]);
});

test("reconcileManifest: files and stale keys are sorted by key", () => {
  const previous: Manifest = {
    exported_at: EARLIER,
    files: [file("zeta.md", "p1"), file("alpha.md", "p2")],
    stale: [{ key: "mid.md", since: EARLIER }]
  };
  const exported = [file("delta.md", "p3"), file("beta.md", "p4")];
  const { next, stale } = reconcileManifest(previous, exported, new Set(), NOW);
  assert.deepEqual(
    next.files.map((f) => f.key),
    ["beta.md", "delta.md"]
  );
  assert.deepEqual(stale, ["alpha.md", "mid.md", "zeta.md"]);
  assert.deepEqual(next.stale, [
    { key: "alpha.md", since: NOW, notion_id: "p2" },
    { key: "mid.md", since: EARLIER },
    { key: "zeta.md", since: NOW, notion_id: "p1" }
  ]);
});

test("reconcileManifest: tolerates a hand-written previous manifest without a stale list", () => {
  const previous: Partial<Manifest> = { exported_at: EARLIER, files: [] };
  const { next, stale } = reconcileManifest(
    previous as Manifest,
    [],
    new Set(),
    NOW
  );
  assert.deepEqual(stale, []);
  assert.deepEqual(next.stale, []);
});

test("pruneKeys: drops pruned keys from the stale list without mutating the input", () => {
  const next: Manifest = {
    exported_at: NOW,
    files: [],
    stale: [
      { key: "a.md", since: EARLIER },
      { key: "b.md", since: NOW }
    ]
  };
  const result = pruneKeys(next, ["a.md", "never-listed.md"]);
  assert.deepEqual(result.stale, [{ key: "b.md", since: NOW }]);
  assert.deepEqual(result.files, []);
  assert.equal(result.exported_at, NOW);
  assert.equal(next.stale.length, 2);
});

test("suspiciousDrop: exporting nothing is always suspicious", () => {
  assert.equal(suspiciousDrop(0, 0, 0), true);
});

test("suspiciousDrop: a run that exports nothing is suspicious whatever the stale count", () => {
  assert.equal(suspiciousDrop(80, 0, 0), true);
});

test("suspiciousDrop: the five-object floor keeps the guard armed while the tracked count is zero", () => {
  assert.equal(suspiciousDrop(0, 4, 9), true);
});

test("suspiciousDrop: a stale count at the five-object floor is fine", () => {
  assert.equal(suspiciousDrop(10, 9, 5), false);
});

test("suspiciousDrop: a stale count over the five-object floor is suspicious", () => {
  assert.equal(suspiciousDrop(10, 4, 6), true);
});

test("suspiciousDrop: a stale count one over the ceiling of a fifth is suspicious", () => {
  assert.equal(suspiciousDrop(76, 60, 17), true);
});

test("suspiciousDrop: a stale count at the ceiling of a fifth is fine", () => {
  assert.equal(suspiciousDrop(76, 61, 16), false);
});
