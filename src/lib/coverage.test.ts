import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COVERAGE_VALUES,
  countGaps,
  countSteps,
  splitCoverageLine
} from "./coverage.ts";

test("splitCoverageLine: colon separator, blank line before the body", () => {
  assert.deepEqual(splitCoverageLine("Coverage: partial\n\nSituation: x"), {
    coverage: "partial",
    rest: "Situation: x"
  });
});

test("splitCoverageLine: bold markers, capitalized value, CRLF", () => {
  assert.deepEqual(
    splitCoverageLine("**Coverage: None.**\r\nWho handles this:"),
    { coverage: "none", rest: "Who handles this:" }
  );
});

test("splitCoverageLine: leading blank lines tolerated, dash separator", () => {
  assert.deepEqual(splitCoverageLine("\n\nCoverage - full\nAnswer: y"), {
    coverage: "full",
    rest: "Answer: y"
  });
});

test("splitCoverageLine: same-line form keeps the rest of the line", () => {
  const { coverage, rest } = splitCoverageLine(
    "Coverage: partial. Situation: A patient is at the desk."
  );
  assert.equal(coverage, "partial");
  assert.equal(rest.startsWith("Situation:"), true);
});

test("splitCoverageLine: a Coverage mention that is not on the first line is left alone", () => {
  const head = "Situation: Coverage: full mentioned later";
  assert.deepEqual(splitCoverageLine(head), { coverage: null, rest: head });
});

test("splitCoverageLine: an unknown value is left alone", () => {
  const head = "Coverage: unknown\n\nAnswer:";
  assert.deepEqual(splitCoverageLine(head), { coverage: null, rest: head });
});

test("splitCoverageLine: empty string", () => {
  assert.deepEqual(splitCoverageLine(""), { coverage: null, rest: "" });
});

test("COVERAGE_VALUES lists the three coverage values", () => {
  assert.deepEqual(COVERAGE_VALUES, ["full", "partial", "none"]);
});

const STEPPED_ANSWER = `Do now
1. a
2. b

Then
3. c

What the SOPs say
1. [1] X
2. [2] Y`;

test("countSteps: stops at the What the SOPs say heading, citations excluded", () => {
  assert.equal(countSteps(STEPPED_ANSWER), 3);
});

test("countSteps: an ATX heading form also stops the count", () => {
  const text = STEPPED_ANSWER.replace(
    "What the SOPs say",
    "### What the SOPs say"
  );
  assert.equal(countSteps(text), 3);
});

test("countSteps: a bolded heading form also stops the count", () => {
  const text = STEPPED_ANSWER.replace(
    "What the SOPs say",
    "**What the SOPs say**"
  );
  assert.equal(countSteps(text), 3);
});

test("countSteps: no heading counts every numbered line", () => {
  const text = `Do now
1. a
2. b

Then
3. c`;
  assert.equal(countSteps(text), 3);
});

test("countSteps: an indented quote continuation is not a step", () => {
  const text = `Do now
1. Tell the patient. Use the script below.
   "You're all set for today's visit."
2. Notify Lindsay.`;
  assert.equal(countSteps(text), 2);
});

test("countGaps: counts dash lines up to One question", () => {
  const text = `Not covered by the SOPs
- one
- two

One question
What?`;
  assert.equal(countGaps(text), 2);
});

test("countGaps: Nothing is zero gaps", () => {
  assert.equal(countGaps("Not covered by the SOPs\nNothing"), 0);
});

test("countGaps: no section at all is zero gaps", () => {
  assert.equal(countGaps("Do now\n1. a"), 0);
});

// Regression pins for the catastrophic-backtracking fix: the heading regexes
// used to run with the "m" flag over the whole text ("^\s*#{0,6}\s*\**\s*..."),
// so a long run of blank lines let "^" retry at every line start while three
// adjacent "\s*"-shaped groups fought over the same newlines — 2.3s at 2,000
// characters, growing exponentially. COVERAGE_LINE's "\s*(?:\*\*)?\s*" prefix
// had the analogous quadratic shape over a long run of spaces. These budgets
// are generous (the fixed versions finish in low single-digit milliseconds)
// so the test is not flaky, while still catching a reintroduced blowup, which
// would miss by many orders of magnitude, not a few percent.
test("countSteps: 200,000 characters of blank lines stays linear", () => {
  const text = "\n".repeat(200_000);
  const start = performance.now();
  const steps = countSteps(text);
  const elapsed = performance.now() - start;
  assert.equal(steps, 0);
  assert.equal(elapsed < 100, true, `took ${elapsed}ms`);
});

test("countGaps: 200,000 characters of blank lines stays linear", () => {
  const text = "\n".repeat(200_000);
  const start = performance.now();
  const gaps = countGaps(text);
  const elapsed = performance.now() - start;
  assert.equal(gaps, 0);
  assert.equal(elapsed < 100, true, `took ${elapsed}ms`);
});

test("splitCoverageLine: a 64,000-character first line of spaces stays linear", () => {
  const head = " ".repeat(64_000);
  const start = performance.now();
  const result = splitCoverageLine(head);
  const elapsed = performance.now() - start;
  assert.deepEqual(result, { coverage: null, rest: head });
  assert.equal(elapsed < 50, true, `took ${elapsed}ms`);
});
