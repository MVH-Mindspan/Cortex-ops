import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fallbackMeta,
  loadSopMeta,
  parseSopFile,
  statusKind
} from "./frontmatter.ts";
import type { FileMeta } from "./pipeline.ts";

// What the exporter writes now: status, use_when and the categories list
// alongside the five keys the earlier export wrote.
const NEW_FORMAT = `---
title: "\\U0001F9E0 Imaging Order Requirements — Amyloid PET & MRI Checklist"
source_url: https://app.notion.com/p/Imaging-Order-Requirements-3cdb5943d52d81a19494e5a6545f2a20
category: SOP
categories:
  - SOP
  - All Ops
status: Draft — Needs Review
use_when: "amyloid PET order, ICD-10, VRI"
last_edited: '2026-09-03T00:00:00.000Z'
---

## Amyloid PET orders
1. Exact study name.
`;

// Copied from a file already in the bucket: five keys, no status key, the
// status only in the title suffix, and a folded (>-) source_url.
const LEGACY = `---
title: "\\U0001F4CA Results & Next-Steps Requests (DRAFT — Needs Review)"
source_url: >-
  https://app.notion.com/p/Results-Next-Steps-Requests-DRAFT-Needs-Review-3cdb5943d52d8189bde6c232816f049f
category: uncategorized
owner: ''
last_edited: '2026-08-31T22:58:00.000Z'
---

body
`;

const withHeader = (keys: string) => `---\n${keys}\n---\n\nbody\n`;

test("parseSopFile reads the new-format header and returns the body alone", () => {
  const meta = parseSopFile("imaging.md", NEW_FORMAT);
  const expected: FileMeta = {
    title: "🧠 Imaging Order Requirements — Amyloid PET & MRI Checklist",
    category: "SOP",
    last_edited: "2026-09-03T00:00:00.000Z",
    source_url:
      "https://app.notion.com/p/Imaging-Order-Requirements-3cdb5943d52d81a19494e5a6545f2a20",
    status: "draft",
    use_when: "amyloid PET order, ICD-10, VRI",
    text: "## Amyloid PET orders\n1. Exact study name."
  };
  assert.deepEqual(meta, expected);
  assert.ok(meta.text.startsWith("## Amyloid"));
  assert.ok(!meta.text.includes("source_url:"));
});

test("parseSopFile falls back to the title suffix for files without a status key", () => {
  const meta = parseSopFile("results.md", LEGACY);
  assert.equal(
    meta.title,
    "📊 Results & Next-Steps Requests (DRAFT — Needs Review)"
  );
  assert.equal(meta.status, "draft");
  assert.equal(meta.use_when, null);
  assert.equal(meta.category, "uncategorized");
  assert.equal(
    meta.source_url,
    "https://app.notion.com/p/Results-Next-Steps-Requests-DRAFT-Needs-Review-3cdb5943d52d8189bde6c232816f049f"
  );
  assert.equal(meta.last_edited, "2026-08-31T22:58:00.000Z");
  assert.equal(meta.text, "body");
});

test("parseSopFile normalises the status label", () => {
  assert.equal(
    parseSopFile("k.md", withHeader("title: X\nstatus: In Review")).status,
    "review"
  );
  assert.equal(
    parseSopFile("k.md", withHeader("title: X\nstatus: Approved")).status,
    "approved"
  );
  assert.equal(
    parseSopFile("k.md", withHeader("title: X\nstatus: ''")).status,
    null
  );
  assert.equal(
    parseSopFile("k.md", withHeader("title: X\nstatus: Needs Review")).status,
    "review"
  );
  assert.equal(
    parseSopFile("k.md", withHeader("title: X\nstatus: [Draft]")).status,
    "draft"
  );
  assert.equal(parseSopFile("k.md", withHeader("title: X")).status, null);
});

test("parseSopFile takes the first string when the export writes a list", () => {
  assert.equal(
    parseSopFile("k.md", withHeader("category:\n  - Care Support\n  - SOP"))
      .category,
    "Care Support"
  );
  assert.equal(
    parseSopFile("k.md", withHeader("category: 42")).category,
    "uncategorized"
  );
  assert.equal(
    parseSopFile("k.md", withHeader("category: []")).category,
    "uncategorized"
  );
  assert.equal(
    parseSopFile("k.md", withHeader("category:\n  - 1\n  - 2")).category,
    "uncategorized"
  );
  assert.equal(
    parseSopFile("k.md", withHeader("use_when: [a, b]")).use_when,
    "a"
  );
});

