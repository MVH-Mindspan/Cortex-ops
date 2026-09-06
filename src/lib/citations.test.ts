// The SOP fixtures below are copied verbatim from a read-only export of the
// Mindspan corpus taken on 3 September 2026 (/tmp/cortex-dryrun/export), so
// the matcher is exercised against the wording it will actually meet: bold
// runs, emoji, en dashes, ICD-10 codes, markdown links and table boilerplate.
// Two things are SYNTHETIC and marked as such: the shortened draft banner at
// the top of IMAGING_MD, and everything in the length fixture.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  displayLine,
  dropIdentityQuestion,
  findQuote,
  indexFile,
  markCited,
  matchKey,
  QUOTE_MAX_CHARS,
  repairCitations
} from "./citations.ts";
import type { CitationContext, CitedSource } from "./citations.ts";
import { CITATION_UNKNOWN_SOP_NOTE, CITATION_UNMATCHED_NOTE } from "./copy.ts";
import { reasonFor } from "./linkify.ts";
import type { FileMeta, SOPRef } from "./pipeline.ts";

const IMAGING_MD = `
> 🚧 **DRAFT — NEEDS REVIEW.** Test fixture. Radiology requirements below need verification with each facility.

This SOP is a pre-send checklist for imaging orders so facilities can schedule on first receipt instead of calling back. Every callback costs days of patient delay and an ops phone cycle.

## 📋 Document Info

| Field            | Value                                                                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Owner**        | TBD — assign at review                                                                                                                                 |

## Amyloid PET orders — required before sending

1. **Exact study name**: "PET CT amyloid brain scan" — facilities reject "PET brain" as insufficient.
2. **Medicare-covered ICD-10** on the order. Codes VRI has accepted: G31.84, R41.3, G30.0, G30.1, G30.9 — the prescriber selects the clinically correct one (ops never adds or changes codes; route to the provider per 🏥 External Facility & Provider Calls).
3. **Attachments**: most recent chart notes AND prior brain imaging reports (MRI). The provider's internal note does not transmit with the fax — attach explicitly (+ Attachments → Encounters and Procedures).

## ✅ Quick-Reference Checklist

- [ ] Exact study name (amyloid: "PET CT amyloid brain scan")
`;

const RESULTS_MD = `
## 📋 Document Info

| Field            | Value                                                                                                                             |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **Owner**        | TBD — assign at review                                                                                                            |

## Process Steps

### Step 2. What ops may share

- **Status and logistics, always**: "Your labs were drawn on the 12th; results usually take about a week"; "The MRI report is in and Dr. [Name] will review it before your visit on the 20th."
- **Reviewed-and-released results**: point the patient to the portal copy or send it per the records process — in the Perry app, Portal → **Distribute Results to Member Portal** or Send Message with attachment (see [Care Navigation Tools](https://app.notion.com/p/390b5943d52d81c59f97c4dbbce9bcba)); for sensitive results, offer a clinician call rather than reading anything aloud.
- **Never**: interpretation of an unreviewed result, reading values or impressions from a report the provider hasn't released, or reassurance/concern about what a result means.

### Step 3. Resulted but not reviewed

1. Tell the patient the result has arrived and the provider will review it; give a specific expectation (e.g., "you'll hear from us by [day]").
2. Flag the provider in Athena that the patient is asking — patient-initiated requests should pull review forward, especially if the next visit is far out. Results sit in the provider's own inbox for review; don't close them out on their behalf (see [📋 Managing the Clinical Inbox](https://app.notion.com/p/3acb5943d52d81e3b911d16e0c32aad9)).
3. If the provider's review surfaces something needing discussion, the clinician makes that call — ops schedules it.
`;

const INSURANCE_MD = `
## Process Steps

### Step 2. Identify PA-required services early

1. When a provider orders imaging (amyloid PET, MRI), neuropsych testing, or an infusion pathway, check the payer's PA requirement **the same day the order is placed** — PA turnaround is often 5–15 business days and gates scheduling.
2. The payer-by-service PA matrix lives in [Prior Authorizations](https://app.notion.com/p/3cab5943d52d81fa8c12f095d7b8710d) (work in progress; includes the current CareMore portal-access blocker). Full step-by-step protocols already exist for the two highest-volume imaging services — [MNS-WF-PA-PET-001 (amyloid PET)](https://app.notion.com/p/3beb5943d52d817584f8f547ad49b75d) and [MNS-WF-PA-MRI-001 (brain MRI)](https://app.notion.com/p/38eb5943d52d81aa8e9ff35ecf860ce6) — follow those for imaging PAs rather than this general workflow.

## ✅ Quick-Reference Checklist

- [ ] Coverage re-verified in the pre-visit window; lapses raised with the patient pre-visit
- [ ] PA requirement checked same day a gated service is ordered
`;

