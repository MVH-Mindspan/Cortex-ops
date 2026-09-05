// The citation path end to end, at the level server.ts wires it: an answer
// arriving delta by delta into TailHold (the sink `consume` pushes to), the
// held tail handed to repairCitations, and the assertion made on the bytes
// the reader is left with — emitted text plus repaired tail. A live run is
// not available here (AI Search is remote and Access-protected), so this
// stands in for the streaming smoke test. tail.ts and citations.ts have their
// own unit tests; this one only checks that the two meet correctly.

import { test } from "node:test";
import assert from "node:assert/strict";
import { repairCitations } from "./citations.ts";
import type { RepairResult } from "./citations.ts";
import { TailHold } from "./tail.ts";
import type { FileMeta, SOPRef } from "./pipeline.ts";

const IMAGING = "imaging-order-requirements.md";
const IMAGING_TITLE =
  "🧠 Imaging Order Requirements — Amyloid PET & MRI Checklist (DRAFT — Needs Review)";
const IMAGING_URL =
  "https://app.notion.com/p/Imaging-Order-Requirements-Amyloid-PET-MRI-Checklist-DRAFT-Needs-Review-3cdb5943d52d81a19494e5a6545f2a20";

// From the same read-only corpus export as the citations.ts fixtures, so the
// wording the matcher meets here is the wording it meets in production.
const IMAGING_MD = `
## Amyloid PET orders — required before sending

1. **Exact study name**: "PET CT amyloid brain scan" — facilities reject "PET brain" as insufficient.
2. **Medicare-covered ICD-10** on the order. Codes VRI has accepted: G31.84, R41.3, G30.0, G30.1, G30.9 — the prescriber selects the clinically correct one (ops never adds or changes codes; route to the provider per 🏥 External Facility & Provider Calls).
`;

const meta = new Map<string, FileMeta>([
  [
    IMAGING,
    {
      title: IMAGING_TITLE,
      category: "SOP",
      last_edited: "2026-08-31T23:18:00.000Z",
      source_url: IMAGING_URL,
      status: "draft",
      use_when: null,
      text: IMAGING_MD
    }
  ]
]);

const ranked: SOPRef[] = [
  {
    title: IMAGING_TITLE,
    category: "SOP",
    last_edited: "2026-08-31T23:18:00.000Z",
    source_url: IMAGING_URL,
    score: 0.91,
    file: IMAGING,
    status: "draft"
  }
];

const labels = [{ label: 1, file: IMAGING }];

// A realistic answer carrying the four faults the tester found: a link that
// 404s, a mangled section label, a code that lost a digit ("G30" for
// "G30.0"), and a quote stopped just before the prohibition.
const ANSWER = [
  "Situation: A facility rejected an amyloid PET order and called about it.",
  "",
  "Do now",
  '1. Open the order and check the study name. Expect to see "PET CT amyloid brain scan".',
  "",
  "Done when",
  "The order is corrected and re-sent.",
  "",
  "What the SOPs say",
  "1. [1] Imaging Order Requirements, Step2 (https://app.notion.com/p/Imaging-404)",
  '   "Medicare-covered ICD-10 on the order. Codes VRI has accepted: G31.84, R41.3, G30, G30.1, G30.9"',
  "",
  "Not covered by the SOPs",
  "- Which facility contact to call back. The SOPs do not say. Ask your team lead."
].join("\n");

const BODY = ANSWER.slice(0, ANSWER.indexOf("What the SOPs say"));
const GAPS = ANSWER.slice(ANSWER.indexOf("Not covered by the SOPs"));

// Streams `text` in fixed-size deltas the way consume() feeds the hold, then
// rebuilds the tail. Returns what the reader ends up with, in order, plus the
// repair itself — the bytes are the contract, the counts are what telemetry
// and the cards read.
function streamed(
  text: string,
  size: number
): { out: string; repaired: RepairResult } {
  const emitted: string[] = [];
  const hold = new TailHold(
    (delta) => emitted.push(delta),
    () => false
  );
  for (let i = 0; i < text.length; i += size) {
    hold.push(text.slice(i, i + size));
  }
  const tail = hold.end();
  assert.notEqual(tail, null, "no citation heading was seen");
  const repaired = repairCitations(tail as string, {
    labels,
    sops: ranked,
    meta
  });
  return { out: emitted.join("") + repaired.text, repaired };
}

