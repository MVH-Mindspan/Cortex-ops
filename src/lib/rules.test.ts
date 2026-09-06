import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RULES_BLOCK_MAX_CHARS,
  RULES_HEADING,
  RULES_MAX_LINES,
  extractRules,
  matchRule,
  normalizeUnit,
  passageUnits,
  renderRulesBlock,
  selectRules,
  splitSentences
} from "./rules.ts";
import type { PassageInput, Rule } from "./rules.ts";
import {
  EXTERNAL_SOP,
  IMAGING_SOP,
  RESULTS_SOP,
  SURVEY_QUESTIONS,
  TASK_CLOSES_ON_ITS_OWN
} from "./rules.fixtures.ts";

function full(label: number, text: string): PassageInput {
  return { label, text, kind: "full" };
}

function texts(rules: Rule[]): string[] {
  return rules.map((rule) => rule.text);
}

// The rule the tester watched the model drop: a prohibition and a routing
// instruction, both parenthetical, inside a bullet about the ICD-10 field.
const ICD10_RULE =
  "Medicare-covered ICD-10 on the order. Codes VRI has accepted: G31.84, R41.3, G30.0, G30.1, G30.9 — the prescriber selects the clinically correct one (ops never adds or changes codes; route to the provider per External Facility & Provider Calls).";
const MRI_PREMED_RULE =
  "Sedation/premed needs (anxious or cognitively impaired patients) noted on the order so the facility plans for it — premed prescriptions route to the prescriber first.";

// A retrieved set shaped like the one the D1 dry run returns: an SOP that is
// dense with rules, a survey page that states none, and a third SOP.
const INSURANCE_EXCERPT = `### Step 4. Denials

1. Get the denial reason in writing.
2. Route to the provider for a peer-to-peer review or an appeal with added documentation — denials of PET/infusion coverage are frequently overturned with better clinical narrative.
3. Keep the patient informed of status and never let a denial silently cancel a care step — the provider decides the alternative path.`;

test("imaging: lifts every rule-bearing unit and nothing else", () => {
  const rules = extractRules(full(1, IMAGING_SOP));
  assert.deepEqual(texts(rules), [
    ICD10_RULE,
    MRI_PREMED_RULE,
    "Clinically correct Medicare-covered ICD-10, chosen by prescriber",
    "Sedation needs flagged; premeds via prescriber"
  ]);
  assert.deepEqual(
    rules.map((rule) => rule.kind),
    ["item", "item", "checkbox", "checkbox"]
  );
  for (const name of ["never", "role-decides", "route-to-role"]) {
    assert.ok(rules[0]?.hits.includes(name), `expected hit ${name}`);
  }
});

test("imaging: facts that sit next to the rules stay out", () => {
  const extracted = texts(extractRules(full(1, IMAGING_SOP)));
  for (const fact of [
    "does not transmit with the fax",
    'facilities reject "PET brain"',
    "re-issue rather than"
  ]) {
    assert.ok(
      !extracted.some((text) => text.includes(fact)),
      `expected no rule containing ${fact}`
    );
  }
});

test("external: lifts the verification, code and routing rules", () => {
  const extracted = texts(extractRules(full(2, EXTERNAL_SOP)));
  assert.ok(
    extracted.some((text) =>
      text.includes("never release records based on caller ID alone")
    )
  );
  assert.ok(
    extracted.includes(
      "Ops staff never change clinical or billing codes on their own."
    )
  );
  assert.ok(
    extracted.some((text) =>
      text.startsWith(
        "Route to the provider for clinical codes, or the billing owner"
      )
    )
  );
  assert.ok(
    extracted.includes(
      "Code issues routed to provider/billing — never changed by ops"
    )
  );
});

test("external: routing to a named process is as much a rule as routing to a role", () => {
  const extracted = texts(extractRules(full(2, EXTERNAL_SOP)));
  assert.ok(
    extracted.some((text) =>
      text.includes("route through the Patient Records Requests SOP")
    )
  );
  assert.ok(extracted.includes("Non-treatment requests routed to ROI process"));
});

test("external: a permission written as a negative is not a rule", () => {
  const extracted = texts(extractRules(full(2, EXTERNAL_SOP)));
  assert.ok(
    !extracted.some((text) => text.includes("do not need a signed ROI"))
  );
});

test("results: lifts the release boundary and the routing rules", () => {
  const extracted = texts(extractRules(full(3, RESULTS_SOP)));
  for (const fragment of [
    "Never: interpretation of an unreviewed result",
    "the clinician makes that call — ops schedules it.",
    'don\'t just tell the patient "not back yet."',
    "don't close them out on their behalf",
    "route to the care team as a routine clinical message"
  ]) {
    assert.ok(
      extracted.some((text) => text.includes(fragment)),
      `expected a rule containing ${fragment}`
    );
  }
});

