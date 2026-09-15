import { RULES_BLOCK_MAX_CHARS } from "./rules.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSystemPrompt,
  SYSTEM_PROMPT,
  SYSTEM_PROMPT_MAX_CHARS,
  SYSTEM_PROMPT_WITH_DIRECTORY_MAX_CHARS
} from "./prompt.ts";
import { renderTeamStructure, TEAMS } from "./teams.ts";
import { PERSONAS_MAX_CHARS } from "./personas.ts";
import { CONTACT_BLOCK_MAX_CHARS } from "./contacts.ts";
import type { ReadingPreferences } from "./reading-preferences.ts";
import {
  CHARS_PER_TOKEN,
  CONTEXT_WINDOW_TOKENS,
  HISTORY_CHAR_BUDGET,
  MAX_MESSAGE_CHARS,
  MAX_OUTPUT_TOKENS,
  MIN_PASSAGE_CHARS,
  PASSAGE_CHAR_BUDGET,
  passageBudgetFor,
  WINDOW_CHARS,
  WINDOW_RESERVE_TOKENS
} from "./pipeline.ts";

// A fictional directory entry: the real directory lives in Notion and R2,
// never in this public repository.
const DIRECTORY = [
  "Avery Quinn: Intake Lead (Operations)",
  "- Owns: New referrals",
  "- Out of scope: Clinical questions → Blake Rowe",
  "- Backup: Blake Rowe",
  "- Reach: Slack #fictional-intake"
].join("\n");

const STYLES: ReadingPreferences[] = [
  { length: "concise", familiarity: "new" },
  { length: "concise", familiarity: "experienced" },
  { length: "detailed", familiarity: "new" },
  { length: "detailed", familiarity: "experienced" }
];

