import { test } from "node:test";
import assert from "node:assert/strict";
import { EXCLUDED_PAGES, exportDecision } from "./export-filter.ts";
import { UNTITLED } from "./notion-props.ts";

test("an untitled row is skipped as a template stub", () => {
  const decision = exportDecision({
    id: "11111111-1111-1111-1111-111111111111",
    title: UNTITLED,
    categories: []
  });
  assert.deepEqual(decision, {
    export: false,
    reason: "untitled template stub"
  });
});

test("every EXCLUDED_PAGES id is skipped with its own reason", () => {
  for (const [id, reason] of Object.entries(EXCLUDED_PAGES)) {
    const decision = exportDecision({
      id,
      title: "Some Real Title",
      categories: []
    });
    assert.ok(reason.length > 0, `reason for ${id} must not be empty`);
    assert.deepEqual(decision, { export: false, reason });
  }
});

test("EXCLUDED_PAGES has exactly twelve entries: a pasted duplicate key would silently shrink the map", () => {
  assert.equal(Object.keys(EXCLUDED_PAGES).length, 12);
});

test("a row tagged SOP exports with no warning property", () => {
  const decision = exportDecision({
    id: "22222222-2222-2222-2222-222222222222",
    title: "How to Refill a Prescription",
    categories: ["SOP"]
  });
  assert.equal(decision.export, true);
  assert.equal(Object.hasOwn(decision, "warning"), false);
});

test("a row tagged Reference exports with no warning property", () => {
  const decision = exportDecision({
    id: "44444444-4444-4444-4444-444444444444",
    title: "Care Navigation Tools",
    categories: ["Reference"]
  });
  assert.equal(decision.export, true);
  assert.equal(Object.hasOwn(decision, "warning"), false);
});

test("a row tagged Planning exports but warns: category only warns, never drops", () => {
  const decision = exportDecision({
    id: "33333333-3333-3333-3333-333333333333",
    title: "Q3 Planning Notes",
    categories: ["Planning"]
  });
  assert.deepEqual(decision, {
    export: true,
    warning: "no SOP/Reference tag"
  });
});

test("every EXCLUDED_PAGES key is a dashed lowercase Notion page id", () => {
  const notionIdPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  for (const id of Object.keys(EXCLUDED_PAGES)) {
    assert.match(id, notionIdPattern);
  }
});
