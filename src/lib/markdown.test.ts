import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeAnswerMarkdown } from "./markdown.ts";

test("separates a list that starts at step 4 from the heading above it", () => {
  assert.equal(
    normalizeAnswerMarkdown("Then\n4. Step four.\n5. Step five."),
    "Then\n\n4. Step four.\n5. Step five."
  );
});

test("keeps multi-line quote items of an open list together", () => {
  const text =
    'What the SOPs say\n1. Patient Check-In, Athena (https://x)\n   "If the appointment is imminent."\n2. Missed Visits (https://y)\n   "Use Clinic Missed."';
  assert.equal(
    normalizeAnswerMarkdown(text),
    'What the SOPs say\n\n1. Patient Check-In, Athena (https://x)\n   "If the appointment is imminent."\n2. Missed Visits (https://y)\n   "Use Clinic Missed."'
  );
});

test("leaves an already well-formed answer unchanged (idempotent)", () => {
  const text = "Do now\n\n1. First.\n2. Second.\n\nThen\n\n3. Third.";
  assert.equal(normalizeAnswerMarkdown(text), text);
  assert.equal(normalizeAnswerMarkdown(normalizeAnswerMarkdown(text)), text);
});