const EXTERNAL_MD = `
## Process Steps

### Step 2. Records requests (treatment purposes)

1. Provider-to-provider requests for treatment generally do not need a signed ROI — but confirm scope (which documents, which date range).
2. Send to a **verified fax number or Direct address only**; add a chart note: "Records sent to <facility/provider> at <verified fax # / Direct address> on <date>: <document list + date range>. Purpose: treatment. Requester verified via <callback to listed number / known contact>." Frequent-receiver fax numbers and provider NPIs are maintained in [📋 Managing the Clinical Inbox](https://app.notion.com/p/3acb5943d52d81e3b911d16e0c32aad9) — check there before hunting for a number, and note that outbound care summaries to PCPs already run on a next-day Tue/Wed/Fri Athena-fax cadence.
3. Anything beyond treatment purposes (attorney, insurer, employer) → route through the Patient Records Requests SOP (signed ROI required).

### Step 4. Diagnosis / CPT code problems

1. Ops staff never change clinical or billing codes on their own.
2. Capture exactly what the facility says is wrong (claim/order number, code in question, what they say it should be).
3. Route to the provider for clinical codes, or the billing owner for CPT/claim issues, with the facility's callback details and a due date.
4. Confirm back to the facility once corrected and re-sent.
`;

// SYNTHETIC: built here so the lengths are guaranteed, not eyeballed.
const RUN_SENTENCES = [
  "SYNTHETIC first sentence, short.",
  "The second sentence carries the words a model would quote and is the one that should come back on its own, without the padding around it.",
  "The third sentence pads the line past the cap so the whole line is never rendered, adding words that no reader needs, and then adding several more so the total is comfortably over the four hundred and twenty character limit that the renderer enforces on every quote it prints."
];
const RUN_LINE = RUN_SENTENCES.join(" ");
const LONG_SENTENCE = `SYNTHETIC single sentence with no full stop until the very end, ${Array.from(
  { length: 8 },
  (_, i) =>
    `clause ${i + 1} carries a few more words to push this line past the cap`
).join(", ")}, and that is all it does.`;
const SYNTHETIC_MD = `
## Synthetic length cases

${RUN_LINE}

${LONG_SENTENCE}

### **Step 9. The “special” case:**

A line under a heading that needs bold, curly quotes and the trailing colon cleaned off.
`;

const IMAGING = "imaging-order-requirements.md";
const RESULTS = "results-next-steps-requests.md";
const INSURANCE = "insurance-verification-prior-authorization.md";
const EXTERNAL = "external-facility-provider-calls.md";
const SYNTHETIC = "synthetic-length-fixture.md";

const IMAGING_URL =
  "https://app.notion.com/p/Imaging-Order-Requirements-Amyloid-PET-MRI-Checklist-DRAFT-Needs-Review-3cdb5943d52d81a19494e5a6545f2a20";
const RESULTS_URL =
  "https://app.notion.com/p/Results-Next-Steps-Requests-DRAFT-Needs-Review-3cdb5943d52d8189bde6c232816f049f";
const INSURANCE_URL =
  "https://app.notion.com/p/Insurance-Verification-Prior-Authorization-DRAFT-Needs-Review-3cdb5943d52d81d48ecbe16b2000c326";
const EXTERNAL_URL =
  "https://app.notion.com/p/External-Facility-Provider-Calls-Records-Re-Faxes-Code-Fixes-DRAFT-Needs-Review-3cdb5943d52d8142892be80df91d00c3";

const IMAGING_TITLE =
  "🧠 Imaging Order Requirements — Amyloid PET & MRI Checklist (DRAFT — Needs Review)";
const RESULTS_TITLE = "📊 Results & Next-Steps Requests (DRAFT — Needs Review)";
const INSURANCE_TITLE =
  "🛡️ Insurance Verification & Prior Authorization (DRAFT — Needs Review)";
const EXTERNAL_TITLE =
  "🏥 External Facility & Provider Calls — Records, Re-Faxes, Code Fixes (DRAFT — Needs Review)";

const file = (
  title: string,
  source_url: string | null,
  text: string
): FileMeta => ({
  title,
  category: "SOP",
  last_edited: "2026-08-31T23:18:00.000Z",
  source_url,
  status: null,
  use_when: null,
  text
});

const sop = (
  key: string,
  title: string,
  source_url: string | null,
  score: number
): SOPRef => ({
  title,
  category: "SOP",
  last_edited: "2026-08-31T23:18:00.000Z",
  source_url,
  score,
  file: key
});

type Extra = { key: string; title: string; url: string | null; text?: string };

