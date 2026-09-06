import { test } from "node:test";
import assert from "node:assert/strict";
import { answerBatchAllowed } from "./answer-run.ts";
test("live answer guard counts total answers and uses Pacific time including DST", () => {
  assert.equal(
    answerBatchAllowed(4, new Date("2026-09-05T07:00:00Z"), false),
    true
  );
  assert.equal(
    answerBatchAllowed(9, new Date("2026-09-05T07:00:00Z"), false),
    false
  );
  assert.equal(
    answerBatchAllowed(4, new Date("2026-09-05T13:00:00Z"), false),
    false
  );
  assert.equal(
    answerBatchAllowed(4, new Date("2026-12-05T13:00:00Z"), false),
    true
  );
  assert.equal(
    answerBatchAllowed(50, new Date("2026-09-05T15:00:00Z"), true),
    true
  );
});
