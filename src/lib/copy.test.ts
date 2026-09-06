import { test } from "node:test";
import assert from "node:assert/strict";
import * as copy from "./copy.ts";
import {
  CITATION_UNKNOWN_SOP_NOTE,
  CITATION_UNMATCHED_NOTE,
  composerCounter,
  greetingForHour,
  HINT_FIRST_ANSWER,
  messageTooLongLine,
  PIPELINE_ERROR_LINES,
  recentTitle,
  softPIIWarning,
  THANKS_RE
} from "./copy.ts";

test("greeting bands cover the whole day", () => {
  assert.equal(greetingForHour(5), "Good morning.");
  assert.equal(greetingForHour(11), "Good morning.");
  assert.equal(greetingForHour(12), "Good afternoon.");
  assert.equal(greetingForHour(16), "Good afternoon.");
  assert.equal(greetingForHour(17), "Good evening.");
  assert.equal(greetingForHour(20), "Good evening.");
  assert.equal(greetingForHour(21), "Working late.");
  assert.equal(greetingForHour(0), "Working late.");
  assert.equal(greetingForHour(4), "Working late.");
});

test("the thanks intercept only catches bare gratitude", () => {
  for (const s of ["thanks", "Thank you!", "ty", "cheers.", "thanks so much"]) {
    assert.equal(THANKS_RE.test(s), true, s);
  }
  for (const s of [
    "thanks for the SOP on refills",
    "thanks, what about billing?",
    "thank"
  ]) {
    assert.equal(THANKS_RE.test(s), false, s);
  }
});

test("soft warnings read naturally with plain-noun reasons", () => {
  assert.equal(
    softPIIWarning("a patient name"),
    "This might include a patient name. Worth a second look before sending."
  );
});

test("every pipeline error kind has an operator-facing line", () => {
  for (const kind of [
    "allocation",
    "spend-limit",
    "context-overflow",
    "rate-limit",
    "retrieval",
    "generation"
  ] as const) {
    assert.equal(typeof PIPELINE_ERROR_LINES[kind], "string");
    assert.ok(PIPELINE_ERROR_LINES[kind].length > 20, kind);
  }
});

test("the length lines carry the actual limit", () => {
  assert.match(messageTooLongLine(8000), /8,000 characters/);
  assert.equal(composerCounter(7240, 8000), "7,240 / 8,000");
});

test("the citation notes say what could not be checked, without blaming anyone", () => {
  // The unmatched note introduces the model's own sentence, so it ends open.
  assert.ok(CITATION_UNMATCHED_NOTE.endsWith(":"));
  assert.ok(CITATION_UNKNOWN_SOP_NOTE.endsWith("."));
  for (const line of [CITATION_UNMATCHED_NOTE, CITATION_UNKNOWN_SOP_NOTE]) {
    assert.doesNotMatch(line, /[!\p{Extended_Pictographic}]/u, line);
    assert.doesNotMatch(line, /\b(?:error|wrong|failed|invalid)\b/i, line);
  }
});

test("the first-answer hint says the team line is a steer", () => {
  assert.match(HINT_FIRST_ANSWER, /steer/);
});

test("a recents title is the first non-empty line, up to 48 characters", () => {
  assert.equal(recentTitle("\n\n  Real title\nbody"), "Real title");
  assert.equal(recentTitle("Short\nlonger second line"), "Short");
  assert.equal(recentTitle("First line\r\nSecond"), "First line");
  assert.equal(
    recentTitle(
      "Caregiver Required: confirm caregiver attendance for a Cognitive Assessment (99483) visit in 7 days.\nMore."
    ),
    "Caregiver Required: confirm caregiver attendance"
  );
  assert.equal(recentTitle("one line only"), "one line only");
  assert.equal(recentTitle("   "), "");
});

// The voice rules in the file header, enforced over every line at once so a
// new constant is covered the moment it is added.
test("every string in the copy file keeps the file's voice", () => {
  const lines = Object.entries(copy).filter(
    ([, value]) => typeof value === "string"
  ) as [string, string][];
  assert.ok(lines.length > 20);
  for (const [name, line] of lines) {
    assert.ok(line.length > 0, name);
    assert.doesNotMatch(line, /\p{Extended_Pictographic}/u, name);
    assert.doesNotMatch(line, /!/, name);
  }
});