const HEADINGS = [
  "### Hard rules",
  "### Writing rules",
  "### Which format to use",
  "### Coverage line",
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

test("the citation spec asks for a labelled, unbroken quote and no link", () => {
  // The Worker rebuilds the section from retrieval (lib/citations.ts): the
  // model supplies the pointer and the wording, Cortex supplies the link and
  // the section name.
  const spec = section("### Incident format", "### Question format");
  assert.match(spec, /copied word for word and unbroken/);
  assert.match(spec, /No link and no section name/);
});

test("the example's citation line is a passage label and a title, with no link", () => {
  const example = section("### Example");
  assert.doesNotMatch(example, /https?:\/\//);
  const citations = example.slice(example.indexOf("\nWhat the SOPs say\n"));
  assert.ok(
    citations.startsWith(
      "\nWhat the SOPs say\n1. [1] Patient Check-In, Athena\n"
    ),
    citations.slice(0, 120)
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
      RULES_BLOCK_MAX_CHARS +
      HISTORY_CHAR_BUDGET +
      MAX_MESSAGE_CHARS) /
    CHARS_PER_TOKEN;
  assert.ok(
    inputTokens + MAX_OUTPUT_TOKENS + WINDOW_RESERVE_TOKENS <=
      CONTEXT_WINDOW_TOKENS,
    String(inputTokens)
  );
});

test("adds the team directory only when one is passed, after the team structure", () => {
  assert.equal(buildSystemPrompt(undefined, ""), SYSTEM_PROMPT);
  assert.equal(buildSystemPrompt(undefined, " \n "), SYSTEM_PROMPT);
  const prompt = buildSystemPrompt(undefined, DIRECTORY);
  assert.equal(prompt.split("### Team directory").length, 2);
  assert.equal(prompt.split(DIRECTORY).length, 2);
  ordered(prompt, [
    "### Team structure",
    renderTeamStructure(),
    "### Team directory",
    DIRECTORY,
    "### Example"
  ]);
  assert.match(
    prompt,
    /Copy the name, title, reach and backup exactly as the entry writes them, and always give the Backup: "If <first name> is unavailable, contact <Backup>\."/
  );
  assert.match(
    prompt,
    /When no entry covers the work, name no one and keep the team steer\./
  );
});

test("with a directory the rules allow one named contact; without, they forbid any", () => {
  const withDirectory = buildSystemPrompt(undefined, DIRECTORY);
  assert.match(SYSTEM_PROMPT, / Never a person, never a channel\./);
  assert.doesNotMatch(withDirectory, /Never a person, never a channel/);
  assert.doesNotMatch(SYSTEM_PROMPT, /^17\. /m);
  assert.match(
    withDirectory,
    /^17\. The team directory is a steer, not an SOP\./m
  );
  assert.match(
    withDirectory,
    /^12\. The team structure is a steer, not an SOP\./m
  );
  assert.match(
    withDirectory,
    /"the team structure" for who handles the work, and "the team directory" for who to contact/
  );
  assert.match(withDirectory, /Who handles this, at most 5 sentences/);
  assert.match(SYSTEM_PROMPT, /Who handles this, at most 3 sentences/);
  assert.match(
    withDirectory,
    /"Contact <Name>, <Title>, on <Reach>\. If <first name> is unavailable, contact <Backup>\."/
  );
  // Live eval (14 Sep 2026): without this the model named whoever sat on the
  // team it had just named, and dropped the backup.
  assert.match(withDirectory, /choose by the work itself, not by the team/);
  assert.match(
    withDirectory,
    /any contact or channel that is not in a quoted passage or the team directory/
  );
  // The example is unchanged: it never names a person as a contact.
  assert.equal(
    withDirectory.slice(withDirectory.indexOf("### Example")),
    SYSTEM_PROMPT.slice(SYSTEM_PROMPT.indexOf("### Example"))
  );
});

test("with a directory, Who handles this leads with the person, then the backup, then the team", () => {
  // Operator feedback (15 Sep 2026): the team-first line buried the one thing
  // the reader acts on, a name and a channel.
  const prompt = buildSystemPrompt(undefined, DIRECTORY);
  const start = prompt.indexOf("Who handles this: ");
  const spec = prompt.slice(start, prompt.indexOf("\n", start));
  ordered(spec, [
    '"Contact <Name>, <Title>, on <Reach>.',
    "If <first name> is unavailable, contact <Backup>.",
    "If you can't reach either, message the <Team> team on Slack; this likely sits with its <Function> function.",
    'Team form, in one to three sentences: Start with "Likely the"'
  ]);
  // Without a directory the line leads with the team and names no person.
  assert.match(
    SYSTEM_PROMPT.slice(SYSTEM_PROMPT.indexOf("Who handles this: ")),
    /^Who handles this: One to three sentences\. Start with "Likely the"/
  );
  assert.doesNotMatch(SYSTEM_PROMPT, /Contact <Name>|If you can't reach/);
  // Neither asks for a "because the team structure gives it" clause.
  assert.doesNotMatch(prompt, /from that function's line/);
  assert.doesNotMatch(SYSTEM_PROMPT, /from that function's line/);
});

test("every style with a directory at its ceiling stays under the directory ceiling", () => {
  const unit = `${DIRECTORY}\n\n`;
  const full = unit
    .repeat(Math.ceil(PERSONAS_MAX_CHARS / unit.length))
    .slice(0, PERSONAS_MAX_CHARS);
  for (const style of STYLES) {
    const prompt = buildSystemPrompt(style, full);
    assert.ok(
      prompt.length <= SYSTEM_PROMPT_WITH_DIRECTORY_MAX_CHARS,
      `${prompt.length} > ${SYSTEM_PROMPT_WITH_DIRECTORY_MAX_CHARS}`
    );
    assert.ok(buildSystemPrompt(style).length <= SYSTEM_PROMPT_MAX_CHARS);
  }
});

test("the passage budget is what the window leaves, capped, and has a floor", () => {
  const request = (
    systemChars: number,
    historyChars: number,
    messageChars: number
  ) =>
    passageBudgetFor({
      systemChars,
      history: [{ content: "x".repeat(historyChars) }],
      messageChars,
      rulesChars: RULES_BLOCK_MAX_CHARS
    });
  // Without a directory even the worst case keeps the full budget.
  assert.equal(
    request(SYSTEM_PROMPT_MAX_CHARS, HISTORY_CHAR_BUDGET, MAX_MESSAGE_CHARS),
    PASSAGE_CHAR_BUDGET
  );
  // An ordinary turn with a full directory keeps the full budget too.
  assert.equal(
    request(SYSTEM_PROMPT_WITH_DIRECTORY_MAX_CHARS, 2_000, 600),
    PASSAGE_CHAR_BUDGET
  );
  // The worst case shrinks the passages, never below the floor, and fits.
  const worst = request(
    SYSTEM_PROMPT_WITH_DIRECTORY_MAX_CHARS,
    HISTORY_CHAR_BUDGET,
    MAX_MESSAGE_CHARS
  );
  assert.ok(worst >= MIN_PASSAGE_CHARS, String(worst));
  assert.ok(worst < PASSAGE_CHAR_BUDGET);
  const tokens =
    (SYSTEM_PROMPT_WITH_DIRECTORY_MAX_CHARS +
      worst +
      RULES_BLOCK_MAX_CHARS +
      HISTORY_CHAR_BUDGET +
      MAX_MESSAGE_CHARS) /
    CHARS_PER_TOKEN;
  assert.ok(
    tokens + MAX_OUTPUT_TOKENS + WINDOW_RESERVE_TOKENS <= CONTEXT_WINDOW_TOKENS,
    String(tokens)
  );
  assert.equal(request(WINDOW_CHARS, 0, 0), 0);
});

test("work is handed over on Slack, never through a ticket queue", () => {
  // Operator decision (14 Sep 2026): there is no Zendesk.
  for (const prompt of [
    SYSTEM_PROMPT,
    buildSystemPrompt(undefined, DIRECTORY)
  ]) {
    assert.doesNotMatch(prompt, /Zendesk|<route>|Route work through/);
    assert.match(prompt, /never name a ticket queue or ticketing system/);
    // Operator decision (15 Sep 2026): no "If this is not your team" line.
    assert.doesNotMatch(prompt, /"If this is not your team, message/);
    assert.match(prompt, /Never write "If this is not your team"\./);
  }
  assert.doesNotMatch(section("### Example"), /If this is not your team/);
  // With a directory, Slack stays as the last resort after the person.
  assert.match(
    buildSystemPrompt(undefined, DIRECTORY),
    /"If you can't reach either, message the <Team> team on Slack;/
  );
});

test("the directory prompt defers to the code's contact match and never says unverified", () => {
  const prompt = buildSystemPrompt(undefined, DIRECTORY);
  assert.match(prompt, /"Team directory match for this message" block/);
  assert.match(prompt, /the first person in the Team directory match/);
  assert.doesNotMatch(prompt, /unverified/i);
  assert.doesNotMatch(SYSTEM_PROMPT, /Team directory match/);
});

test("the worst case still fits with the contact match block reserved", () => {
  const worst = passageBudgetFor({
    systemChars: SYSTEM_PROMPT_WITH_DIRECTORY_MAX_CHARS,
    history: [{ content: "x".repeat(HISTORY_CHAR_BUDGET) }],
    messageChars: MAX_MESSAGE_CHARS,
    rulesChars: RULES_BLOCK_MAX_CHARS + CONTACT_BLOCK_MAX_CHARS
  });
  assert.ok(worst >= MIN_PASSAGE_CHARS, String(worst));
  const tokens =
    (SYSTEM_PROMPT_WITH_DIRECTORY_MAX_CHARS +
      worst +
      RULES_BLOCK_MAX_CHARS +
      CONTACT_BLOCK_MAX_CHARS +
      HISTORY_CHAR_BUDGET +
      MAX_MESSAGE_CHARS) /
    CHARS_PER_TOKEN;
  assert.ok(
    tokens + MAX_OUTPUT_TOKENS + WINDOW_RESERVE_TOKENS <= CONTEXT_WINDOW_TOKENS,
    String(tokens)
  );
});

test("coverage and governing rules apply before every answer, including the example", () => {
  assert.match(SYSTEM_PROMPT, /^13\. When a passage forbids/m);
  assert.match(SYSTEM_PROMPT, /^14\. A timeframe/m);
  assert.match(SYSTEM_PROMPT, /^15\. One question never asks/m);
  // Rule 16 keeps another system's task codes and branch logic (CENP-022, B1)
  // out of the reader-facing answer.
  const rule16 = SYSTEM_PROMPT.match(/^16\. .*/m)?.[0] ?? "";
  assert.match(rule16, /task or protocol codes/);
  assert.match(rule16, /CENP-022/);
  assert.match(rule16, /plain-language action/);
  assert.equal(SYSTEM_PROMPT.split("Rules stated in these passages").length, 2);
  assert.match(section("### Example"), /Answer:\n\nCoverage: full\n/);
});