// The pipeline hands the repair the labels it stamped on the passages, the
// ranked cards and the file bodies those passages were cut from.
function context(extra: Extra[] = []): CitationContext {
  const meta = new Map<string, FileMeta>([
    [IMAGING, file(IMAGING_TITLE, IMAGING_URL, IMAGING_MD)],
    [RESULTS, file(RESULTS_TITLE, RESULTS_URL, RESULTS_MD)],
    [INSURANCE, file(INSURANCE_TITLE, INSURANCE_URL, INSURANCE_MD)],
    [EXTERNAL, file(EXTERNAL_TITLE, EXTERNAL_URL, EXTERNAL_MD)],
    [SYNTHETIC, file("Synthetic Length Fixture", null, SYNTHETIC_MD)]
  ]);
  const sops = [
    sop(IMAGING, IMAGING_TITLE, IMAGING_URL, 0.91),
    sop(RESULTS, RESULTS_TITLE, RESULTS_URL, 0.84),
    sop(INSURANCE, INSURANCE_TITLE, INSURANCE_URL, 0.77),
    sop(EXTERNAL, EXTERNAL_TITLE, EXTERNAL_URL, 0.71),
    sop(SYNTHETIC, "Synthetic Length Fixture", null, 0.4)
  ];
  const labels = [
    { label: 1, file: IMAGING },
    { label: 2, file: RESULTS },
    { label: 3, file: INSURANCE },
    { label: 4, file: EXTERNAL },
    { label: 5, file: SYNTHETIC }
  ];
  let score = 0.39;
  for (const one of extra) {
    score -= 0.01;
    meta.set(one.key, file(one.title, one.url, one.text ?? "Body.\n"));
    sops.push(sop(one.key, one.title, one.url, score));
    labels.push({ label: labels.length + 1, file: one.key });
  }
  return { labels, sops, meta };
}

const linesOf = (out: string) => out.split("\n").filter((l) => l.trim());

