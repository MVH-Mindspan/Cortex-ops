import { test } from "node:test";
import assert from "node:assert/strict";
import { slugify, uniqueSlug } from "./slug.ts";

test("slugify lowercases, hyphenates and trims", () => {
  assert.equal(
    slugify("  Patient Check-In: Athena!  "),
    "patient-check-in-athena"
  );
  assert.equal(slugify("___"), "untitled");
  assert.equal(slugify("x".repeat(100)).length, 80);
});

test("uniqueSlug returns the base slug when free and reserves it", () => {
  const used = new Set<string>();
  assert.equal(uniqueSlug("refills", "0123456789abcdef", used), "refills");
  assert.ok(used.has("refills"));
});

test("uniqueSlug appends the page id prefix on a collision", () => {
  const used = new Set(["refills"]);
  assert.equal(
    uniqueSlug("refills", "0123456789abcdef", used),
    "refills-01234567"
  );
});

test("uniqueSlug keeps going until the slug is actually unique", () => {
  const used = new Set(["refills", "refills-01234567"]);
  assert.equal(
    uniqueSlug("refills", "0123456789abcdef", used),
    "refills-01234567-2"
  );
  assert.equal(
    uniqueSlug("refills", "0123456789abcdef", used),
    "refills-01234567-3"
  );
});