test("results: the summary of the document and a status label stay out", () => {
  const extracted = texts(extractRules(full(3, RESULTS_SOP)));
  assert.ok(!extracted.some((text) => text.startsWith("It defines")));
  assert.ok(!extracted.includes("Resulted, not yet reviewed by the provider."));
});

test("survey questions state no rules", () => {
  assert.deepEqual(extractRules(full(4, SURVEY_QUESTIONS)), []);
});

test("a task that closes on its own states no rule", () => {
  assert.deepEqual(extractRules(full(5, TASK_CLOSES_ON_ITS_OWN)), []);
});

test("a retrieved set contributes no lines from a rule-free passage", () => {
  const block = renderRulesBlock(
    selectRules([
      full(1, IMAGING_SOP),
      full(2, SURVEY_QUESTIONS),
      full(3, INSURANCE_EXCERPT)
    ])
  );
  const lines = block.split("\n").slice(1);
  assert.ok(lines.length > 0);
  assert.equal(lines.filter((line) => line.startsWith("- [2] ")).length, 0);
  assert.ok(lines.some((line) => line.startsWith("- [1] ")));
  assert.ok(lines.some((line) => line.startsWith("- [3] ")));
});

test("splitSentences holds parentheses, quotes and abbreviations together", () => {
  const sentences = splitSentences(
    'Use it (see A. B) now. Then e.g. this. "Quoted. Inside" ends.'
  );
  assert.deepEqual(sentences, [
    "Use it (see A. B) now.",
    "Then e.g. this.",
    '"Quoted. Inside" ends.'
  ]);
});

test("a sentence that opens with bold or a link still splits", () => {
  assert.equal(
    splitSentences(
      normalizeUnit("**Never** do X. [Then](https://u) do Y. Ops do not do Z.")
    ).length,
    3
  );
  // The same shape through the real pipeline, padded past RULE_MIN_CHARS.
  const paragraph =
    "**Never** file a chart note for this. [Then](https://u) tell the patient why. Ops do not close the case.";
  assert.deepEqual(
    passageUnits(paragraph, "full").map((unit) => unit.text),
    [
      "Never file a chart note for this. Then tell the patient why. Ops do not close the case."
    ]
  );
});

test("a list item under a conditional lead-in is not an unconditional rule", () => {
  const conditional = `If this happens:

- Do not complete the checkout.`;
  assert.deepEqual(texts(extractRules(full(1, conditional))), [
    "If this happens: Do not complete the checkout."
  ]);
  // Without the lead-in the same item is a rule, so the lead-in is the cause.
  assert.equal(
    extractRules(full(1, "- Do not complete the checkout.")).length,
    1
  );
});

test("a prohibition under a conditional lead-in survives it", () => {
  // The shape from the dementia communication SOP. The first item is the rule
  // whether or not a patient is wandering; the second only applies if one is.
  const wandering = `**If you notice a patient wandering:**

- Approach calmly from the front or side — never grab an arm or startle them from behind
- Gently walk alongside them back toward a seat, using distraction rather than force`;
  assert.deepEqual(texts(extractRules(full(1, wandering))), [
    "If you notice a patient wandering: Approach calmly from the front or side — never grab an arm or startle them from behind"
  ]);
});

test("the conditional-lead-in skip costs the fixtures no rule", () => {
  assert.equal(extractRules(full(1, IMAGING_SOP)).length, 4);
  assert.equal(extractRules(full(2, EXTERNAL_SOP)).length, 6);
  assert.equal(extractRules(full(3, RESULTS_SOP)).length, 6);
});

test("normalizeUnit strips the marker, the link, the emphasis and the emoji", () => {
  assert.equal(
    normalizeUnit("- [ ] **Never** file [x](https://u) to a chart 🚧 on name"),
    "Never file x to a chart on name"
  );
});

test("skips headings, tables, the draft banner and HTML block tags", () => {
  const body = `> 🚧 **DRAFT — NEEDS REVIEW.** Test fixture.

## 📋 Document Info

| Field            | Value                                            |
| ---------------- | ------------------------------------------------ |
| **Owner**        | TBD — assign at review                           |
| **Related SOPs** | 🧭 Misrouted & Missing Orders, 🛡️ Insurance      |

<details>
<summary>🎨 Design Notes & ⚠️ Pitfalls</summary>
</details>`;
  assert.deepEqual(extractRules(full(1, body)), []);
});

