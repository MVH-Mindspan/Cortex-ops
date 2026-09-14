import { test } from "node:test";
import assert from "node:assert/strict";
import { buildScreenPrompt, SCREEN_PROMPT } from "./screen.ts";

const examples = (prompt: string) =>
  prompt.split("\n").filter((line) => / -> (yes|no)$/.test(line));

test("the base prompt keeps its rules and all eleven examples", () => {
  assert.ok(
    SCREEN_PROMPT.startsWith(
      "You screen internal healthcare ops messages for patient privacy."
    )
  );
  assert.match(SCREEN_PROMPT, /\n\nExamples:\n"My patient, John Smith/);
  assert.equal(examples(SCREEN_PROMPT).length, 11);
  assert.ok(
    SCREEN_PROMPT.endsWith(
      '"Mindy flagged #412 for an infusion check-in" -> no'
    )
  );
  assert.doesNotMatch(SCREEN_PROMPT, /team directory/);
});

test("with no staff names the prompt is exactly the base prompt", () => {
  assert.equal(buildScreenPrompt([]), SCREEN_PROMPT);
  assert.equal(buildScreenPrompt(["", "  "]), SCREEN_PROMPT);
});

test("staff names are exempted in context, with a pair of examples", () => {
  const prompt = buildScreenPrompt(["Avery Quinn", "Avery", "Morgan", "Avery"]);
  assert.match(
    prompt,
    /\n\nMindspan staff on the team directory: Avery Quinn, Avery, Morgan\. Answer no when/
  );
  assert.match(prompt, /still yes\.\n\nExamples:\n/);
  const lines = examples(prompt);
  assert.equal(lines.length, 13);
  for (const line of examples(SCREEN_PROMPT)) assert.ok(lines.includes(line));
  assert.deepEqual(lines.slice(-2), [
    '"should this go to Avery or to RCM?" -> no',
    '"the patient Avery Harper is at the desk" -> yes'
  ]);
});

test("with only full names the example uses a first name", () => {
  const lines = examples(buildScreenPrompt(["Casey Lin"]));
  assert.equal(lines.at(-2), '"should this go to Casey or to RCM?" -> no');
});
