import { test } from "node:test";
import assert from "node:assert/strict";
import { DEGEN_SNIFF_CHARS, looksDegenerate } from "./degenerate.ts";

// Shape of the real fp8 collapse seen in production: function words only.
const SOUP =
  "the a of the the a of the of a the the of a of the a the of the a a of the the of a the of the a of the the a of a the of the a the of";

const INCIDENT = `Situation: A caregiver reports the patient became agitated and more confused after starting a new medication this morning, and needs the escalation path.

Urgency: Now. The patient's condition changed today and a caregiver is waiting.

Do now
1. In Athena, the scheduling system, open the patient's chart. Expect to see the medication list.`;

const QUESTION = `Answer: Clinic Missed is the status used when a patient arrives too late to be seen, per the SOP.

What the SOPs say
1. Missed Visits, 2. Statuses (https://app.notion.com/p/x)
   "Use Clinic Missed when the patient arrives after the grace period."`;

test("flags the stopword soup produced by the fp8 collapse", () => {
  assert.equal(looksDegenerate(SOUP), true);
});

test("flags a collapse that repeats one word", () => {
  assert.equal(
    looksDegenerate(
      "step step step step step step step step step step step step"
    ),
    true
  );
});

test("does not flag an incident-format answer", () => {
  assert.equal(looksDegenerate(INCIDENT), false);
});

test("does not flag a question-format answer", () => {
  assert.equal(looksDegenerate(QUESTION), false);
});

test("does not flag the sniff window of a real answer", () => {
  assert.equal(looksDegenerate(INCIDENT.slice(0, DEGEN_SNIFF_CHARS)), false);
});

test("does not flag short text: too little signal to judge", () => {
  assert.equal(looksDegenerate("Nothing."), false);
  assert.equal(looksDegenerate("the of a"), false);
  assert.equal(looksDegenerate(""), false);
});

// Answer shapes with the team steer (regression pins: name-dense prose sits
// far from both collapse thresholds, so these cannot flag).
const QUESTION_WITH_TEAM = `Who handles this: Likely the Care Support team, Patient Support (Enrollment & Member Experience) function, because the team structure puts the patient lifecycle from first referral there.

Answer: Create the Salesforce lead the same day the referral arrives, per the SOP.`;

const INCIDENT_WITH_TEAM = `Situation: A fax referral arrived this morning and needs a lead and a chart.

Urgency: Today. A referral is waiting.

Who handles this: Likely the Care Support team, Patient Support (Enrollment & Member Experience) function, because the team structure puts the patient lifecycle from first referral there.

Do now
1. Create a Salesforce lead. Expect to see the lead record.`;

test("does not flag a question answer that opens with the team steer", () => {
  assert.equal(looksDegenerate(QUESTION_WITH_TEAM), false);
});

test("does not flag the sniff window of an incident answer with the team steer", () => {
  assert.equal(
    looksDegenerate(INCIDENT_WITH_TEAM.slice(0, DEGEN_SNIFF_CHARS)),
    false
  );
});