test("a streamed answer keeps its body and has its citations rebuilt", () => {
  // Delta sizes from one character to the whole answer at once: the split
  // must not depend on where the provider happened to cut the stream.
  for (const size of [1, 7, 64, ANSWER.length]) {
    const at = `delta size ${size}`;
    const { out } = streamed(ANSWER, size);
    // Everything above the heading reached the reader untouched, and the
    // heading line itself went out while the items were still held.
    assert.ok(out.startsWith(BODY), at);
    assert.ok(out.includes("\nWhat the SOPs say\n"), at);
    // The rebuilt item: a markdown link from the bucket, not the model's
    // retyped URL, and the section label the file actually carries.
    assert.ok(out.includes("\n1. ["), at);
    assert.ok(out.includes(IMAGING_URL), at);
    assert.ok(!out.includes("Imaging-404"), at);
    assert.ok(!out.includes("Step2"), at);
    // The SOP's own words: the digit the model dropped and the clause it
    // stopped short of.
    assert.ok(out.includes("G30.0"), at);
    assert.ok(out.includes("ops never adds or changes codes"), at);
    // The gaps section survives byte for byte, at the end where it belongs.
    assert.ok(out.endsWith(GAPS), at);
  }
});

// The other shape the prompt produces: the question format, where the heading
// is bolded, ends in a colon and carries the first item on its own line. The
// trigger stops at that colon, so today the tail arrives as "** 1. [1] ..." —
// with the closing emphasis run orphaned at its front — and once the trigger
// consumes that run it will arrive as " 1. [1] ..." instead. Neither is the
// contract: what the reader ends up with is, so every assertion below is made
// on the emitted text and the repaired tail joined back together.
const INLINE_ANSWER = [
  "Situation: A facility rejected an amyloid PET order and called about it.",
  "",
  "Do now",
  "1. Open the order and check the study name against the SOP.",
  "",
  '**What the SOPs say:** 1. [1] Imaging Order Requirements "Codes VRI has accepted: G31.84, R41.3, G30, G30.1, G30.9 — the prescriber selects the clinically correct one" **Not covered by the SOPs:** Nothing.'
].join("\n");

const INLINE_BODY = INLINE_ANSWER.slice(0, INLINE_ANSWER.indexOf("**What"));

test("the bold-colon heading form is repaired, orphan emphasis and all", () => {
  for (const size of [1, 7, 64, INLINE_ANSWER.length]) {
    const at = `delta size ${size}`;
    const { out, repaired } = streamed(INLINE_ANSWER, size);
    // One item was found at all: the orphan "**" used to hide the item number
    // from the scan, and every recorded answer came back with zero items.
    assert.equal(repaired.stats.items, 1, at);
    assert.equal(repaired.stats.matched, 1, at);
    // The body above the heading is untouched and the heading still reaches
    // the reader, whichever half of the emphasis run the trigger kept.
    assert.ok(out.startsWith(INLINE_BODY), at);
    assert.ok(out.includes("**What the SOPs say:**\n"), at);
    // The rebuilt item: the bucket's link, the file's own section, the digit
    // the model dropped and the clause it stopped short of.
    assert.ok(out.includes(IMAGING_URL), at);
    assert.ok(out.includes("Amyloid PET orders — required before sending"), at);
    assert.ok(out.includes("G30.0"), at);
    assert.ok(out.includes("(ops never adds"), at);
    // And the gaps section, which the repair may never eat.
    assert.ok(out.includes("Not covered by the SOPs"), at);
    assert.ok(out.trimEnd().endsWith("Nothing."), at);
  }
});