test("an unquoted YAML timestamp comes back as an ISO string", () => {
  assert.equal(
    parseSopFile("k.md", withHeader("last_edited: 2026-09-03T00:00:00.000Z"))
      .last_edited,
    "2026-09-03T00:00:00.000Z"
  );
});

test("parseSopFile never throws on garbled or missing frontmatter", () => {
  assert.deepEqual(parseSopFile("k.md", "no frontmatter here"), {
    ...fallbackMeta("k.md"),
    text: "no frontmatter here"
  });
  assert.deepEqual(
    parseSopFile("k.md", "---\ntitle: [unclosed\n---\nbody"),
    fallbackMeta("k.md")
  );
  assert.deepEqual(parseSopFile("k.md", ""), fallbackMeta("k.md"));
});

test("fallbackMeta is the shape every caller can rely on", () => {
  assert.deepEqual(fallbackMeta("imaging.md"), {
    title: "imaging.md",
    category: "uncategorized",
    last_edited: null,
    source_url: null,
    status: null,
    use_when: null,
    text: ""
  });
});

test("a title with non-breaking spaces comes back with plain spaces", () => {
  const meta = parseSopFile(
    "k.md",
    withHeader('title: "Imaging\u00a0Order\u00a0Requirements"')
  );
  assert.equal(meta.title, "Imaging Order Requirements");
  assert.ok(!meta.title.includes("\u00a0"));
});

test("the raw status label never reaches the parsed meta", () => {
  const allowed = new Set(["draft", "review", "approved", null]);
  const labels = [
    '"Draft — Needs Review"',
    '"Draft"',
    '"In Review"',
    '"Needs Review"',
    '"Approved"',
    '""'
  ];
  for (const label of labels) {
    const meta = parseSopFile("k.md", withHeader(`title: X\nstatus: ${label}`));
    assert.ok(allowed.has(meta.status), `${label} -> ${String(meta.status)}`);
  }
  assert.ok(allowed.has(parseSopFile("k.md", withHeader("title: X")).status));
});

test("statusKind maps the labels, then falls back to the title convention", () => {
  assert.equal(statusKind("Draft — Needs Review", "X"), "draft");
  assert.equal(statusKind("In Review", "X"), "review");
  assert.equal(statusKind("Needs Review", "X"), "review");
  assert.equal(statusKind("Approved", "X"), "approved");
  assert.equal(statusKind(null, "X (DRAFT — Needs Review)"), "draft");
  assert.equal(statusKind(null, "X (Draft)"), "draft");
  assert.equal(statusKind(null, "X (draft)"), null);
  assert.equal(statusKind(null, "X"), null);
  assert.equal(statusKind("", "X (DRAFT)"), "draft");
});

// The shared R2 read: one bad object must degrade to fallbackMeta for that key
// alone, never fail the batch. The Worker and the eval harness both go through
// this, so a regression here silently decouples the harness from production.
test("loadSopMeta parses what it can and falls back per key", async () => {
  const bucket = {
    get(key: string) {
      if (key === "present.md") {
        return Promise.resolve({ text: () => Promise.resolve(NEW_FORMAT) });
      }
      if (key === "missing.md") return Promise.resolve(null);
      return Promise.reject(new Error("R2 is having a day"));
    }
  };
  const meta = await loadSopMeta(bucket, [
    "present.md",
    "missing.md",
    "throws.md"
  ]);
  assert.deepEqual([...meta.keys()], ["present.md", "missing.md", "throws.md"]);
  assert.equal(meta.get("present.md")?.status, "draft");
  assert.match(
    meta.get("present.md")?.title ?? "",
    /Imaging Order Requirements/
  );
  assert.deepEqual(meta.get("missing.md"), fallbackMeta("missing.md"));
  assert.deepEqual(meta.get("throws.md"), fallbackMeta("throws.md"));
});