test("a callout that is not the draft banner is scanned as prose", () => {
  const rules = extractRules(
    full(
      1,
      "> Don't try to determine the right agency yourself; let the hotline route it."
    )
  );
  assert.equal(rules.length, 1);
  assert.equal(rules[0]?.tier, "B");
  assert.equal(rules[0]?.kind, "sentence");
  assert.equal(
    rules[0]?.text,
    "Don't try to determine the right agency yourself; let the hotline route it."
  );
});

test("chunk mode drops the fragments a chunk boundary leaves behind", () => {
  const body = `changes codes; route to the provider).
1. Ops staff never change clinical or billing codes on their own.
Ops staff never change`;
  const whole = passageUnits(body, "full").map((unit) => unit.text);
  const chunk = passageUnits(body, "chunk").map((unit) => unit.text);
  assert.ok(whole.includes("changes codes; route to the provider)."));
  assert.deepEqual(chunk, [
    "Ops staff never change clinical or billing codes on their own."
  ]);
  assert.ok(!whole.includes("Ops staff never change"));
});

test("chunk mode drops an unterminated trailing sentence", () => {
  const body = `1. Ops staff never change codes on their own.
Route the code fix to the provider and confirm`;
  assert.equal(passageUnits(body, "full").length, 2);
  assert.deepEqual(
    passageUnits(body, "chunk").map((unit) => unit.text),
    ["Ops staff never change codes on their own."]
  );
});

test("oversized rules and their exceptions are omitted whole", () => {
  const text =
    "Ops never change codes. " +
    "Context matters. ".repeat(30) +
    "Except when the provider approves.";
  assert.deepEqual(passageUnits(`1. ${text}`, "full"), []);
  assert.deepEqual(passageUnits(`1. ${"x".repeat(500)}`, "full"), []);
});

test("conditions govern every sibling and nested conditions retain their parents", () => {
  const rules = texts(
    extractRules(
      full(
        1,
        `If the provider has not reviewed the result:
- Never release the report to a patient.
- Do not close the result in the inbox.
- If the patient calls:
  - Route the request to the provider for review.
- Ops never interpret the report themselves.

Outside this situation, follow the normal process.`
      )
    )
  );
  assert.equal(rules.length, 4);
  assert.ok(
    rules.every((rule) =>
      rule.startsWith("If the provider has not reviewed the result:")
    )
  );
  assert.match(rules[2], /If the patient calls: Route/);
  assert.doesNotMatch(rules[3], /If the patient calls/);
});

test("wrapped exceptions remain attached to the prohibition", () => {
  assert.deepEqual(
    texts(
      extractRules(
        full(
          1,
          `- Do not release the report.
  Except when the provider has explicitly approved its release.`
        )
      )
    ),
    [
      "Do not release the report. Except when the provider has explicitly approved its release."
    ]
  );
});

test("malformed Markdown and fenced examples cannot become rules", () => {
  assert.equal(normalizeUnit("[".repeat(20000)).length, 20000);
  assert.deepEqual(
    extractRules(full(1, "```\nOps never change codes themselves.\n```")),
    []
  );
});

test("matchRule separates rules from facts, frequencies and questions", () => {
  assert.equal(
    matchRule("Provider-to-provider requests do not need a signed ROI").tier,
    null
  );
  assert.equal(matchRule("Do not skip the staff check-in").tier, "B");
  assert.equal(
    matchRule("Ops staff never change codes on their own.").tier,
    "A"
  );
  assert.equal(matchRule("this column is almost never used").tier, null);
  assert.equal(matchRule("the call was never placed").tier, null);
  assert.equal(matchRule("the task closes on its own").tier, null);
});

test("matchRule needs `by` before an initialled role but not a spelled-out one", () => {
  assert.equal(matchRule("The prior auth was signed PA").tier, null);
  assert.equal(matchRule("The order must be signed by the MD").tier, "A");
  assert.equal(matchRule("The ICD-10 is chosen prescriber-side").tier, "A");
});

test("matchRule reads `you cannot` as an instruction, not a boundary", () => {
  assert.equal(
    matchRule("If you cannot wait, select Add Primary Insurance").tier,
    null
  );
  assert.equal(matchRule("Ops cannot change the code").tier, "A");
});

