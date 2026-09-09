import { test } from "node:test";
import assert from "node:assert/strict";
import { expandSearchQuery, QUERY_HINTS, type QueryHint } from "./query.ts";

const HINTS: QueryHint[] = [
  { match: /\bfoo\b/i, add: "one two" },
  { match: /\bbar\b/i, add: "three" }
];

test("a matched hint appends its SOP terms after the original text", () => {
  assert.equal(expandSearchQuery("about foo", HINTS), "about foo\n\none two");
});

test("nothing matches leaves the text exactly as typed", () => {
  const text = "nothing to see here";
  assert.equal(expandSearchQuery(text, HINTS), text);
});

test("the operator's words always survive at the front", () => {
  const out = expandSearchQuery("foo and bar", HINTS);
  assert.ok(out.startsWith("foo and bar"));
});

test("multiple matched hints join in order", () => {
  assert.equal(expandSearchQuery("foo bar", HINTS), "foo bar\n\none two three");
});

test("matching is case-insensitive", () => {
  assert.equal(expandSearchQuery("FOO", HINTS), "FOO\n\none two");
});

test("a referral task retrieves referral vocabulary", () => {
  const out = expandSearchQuery(
    "Enrollment confirms the partner referral was received"
  );
  assert.ok(out.startsWith("Enrollment confirms"));
  assert.match(out, /referral acceptance criteria/);
});

test("a pre-visit task retrieves pre-visit vocabulary", () => {
  for (const q of ["Neurology Evaluation Pre Visit", "pre-visit prep chase"]) {
    assert.match(expandSearchQuery(q), /pre-visit checklist/, q);
  }
});

test("the shipped hints are additive only — never shorten a query", () => {
  for (const hint of QUERY_HINTS) {
    const probe = "seed text";
    assert.ok(expandSearchQuery(probe, [hint]).startsWith(probe));
  }
});