test("T1 a corrupted quote is replaced by the whole source line", () => {
  const out = repairCitations(
    '2. Imaging Order Requirements, 2. "Codes VRI has accepted: G31.84, R41.3, G30, G30.1, G30.9 — the prescriber selects the clinically correct one"',
    context()
  );
  assert.equal(out.stats.matched, 1);
  const [item, quote] = linesOf(out.text);
  assert.equal(
    item,
    `1. [Imaging Order Requirements — Amyloid PET & MRI Checklist (DRAFT — Needs Review)](${IMAGING_URL}), Amyloid PET orders — required before sending`
  );
  assert.match(quote, /G30\.0/);
  assert.match(quote, /\(ops never adds/);
  assert.ok(
    quote.trim().endsWith('External Facility & Provider Calls)."'),
    quote
  );
  assert.doesNotMatch(quote, /\p{Extended_Pictographic}/u);
  assert.equal(out.cited[0].file, IMAGING);
  assert.equal(out.cited[0].verified, true);
});

test("T2 a quote whose inner quotation marks were downgraded still matches, and renders them as single quotes", () => {
  const out = repairCitations(
    `1. Imaging Order Requirements, 1. "Exact study name: 'PET CT amyloid brain scan' — facilities reject 'PET brain' as insufficient."`,
    context()
  );
  assert.equal(out.stats.matched, 1);
  assert.equal(
    linesOf(out.text)[1],
    `   "Exact study name: 'PET CT amyloid brain scan' — facilities reject 'PET brain' as insufficient."`
  );
});

test("T3 a drifted section label is replaced by the nearest heading, and the quote is expanded to the whole line", () => {
  const tail = [
    '1. [2] Results & Next-Steps Requests, Step3. "Tell the patient the result has arrived and the provider will review it"',
    `2. [2] Results & Next-Steps Requests, Step 2. "Never: interpretation of an unreviewed result, reading values or impressions from a report the provider hasn't released"`
  ].join("\n");
  const out = repairCitations(tail, context());
  const lines = linesOf(out.text);
  assert.equal(out.stats.matched, 2);
  assert.match(lines[0], /, Step 3\. Resulted but not reviewed$/);
  assert.match(lines[1], /\(e\.g\., 'you'll hear from us by \[day\]'\)/);
  assert.match(lines[2], /, Step 2\. What ops may share$/);
  assert.equal(
    lines[3],
    `   "Never: interpretation of an unreviewed result, reading values or impressions from a report the provider hasn't released, or reassurance/concern about what a result means."`
  );
});

test("T4 a partial quote expands to its item, and a checklist quote loses its checkbox", () => {
  const tail = [
    `1. [3] Insurance Verification & Prior Authorization, Step 2. "check the payer's PA requirement the same day the order is placed — PA turnaround is often 5–15 business days and gates scheduling."`,
    '2. [3] Insurance Verification & PA, Checklist. "PA requirement checked same day a gated service is ordered"'
  ].join("\n");
  const lines = linesOf(repairCitations(tail, context()).text);
  assert.match(lines[0], /, Step 2\. Identify PA-required services early$/);
  assert.match(
    lines[1],
    /^ {3}"When a provider orders imaging \(amyloid PET, MRI\)/
  );
  assert.match(lines[1], /gates scheduling\."$/);
  assert.match(lines[2], /, Quick-Reference Checklist$/);
  assert.equal(
    lines[3],
    '   "PA requirement checked same day a gated service is ordered"'
  );
});

test("T5 the section comes from the quoted line, not the section the model typed", () => {
  const out = repairCitations(
    '1. [4] External Facility & Provider Calls, 2. Records requests (treatment purposes). "Ops staff never change clinical or billing codes on their own."',
    context()
  );
  const lines = linesOf(out.text);
  assert.match(lines[0], /, Step 4\. Diagnosis \/ CPT code problems$/);
  assert.equal(
    lines[1],
    '   "Ops staff never change clinical or billing codes on their own."'
  );
  assert.equal(out.cited[0].section, "Step 4. Diagnosis / CPT code problems");
});

test("T6 a title resolves through abbreviation, decoration and near-misses", () => {
  const extra: Extra[] = [
    {
      key: "check-in.md",
      title: "📋 Patient Check-In, Athena",
      url: "https://n/in"
    },
    { key: "check-out.md", title: "Patient Check-Out", url: "https://n/out" },
    {
      key: "prior-auths.md",
      title: "Prior Authorizations",
      url: "https://n/pa"
    },
    {
      key: "escalation-a.md",
      title: "Clinical Escalation Process",
      url: "https://n/e1"
    },
    {
      key: "escalation-b.md",
      title: "Clinical Escalation Coverage",
      url: "https://n/e2"
    }
  ];
  // An unmatchable quote leaves the resolved title on show.
  const resolved = (head: string, label = "") => {
    const out = repairCitations(
      `1. ${label}${head} "zzz qqq wwww vvvv uuuu tttt ssss rrrr qqqq pppp"`,
      context(extra)
    );
    return linesOf(out.text)[0];
  };
  assert.match(
    resolved("Insurance Verification & PA,"),
    /Insurance Verification/
  );
  assert.match(
    resolved("Insurance Verification & Prior Authorization (DRAFT),"),
    /Insurance Verification/
  );
  assert.match(
    resolved("Imaging Order Requirements,"),
    /Imaging Order Requirements/
  );
  assert.match(resolved("Patient Check-In,"), /https:\/\/n\/in/);
  assert.match(resolved("Patient Check-Out,"), /https:\/\/n\/out/);
  assert.match(resolved("Prior Authorization,"), /https:\/\/n\/pa/);
  // Tie on the matched prefix: the label wins, else the higher-ranked SOP.
  assert.match(resolved("Clinical Escalation,"), /https:\/\/n\/e1/);
  assert.match(resolved("Clinical Escalation,", "[10] "), /https:\/\/n\/e2/);
});

test("T7 evidence beats the label, and a label survives a garbled title", () => {
  const quoteInExternal =
    '"Ops staff never change clinical or billing codes on their own."';
  const wrongLabel = repairCitations(
    `1. [1] Imaging Order Requirements ${quoteInExternal}`,
    context()
  );
  assert.equal(wrongLabel.cited[0].file, EXTERNAL);

  const garbledTitle = repairCitations(
    '1. [1] Imgaing Ordr Reqs "Codes VRI has accepted: G31.84, R41.3, G30.0, G30.1, G30.9"',
    context()
  );
  assert.equal(garbledTitle.cited[0].file, IMAGING);

  const noLabel = repairCitations(
    '1. Some SOP "Confirm back to the facility once corrected and re-sent."',
    context()
  );
  assert.equal(noLabel.cited[0].file, EXTERNAL);
});

test("T8 a paraphrase is never shown in quotation marks", () => {
  const said =
    "The ICD-10 code for an amyloid PET order is chosen by the prescriber from the list of Medicare-covered codes";
  const out = repairCitations(
    `1. [1] Imaging Order Requirements — Amyloid PET & MRI Checklist, 2. "${said}"`,
    context()
  );
  const lines = linesOf(out.text);
  assert.equal(out.stats.unmatched, 1);
  assert.equal(out.stats.matched, 0);
  assert.equal(
    lines[0],
    `1. [Imaging Order Requirements — Amyloid PET & MRI Checklist (DRAFT — Needs Review)](${IMAGING_URL})`
  );
  assert.equal(lines[1], `   ${CITATION_UNMATCHED_NOTE} ${said}`);
  assert.doesNotMatch(lines[1], /"/);
  assert.deepEqual(out.cited, [
    { file: IMAGING, section: null, quote: null, verified: false }
  ]);
});

test("T9 an SOP that was never retrieved is named plainly and kept out of the cards", () => {
  const out = repairCitations(
    '1. Athena Reminder Settings (https://app.notion.com/p/invented-page) "Reminders send at 9am."',
    context()
  );
  const lines = linesOf(out.text);
  assert.equal(out.stats.unknown, 1);
  assert.equal(lines[0], "1. Athena Reminder Settings");
  assert.equal(lines[1], `   ${CITATION_UNKNOWN_SOP_NOTE}`);
  assert.doesNotMatch(out.text, /https?:/);
  assert.deepEqual(out.cited, []);
});

test("T10 no URL the model typed survives, and an SOP without a link renders bare", () => {
  const typed = repairCitations(
    `1. [1] Imaging Order Requirements (https://app.notion.com/p/WRONG-404) "Exact study name: 'PET CT amyloid brain scan'"`,
    context()
  );
  assert.doesNotMatch(typed.text, /WRONG-404/);
  assert.match(typed.text, /\(https:\/\/app\.notion\.com\/p\/Imaging-Order/);

  const unlinked = repairCitations(
    `1. [5] Synthetic Length Fixture "${RUN_SENTENCES[1].slice(0, 60)}"`,
    context()
  );
  assert.match(linesOf(unlinked.text)[0], /^1\. Synthetic Length Fixture,/);
  assert.doesNotMatch(linesOf(unlinked.text)[0], /[[\]()]/);
});

test("T11 every quote in an item gets its own line, and an item with no quotes still resolves", () => {
  const two = repairCitations(
    '1. [1] Imaging Order Requirements "Exact study name: \'PET CT amyloid brain scan\'" and "Attachments: most recent chart notes AND prior brain imaging reports (MRI)" and "PET CT amyloid brain scan — facilities reject"',
    context()
  );
  const lines = linesOf(two.text);
  assert.equal(lines.length, 3, two.text);
  assert.match(lines[1], /^ {3}"Exact study name/);
  assert.match(lines[2], /^ {3}"Attachments: most recent chart notes/);

  const noQuotes = repairCitations(
    "1. Imaging Order Requirements — Amyloid PET & MRI Checklist, 2. Medicare-covered ICD-10 on the order. Codes VRI has accepted: G31.84, R41.3, G30.0, G30.1, G30.9 — the prescriber selects the clinically correct one.",
    context()
  );
  assert.equal(noQuotes.stats.matched, 1);
  assert.match(linesOf(noQuotes.text)[1], /\(ops never adds or changes codes/);

  // Both fragments appear on two lines of the file ("Exact study name" and
  // "PET CT amyloid brain scan" are also in the checklist), so neither is
  // evidence alone; the whole item read as one quote is.
  const fragments = repairCitations(
    '1. Imaging Order Requirements, 1. "Exact study name" — "PET CT amyloid brain scan".',
    context()
  );
  assert.equal(fragments.stats.matched, 1);
  assert.equal(
    linesOf(fragments.text)[1],
    `   "Exact study name: 'PET CT amyloid brain scan' — facilities reject 'PET brain' as insufficient."`
  );
});

test("T12 a short quote is only evidence when exactly one line could be meant", () => {
  const labelled = repairCitations(
    '1. [2] Results & Next-Steps Requests "TBD — assign at review"',
    context()
  );
  assert.equal(labelled.stats.matched, 1);
  assert.equal(labelled.cited[0].file, RESULTS);

  const shared = repairCitations(
    '1. Results & Next-Steps Requests "TBD — assign at review"',
    context()
  );
  assert.equal(shared.stats.unmatched, 1);
  assert.equal(shared.cited[0].verified, false);

  const borrowed = repairCitations(
    '1. [2] Results & Next-Steps Requests "If intake is still incomplete 14 days before the visit, the system sends an automatic email reminder."',
    context()
  );
  assert.equal(borrowed.stats.unmatched, 1);
  assert.equal(borrowed.cited[0].file, RESULTS);
});

test("T13 a long line gives up only the sentences the quote covers, and a long sentence is cut", () => {
  assert.ok(RUN_LINE.length > QUOTE_MAX_CHARS);
  assert.ok(LONG_SENTENCE.length > QUOTE_MAX_CHARS);

  const run = repairCitations(
    `1. [5] Synthetic Length Fixture "${RUN_SENTENCES[1].slice(0, 90)}"`,
    context()
  );
  assert.equal(linesOf(run.text)[1], `   "${RUN_SENTENCES[1]}"`);

  const long = repairCitations(
    `1. [5] Synthetic Length Fixture "${LONG_SENTENCE.slice(0, 120)}"`,
    context()
  );
  const cut = linesOf(long.text)[1].trim();
  assert.ok(cut.length <= QUOTE_MAX_CHARS + 2, String(cut.length));
  assert.ok(cut.endsWith('…"'), cut);

  const banner = repairCitations(
    '1. [1] Imaging Order Requirements "Radiology requirements below need verification with each facility."',
    context()
  );
  assert.equal(
    linesOf(banner.text)[1],
    '   "Radiology requirements below need verification with each facility."'
  );
});

test("T14 the section is the nearest heading above the line, cleaned, or nothing at all", () => {
  const noHeading = repairCitations(
    '1. [1] Imaging Order Requirements "This SOP is a pre-send checklist for imaging orders so facilities can schedule on first receipt"',
    context()
  );
  assert.equal(linesOf(noHeading.text)[0].includes(","), false);
  assert.equal(noHeading.cited[0].section, null);

  const decorated = repairCitations(
    '1. [5] Synthetic Length Fixture "A line under a heading that needs bold, curly quotes and the trailing colon cleaned off."',
    context()
  );
  assert.equal(decorated.cited[0].section, 'Step 9. The "special" case');
});

test("T15 the block is renumbered under the heading the model wrote, with the gaps section untouched", () => {
  const items =
    "1. [1] Imaging Order Requirements, 1. \"Exact study name: 'PET CT amyloid brain scan'\"";
  const quote = `   "Exact study name: 'PET CT amyloid brain scan' — facilities reject 'PET brain' as insufficient."`;
  const item = `1. [Imaging Order Requirements — Amyloid PET & MRI Checklist (DRAFT — Needs Review)](${IMAGING_URL}), Amyloid PET orders — required before sending`;
  const gaps =
    "Not covered by the SOPs\nNothing about sedation for this patient.";

  // The three tail openings the streaming trigger can produce.
  for (const lead of ["\n", " ", ""]) {
    const out = repairCitations(`${lead}${items}\n\n${gaps}`, context());
    assert.equal(out.text, `\n${item}\n${quote}\n\n${gaps}`);
  }

  // A tail that still carries its own heading line re-emits it verbatim.
  for (const heading of [
    "What the SOPs say",
    "**What the SOPs say**",
    "### What the SOPs say"
  ]) {
    const out = repairCitations(`${heading}\n${items}\n\n${gaps}`, context());
    assert.equal(out.text, `${heading}\n\n${item}\n${quote}\n\n${gaps}`);
  }

  // The question format puts the first item on the heading line itself.
  const inline = repairCitations(`**What the SOPs say:** ${items}`, context());
  assert.equal(inline.text, `**What the SOPs say:**\n\n${item}\n${quote}`);
  assert.equal(inline.stats.items, 1);
});

test("T15b a flattened tail is split only at sequential item numbers", () => {
  const d1 =
    '1. Imaging Order Requirements — Amyloid PET & MRI Checklist, 1. Exact study name: "PET CT amyloid brain scan" — facilities reject "PET brain" as insufficient. 2. Imaging Order Requirements — Amyloid PET & MRI Checklist, 2. Medicare-covered ICD-10 on the order. Codes VRI has accepted: G31.84, R41.3, G30.0, G30.1, G30.9 — the prescriber selects the clinically correct one.';
  const two = repairCitations(d1, context());
  assert.equal(two.stats.items, 2);
  assert.equal(two.stats.matched, 2);

  const r1 =
    '1. Imaging Order Requirements — Amyloid PET & MRI Checklist, 2. Medicare-covered ICD-10 on the order. "Codes VRI has accepted: G31.84, R41.3, G30.0, G30.1, G30.9 — the prescriber selects the clinically correct one."';
  const one = repairCitations(r1, context());
  assert.equal(one.stats.items, 1);
  assert.equal(one.stats.matched, 1);

  const trailing =
    "**What the SOPs say:** 1. Imaging Order Requirements, 1. \"Exact study name: 'PET CT amyloid brain scan'\" **Not covered by the SOPs:** Nothing. **One question:** Is the scan a gated service?";
  const kept = repairCitations(trailing, context());
  assert.equal(kept.stats.items, 1);
  assert.ok(
    kept.text.endsWith(
      "**Not covered by the SOPs:** Nothing. **One question:** Is the scan a gated service?"
    ),
    kept.text
  );
});

test("T16 the one question is dropped only when it asks for an identifier", () => {
  const drop = [
    "One question\nWhat is the patient's name or identifier, so we can look up their record in Athena?",
    "**One question:** What is the patient's name and date of visit for the imaging result, so you can look it up in Athena?",
    "Nothing here. One question: What is the patient's full name?"
  ];
  for (const text of drop) {
    const out = dropIdentityQuestion(`Answer text.\n\n${text}`);
    assert.equal(out.dropped, true, text);
    assert.doesNotMatch(out.text, /One question/i, text);
  }
  const keep = [
    "Is the facility's phone number on file correct?",
    "Did the referral arrive by fax or email?",
    "Is her name listed on the signed ROI?",
    "What is the patient's MRI date, so the case can be assigned to the right coordinator?",
    "Is the scan a gated service that requires prior authorization?"
  ];
  for (const question of keep) {
    const text = `Answer text.\n\nOne question\n${question}`;
    assert.deepEqual(dropIdentityQuestion(text), { text, dropped: false });
  }
  assert.equal(
    dropIdentityQuestion("No question section here.").dropped,
    false
  );
});

test("T17 markCited marks the cited cards and carries their first verified quote", () => {
  const ctx = context();
  const cited: CitedSource[] = [
    { file: RESULTS, section: null, quote: null, verified: false },
    {
      file: IMAGING,
      section: "Amyloid PET orders",
      quote: "First.",
      verified: true
    },
    {
      file: IMAGING,
      section: "Amyloid PET orders",
      quote: "Second.",
      verified: true
    }
  ];
  const marked = markCited(ctx.sops, cited);
  assert.deepEqual(
    marked.map((one) => [one.file, one.cited, one.quote]),
    [
      [IMAGING, true, "First."],
      [RESULTS, true, null],
      [INSURANCE, false, null],
      [EXTERNAL, false, null],
      [SYNTHETIC, false, null]
    ]
  );
  assert.deepEqual(
    marked.map((one) => one.score),
    ctx.sops.map((one) => one.score)
  );
});

test("T18 a rendered quote is short enough for the card one-liner unless it was capped", () => {
  const short = repairCitations(
    `1. [1] Imaging Order Requirements "Exact study name: 'PET CT amyloid brain scan'"`,
    context()
  );
  const answer = `What the SOPs say\n${short.text}`;
  const reason = reasonFor(
    answer,
    sop(IMAGING, IMAGING_TITLE, IMAGING_URL, 0.9)
  );
  assert.ok(reason && reason.length <= 220, String(reason));
  assert.match(reason as string, /Exact study name/);

  const capped = repairCitations(
    `1. [5] Synthetic Length Fixture "${LONG_SENTENCE.slice(0, 120)}"`,
    context()
  );
  // reasonFor is now only the fallback for turns stored before SOPRef.quote
  // existed; its cap (450) exceeds QUOTE_MAX_CHARS, so a capped quote still
  // comes back, ellipsis and all.
  const cappedReason = reasonFor(
    `What the SOPs say\n${capped.text}`,
    sop(SYNTHETIC, "Synthetic Length Fixture", null, 0.4)
  );
  assert.ok(
    cappedReason && cappedReason.length <= QUOTE_MAX_CHARS,
    String(cappedReason)
  );
  assert.ok((cappedReason as string).endsWith("…"));
});

test("T19 the repair is deterministic and touches nothing it was given", () => {
  const ctx = context();
  const before = JSON.stringify({
    labels: ctx.labels,
    sops: ctx.sops,
    meta: [...ctx.meta]
  });
  const tail =
    '1. [1] Imaging Order Requirements, 2. "Codes VRI has accepted: G31.84, R41.3, G30, G30.1, G30.9"\n2. [4] External Facility "Ops staff never change clinical or billing codes on their own."';
  const first = repairCitations(tail, ctx);
  const second = repairCitations(tail, ctx);
  assert.equal(first.text, second.text);
  assert.deepEqual(first.cited, second.cited);
  assert.equal(
    JSON.stringify({ labels: ctx.labels, sops: ctx.sops, meta: [...ctx.meta] }),
    before
  );
});

test("T20 a tail with no items is handed back as it came", () => {
  const ctx = context();
  const prose = "\nThe SOPs do not say anything about this.\n";
  assert.equal(repairCitations(prose, ctx).text, prose);
  assert.equal(repairCitations("", ctx).text, "");
  assert.deepEqual(repairCitations("", ctx).stats, {
    items: 0,
    matched: 0,
    unmatched: 0,
    unknown: 0
  });

  // The one-question pass still runs over a tail that was left alone.
  const asked = repairCitations(
    "\nNothing quotable here.\n\nOne question\nWhat is the patient's date of birth?",
    ctx
  );
  assert.equal(asked.droppedQuestion, true);
  assert.doesNotMatch(asked.text, /One question/);

  // The gaps section can never be lost, even if the items parse.
  const gapsInsideAnItem = repairCitations(
    '1. [1] Imaging Order Requirements "Not covered by the SOPs is what the model typed inside a quote"',
    ctx
  );
  assert.match(gapsInsideAnItem.text, /Not covered by the SOPs/);
});

test("T21 an orphan emphasis run at the tail start does not defeat the item scan", () => {
  // What the streaming holder hands over for the bold-colon heading form: it
  // emits "**What the SOPs say:" and the tail opens on the other half of the
  // run. Left in place, that "**" hides the item number from the scan and the
  // whole tail comes back unrepaired.
  for (const run of ["**", "__"]) {
    const out = repairCitations(
      `${run} 1. [1] Imaging Order Requirements "Exact study name: 'PET CT amyloid brain scan'"`,
      context()
    );
    assert.equal(out.stats.items, 1, run);
    assert.equal(out.stats.matched, 1, run);
    assert.equal(out.cited[0].file, IMAGING, run);
    const lines = linesOf(out.text);
    assert.match(lines[0], /^1\. \[Imaging Order Requirements/, run);
    assert.equal(
      lines[1],
      `   "Exact study name: 'PET CT amyloid brain scan' — facilities reject 'PET brain' as insufficient."`,
      run
    );
  }

  // A run that opens the next section is not an orphan: it is the section the
  // repair must never eat, so the tail comes back exactly as it arrived.
  const gaps = "**Not covered by the SOPs:** Nothing about sedation.";
  assert.equal(repairCitations(gaps, context()).text, gaps);
});

test("T22 a URL the model typed survives neither an unknown SOP nor the preamble", () => {
  // Nothing resolves, so the model's own line is what renders — and it must
  // not carry the link it invented.
  const unknown = repairCitations(
    '1. "Per https://evil.example/x you should do the thing here now"',
    context()
  );
  assert.equal(unknown.stats.unknown, 1);
  assert.doesNotMatch(unknown.text, /https?:/);
  assert.doesNotMatch(unknown.text, /evil\.example/);
  assert.match(unknown.text, /you should do the thing here now/);
  assert.equal(linesOf(unknown.text)[1], `   ${CITATION_UNKNOWN_SOP_NOTE}`);

  // The text above the first item is re-emitted as it stands, so it gets the
  // same strip.
  const preamble = repairCitations(
    `See https://evil.example/y for more.\n1. [1] Imaging Order Requirements "Exact study name: 'PET CT amyloid brain scan'"`,
    context()
  );
  assert.doesNotMatch(preamble.text, /evil\.example/);
  assert.doesNotMatch(preamble.text, /See {2}for more/);
  assert.match(preamble.text, /^See for more\./);
  assert.equal(preamble.stats.matched, 1);
});

test("T23 a run of unmatched brackets is linear, not quadratic", () => {
  // The brackets sit inside an item so they actually reach the link regex:
  // a tail with no item number is handed straight back and never scanned.
  const tail = `1. Imaging Order Requirements ${"[".repeat(20_000)}`;
  const ctx = context();
  const started = performance.now();
  const out = repairCitations(tail, ctx);
  const elapsed = performance.now() - started;
  assert.equal(out.stats.items, 1);
  // Unbounded, the label class rescanned to the end of the string from every
  // one of the 20,000 brackets: seconds, not milliseconds.
  assert.ok(elapsed < 50, `${elapsed.toFixed(1)}ms`);
});

test("T24 a repair that would lose the gaps section claims nothing it did", () => {
  // The model glued its gaps line onto the end of the last item, where the
  // section split cannot see it: rebuilding the items would drop it, so the
  // raw tail comes back — and with it no citations and no counts, since none
  // of that work is on the page the reader gets.
  const tail = [
    `1. [1] Imaging Order Requirements "Exact study name: 'PET CT amyloid brain scan'"`,
    '2. [4] External Facility "Ops staff never change clinical or billing codes on their own." Not covered by the SOPs: Nothing.'
  ].join("\n");
  const out = repairCitations(tail, context());
  assert.equal(out.text, tail);
  assert.deepEqual(out.cited, []);
  assert.deepEqual(out.stats, {
    items: 0,
    matched: 0,
    unmatched: 0,
    unknown: 0
  });
});

test("normalisation strips markers, tables, links, bold and emoji without touching the words", () => {
  assert.equal(
    displayLine(
      "- [ ] PA requirement checked same day a gated service is ordered"
    ),
    "PA requirement checked same day a gated service is ordered"
  );
  assert.equal(
    displayLine("| **Owner**        | TBD — assign at review     |"),
    "Owner; TBD — assign at review"
  );
  assert.equal(displayLine("| --- | --- |"), "");
  assert.equal(
    displayLine("### Step 2. What ops may share"),
    "Step 2. What ops may share"
  );
  assert.equal(
    displayLine("2. See [Care Navigation Tools](https://n/x) 🏥 first."),
    "See Care Navigation Tools first."
  );
  assert.equal(matchKey("G30.0, G30.1"), "g30 0 g30 1");
  assert.equal(matchKey("G30"), "g30");
  assert.equal(matchKey("“Don’t” — stop"), "dont stop");
});

test("the index keeps every quotable line, its key and its heading", () => {
  const lines = indexFile(RESULTS_MD);
  for (const line of lines) {
    assert.equal(line.key, matchKey(line.raw), line.raw);
  }
  assert.equal(
    lines.some((line) => line.raw.startsWith("### ")),
    false
  );
  const hit = findQuote(
    "Ops staff never change clinical or billing codes",
    indexFile(EXTERNAL_MD)
  );
  assert.ok(hit);
  assert.equal(hit.exact, true);
  assert.equal(hit.line.section, "Step 4. Diagnosis / CPT code problems");
  assert.equal(findQuote("nothing like this appears anywhere", lines), null);
});