test("matchRule catches the rules the corpus does not state yet", () => {
  assert.ok(
    matchRule(
      "The order must never leave without an auth number"
    ).hits.includes("must-not")
  );
  assert.ok(
    matchRule(
      "route through the Patient Records Requests SOP (signed ROI required)"
    ).hits.includes("route-to-process")
  );
  assert.ok(
    matchRule("Non-treatment requests routed to ROI process").hits.includes(
      "route-to-process"
    )
  );
  // Far enough from `to` that "process" is the object of a different verb.
  assert.equal(
    matchRule("Route it to the patient and begin the intake process.").tier,
    null
  );
});

test("a survey question is dropped before it is ever matched", () => {
  assert.deepEqual(
    passageUnits("- Can you dress yourself on your own?", "full"),
    []
  );
});

test("selectRules stays inside the line and character budget", () => {
  const passages = [
    full(1, IMAGING_SOP),
    full(2, EXTERNAL_SOP),
    full(3, RESULTS_SOP)
  ];
  const block = renderRulesBlock(selectRules(passages));
  const lines = block.split("\n").slice(1);
  assert.ok(block.length <= RULES_BLOCK_MAX_CHARS, `length ${block.length}`);
  assert.ok(lines.length <= RULES_MAX_LINES, `lines ${lines.length}`);
  assert.equal(block.split("\n")[0], RULES_HEADING);
});

test("selectRules takes one rule from each passage before a second", () => {
  const block = renderRulesBlock(
    selectRules([
      full(1, IMAGING_SOP),
      full(2, EXTERNAL_SOP),
      full(3, RESULTS_SOP)
    ])
  );
  const lines = block.split("\n").slice(1);
  assert.deepEqual(
    lines.slice(0, 3).map((line) => line.slice(0, 5)),
    ["- [1]", "- [2]", "- [3]"]
  );
  assert.equal(lines[0], `- [1] ${ICD10_RULE}`);
});

test("selectRules ranks tier A and full sentences ahead of checklist ticks", () => {
  const chosen = selectRules([
    full(1, IMAGING_SOP),
    full(2, EXTERNAL_SOP),
    full(3, RESULTS_SOP)
  ]);
  for (const label of [1, 2, 3]) {
    let seenTierB = false;
    let seenCheckbox = false;
    for (const rule of chosen.filter((rule) => rule.label === label)) {
      if (rule.tier === "B") seenTierB = true;
      else assert.ok(!seenTierB, `tier A after tier B in [${label}]`);
      if (rule.kind === "checkbox") seenCheckbox = true;
      else assert.ok(!seenCheckbox, `a checkbox outranked prose in [${label}]`);
    }
  }
});

test("selectRules dedupes a passage retrieved twice", () => {
  const passages = [
    full(1, IMAGING_SOP),
    full(2, EXTERNAL_SOP),
    full(3, RESULTS_SOP)
  ];
  const once = renderRulesBlock(selectRules(passages));
  const twice = renderRulesBlock(
    selectRules([...passages, full(4, IMAGING_SOP)])
  );
  assert.equal(twice, once);
});

test("selectRules honours a tighter line budget", () => {
  const chosen = selectRules(
    [full(1, IMAGING_SOP), full(2, EXTERNAL_SOP), full(3, RESULTS_SOP)],
    { maxLines: 3 }
  );
  assert.deepEqual(
    chosen.map((rule) => rule.label),
    [1, 2, 3]
  );
});

test("a rule too long for the budget does not suppress the passages after it", () => {
  // Room for one short line. Every rule [1] states, and all but the last of
  // [2], is far too long for it.
  const chosen = selectRules([full(1, RESULTS_SOP), full(2, IMAGING_SOP)], {
    maxChars: RULES_HEADING.length + 60
  });
  assert.deepEqual(texts(chosen), [
    "Sedation needs flagged; premeds via prescriber"
  ]);
  assert.equal(chosen[0]?.label, 2);
});

test("renderRulesBlock renders nothing when nothing was extracted", () => {
  assert.equal(renderRulesBlock([]), "");
  assert.equal(renderRulesBlock(selectRules([])), "");
});

test("the same passages render the same block every time", () => {
  const passages = () => [
    full(1, IMAGING_SOP),
    full(2, EXTERNAL_SOP),
    full(3, RESULTS_SOP)
  ];
  assert.equal(
    renderRulesBlock(selectRules(passages())),
    renderRulesBlock(selectRules(passages()))
  );
});

test("selectRules leaves its inputs alone", () => {
  const passages = [
    full(3, RESULTS_SOP),
    full(1, IMAGING_SOP),
    full(2, EXTERNAL_SOP)
  ];
  const before = JSON.stringify(passages);
  selectRules(passages);
  assert.equal(JSON.stringify(passages), before);
});
