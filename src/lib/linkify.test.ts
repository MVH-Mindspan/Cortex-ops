import { test } from "node:test";
import assert from "node:assert/strict";
import { displayTitle, linkifySOPs, reasonFor } from "./linkify.ts";
import type { SOPRef } from "./pipeline.ts";

const sop = (
  title: string,
  source_url: string | null,
  file?: string
): SOPRef => ({
  title,
  category: "ops",
  last_edited: null,
  source_url,
  score: 0.5,
  file
});

test("displayTitle strips a leading emoji", () => {
  assert.equal(displayTitle("📋 Patient Check-In"), "Patient Check-In");
  assert.equal(displayTitle("Plain"), "Plain");
});

test("links a title mention to its Notion page", () => {
  const out = linkifySOPs("See Patient Check-In, Athena for details.", [
    sop("Patient Check-In, Athena", "https://n/check-in")
  ]);
  assert.equal(
    out,
    "See [Patient Check-In, Athena](https://n/check-in) for details."
  );
});

test("drops bold markers around a linked title", () => {
  const out = linkifySOPs("Open **Missed Visits** first.", [
    sop("Missed Visits", "https://n/mv")
  ]);
  assert.equal(out, "Open [Missed Visits](https://n/mv) first.");
});

test("links the longest matching title without nesting", () => {
  const out = linkifySOPs("Per Medication Refills, wait.", [
    sop("Refills", "https://n/r"),
    sop("Medication Refills", "https://n/mr")
  ]);
  assert.equal(out, "Per [Medication Refills](https://n/mr), wait.");
});

test("does not link inside a longer word", () => {
  const out = linkifySOPs("Referrals go to the front desk.", [
    sop("Referral", "https://n/ref")
  ]);
  assert.equal(out, "Referrals go to the front desk.");
});

test("does not link inside the URL or label of an earlier link", () => {
  const out = linkifySOPs("See Athena Basics.", [
    sop("Athena Basics", "https://n/Athena-Basics-1"),
    sop("Athena", "https://n/Athena-2")
  ]);
  assert.equal(out, "See [Athena Basics](https://n/Athena-Basics-1).");
});

test("leaves an existing markdown link alone", () => {
  const text = "See [Athena](https://elsewhere) now.";
  assert.equal(linkifySOPs(text, [sop("Athena", "https://n/a")]), text);
});

test("links a filename mention using the title as the label", () => {
  const out = linkifySOPs("(from appointment-scheduling.md)", [
    sop("Appointment Scheduling", "https://n/as", "appointment-scheduling.md")
  ]);
  assert.equal(out, "(from [Appointment Scheduling](https://n/as))");
});

test("ignores SOPs without a link and returns the text unchanged when there is nothing to link", () => {
  assert.equal(
    linkifySOPs("Nothing here.", [sop("Nothing", null)]),
    "Nothing here."
  );
  assert.equal(linkifySOPs("Nothing here.", null), "Nothing here.");
});

test("reasonFor prefers the quote from the citation section over an earlier script", () => {
  const answer = `Situation: A patient is at the desk.

Do now
1. Per Patient Check-In, Athena, select Self-Pay.

Tell the patient
"You're all set for today's visit."

What the SOPs say
1. Patient Check-In, Athena, 5. If Primary Insurance Is Not on File (https://n/ci)
   "If the appointment is imminent and you cannot wait, select Add Primary Insurance."`;
  assert.equal(
    reasonFor(answer, sop("Patient Check-In, Athena", "https://n/ci")),
    "If the appointment is imminent and you cannot wait, select Add Primary Insurance."
  );
});

test("reasonFor falls back to the first nearby quote and to null", () => {
  assert.equal(
    reasonFor(
      'Missed Visits says "Use Clinic Missed." here.',
      sop("Missed Visits", null)
    ),
    "Use Clinic Missed."
  );
  assert.equal(
    reasonFor("No mention at all.", sop("Missed Visits", null)),
    null
  );
});
