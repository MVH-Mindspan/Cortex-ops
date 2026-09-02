import { test } from "node:test";
import assert from "node:assert/strict";
import { SYSTEM_PROMPT, SYSTEM_PROMPT_MAX_CHARS } from "./prompt.ts";
import { renderTeamStructure, TEAMS } from "./teams.ts";
import {
  CHARS_PER_TOKEN,
  CONTEXT_WINDOW_TOKENS,
  HISTORY_CHAR_BUDGET,
  MAX_MESSAGE_CHARS,
  MAX_OUTPUT_TOKENS,
  PASSAGE_CHAR_BUDGET,
  WINDOW_RESERVE_TOKENS
} from "./pipeline.ts";

const HEADINGS = [
  "### Hard rules",
  "### Writing rules",
  "### Which format to use",
  "### Incident format",
  "### Question format",
  "### How to build the answer",
  "### Team structure",
  "### Example"
];

// The prompt text between two headings (or to the end).
function section(from: string, to?: string): string {
  const start = SYSTEM_PROMPT.indexOf(from);
  assert.ok(start >= 0, from);
  const end = to ? SYSTEM_PROMPT.indexOf(to, start) : SYSTEM_PROMPT.length;
  assert.ok(end > start, to ?? "end of prompt");
  return SYSTEM_PROMPT.slice(start, end);
}

function ordered(text: string, markers: string[]): void {
  let cursor = -1;
  for (const marker of markers) {
    const at = text.indexOf(marker);
    assert.ok(at > cursor, `"${marker}" missing or out of order`);
    cursor = at;
  }
}

test("stays within its ceiling", () => {
  assert.ok(
    SYSTEM_PROMPT.length <= SYSTEM_PROMPT_MAX_CHARS,
    `${SYSTEM_PROMPT.length} > ${SYSTEM_PROMPT_MAX_CHARS}`
  );
});

test("embeds the team structure once, before the example", () => {
  const block = renderTeamStructure();
  assert.equal(SYSTEM_PROMPT.split(block).length, 2);
  ordered(SYSTEM_PROMPT, [
    "### How to build the answer",
    "### Team structure",
    block,
    "### Example"
  ]);
});

test("keeps its sections in order", () => {
  ordered(SYSTEM_PROMPT, HEADINGS);
  for (const heading of HEADINGS) {
    assert.equal(SYSTEM_PROMPT.split(heading).length, 2, heading);
  }
});

test("incident format: Who handles this sits after Urgency, before Before you start", () => {
  ordered(section("### Incident format", "### Question format"), [
    "Situation:",
    "Urgency:",
    "Who handles this:",
    "\nBefore you start\n",
    "\nDo now\n"
  ]);
});

test("question format: Who handles this sits before Answer", () => {
  const spec = section("### Question format", "### How to build the answer");
  ordered(spec, ["Who handles this:", "Answer:"]);
  assert.match(spec, /Omit it when the question asks what a term/);
});

test("the example shows the section between Urgency and Do now", () => {
  const example = section("### Example");
  ordered(example, [
    "Urgency: Now.",
    "Who handles this: Likely the",
    "\nDo now\n"
  ]);
  const line = example.match(/Who handles this: [^\n]+/)?.[0] ?? "";
  const named = line.match(
    /^Who handles this: Likely the (.+?) team, (.+?) function/
  );
  assert.ok(named, line);
  const team = TEAMS.find((t) => t.name === named[1]);
  assert.ok(team, named[1]);
  assert.ok(
    team.functions.some((fn) => fn.name === named[2]),
    named[2]
  );
  assert.doesNotMatch(line, /Lindsay/);
  assert.match(
    example,
    /The SOPs name no one for this\. Ask your team lead\. This likely sits with the Care Support team, Provider & Clinic Support function\./
  );
});

test("states rule 12 and one reader-facing name for the structure", () => {
  assert.match(
    SYSTEM_PROMPT,
    /^12\. The team structure is a steer, not an SOP\./m
  );
  assert.match(
    section("7. ", "8. "),
    /"the team structure" for who handles the work/
  );
  assert.doesNotMatch(SYSTEM_PROMPT, /directory/i);
});

test("the worst-case request fits the model window", () => {
  const inputTokens =
    (SYSTEM_PROMPT_MAX_CHARS +
      PASSAGE_CHAR_BUDGET +
      HISTORY_CHAR_BUDGET +
      MAX_MESSAGE_CHARS) /
    CHARS_PER_TOKEN;
  assert.ok(
    inputTokens + MAX_OUTPUT_TOKENS + WINDOW_RESERVE_TOKENS <=
      CONTEXT_WINDOW_TOKENS,
    String(inputTokens)
  );
});
