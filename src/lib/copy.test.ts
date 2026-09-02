import { test } from "node:test";
import assert from "node:assert/strict";
import {
  composerCounter,
  greetingForHour,
  HINT_FIRST_ANSWER,
  messageTooLongLine,
  PIPELINE_ERROR_LINES,
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

test("the first-answer hint says the team line is a steer", () => {
  assert.match(HINT_FIRST_ANSWER, /steer/);
});
