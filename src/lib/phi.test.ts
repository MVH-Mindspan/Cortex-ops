import { test } from "node:test";
import assert from "node:assert/strict";
import { checkPHI, checkPossiblePII, PII_SCREEN_REASON } from "./phi.ts";

// --- hard identifiers (blocking) ---

test("blocks a Social Security number", () => {
  assert.deepEqual(checkPHI("ssn 123-45-6789 on file"), {
    blocked: true,
    reason: "a Social Security number"
  });
});

test("blocks an email address", () => {
  assert.equal(
    checkPHI("reach her at jane.doe@example.com").reason,
    "an email address"
  );
});

test("blocks a date next to a DOB keyword", () => {
  assert.equal(
    checkPHI("DOB 04/12/1941, needs a refill").reason,
    "a date of birth"
  );
  assert.equal(checkPHI("born April 12, 1941").reason, "a date of birth");
});

test("blocks a day-first written date next to a DOB keyword", () => {
  assert.equal(checkPHI("DOB 12 April 1941").reason, "a date of birth");
  assert.equal(
    checkPHI("date of birth 12th of April, 1941").reason,
    "a date of birth"
  );
});

test("blocks a DOB when the keyword and the date are a clause apart", () => {
  assert.equal(
    checkPHI("DOB doesn't match what Athena has, Athena shows 04/12/1941")
      .reason,
    "a date of birth"
  );
});

test("does not treat an appointment date as a date of birth", () => {
  assert.equal(
    checkPHI("appointment moved to 04/12/2026 at 3pm").blocked,
    false
  );
});

test("blocks a phone number", () => {
  assert.equal(checkPHI("call 415-555-1234").reason, "a phone number");
  assert.equal(checkPHI("call (415) 555-1234").reason, "a phone number");
});

test("a separator-formatted phone still blocks next to the word chart", () => {
  assert.equal(checkPHI("chart, call 415-555-1234").reason, "a phone number");
});

test("allows a bare digit run next to an MRN or chart keyword", () => {
  assert.equal(checkPHI("MRN 4471902123 was on the schedule").blocked, false);
  assert.equal(checkPHI("chart 4155551234 needs a callback").blocked, false);
});

test("allows a bare digit run introduced as a patient number", () => {
  assert.equal(
    checkPHI("patient number 4155551234 needs a callback").blocked,
    false
  );
  assert.equal(checkPHI("patient # 4155551234").blocked, false);
  assert.equal(checkPHI("patient ID 4155551234").blocked, false);
  assert.equal(checkPHI("patient no. 4155551234").blocked, false);
});

test("a bare 10-digit run with no record keyword nearby still reads as a phone", () => {
  assert.equal(
    checkPHI("she left 4155551234 on the voicemail").reason,
    "a phone number"
  );
});

test("passes a de-identified message with codes, facilities and staff", () => {
  assert.equal(
    checkPHI(
      "#301 wants their TB006 results sent to the UCSF consulting neurologist"
    ).blocked,
    false
  );
  assert.equal(checkPHI("Dr. Musto faxed the order to LabCorp").blocked, false);
});

// --- soft heuristics (warn only) ---

test("warns on a possessive name, including with a curly apostrophe", () => {
  assert.equal(
    checkPossiblePII("John Smith's chart is missing"),
    "a patient name"
  );
  assert.equal(
    checkPossiblePII("John Smith’s chart is missing"),
    "a patient name"
  );
});

test("warns on 'patient's name is', including with a curly apostrophe", () => {
  assert.equal(
    checkPossiblePII("the patient's name is John"),
    "a patient name"
  );
  assert.equal(
    checkPossiblePII("the patient’s name is John"),
    "a patient name"
  );
});

test("warns on an honorific followed by a name", () => {
  assert.equal(checkPossiblePII("Mrs. Alvarez called twice"), "a patient name");
});

test("warns on a relation word followed by a capitalised full name", () => {
  assert.equal(
    checkPossiblePII("My patient, Michael Van Havill, is confused"),
    "a patient name"
  );
});

test("does not warn on a relation word followed by a facility", () => {
  assert.equal(
    checkPossiblePII("the patient in Valley Radiology is waiting"),
    null
  );
});

test("warns on a street address and a member ID with plain nouns", () => {
  assert.equal(checkPossiblePII("lives at 12 Oak Street"), "a street address");
  assert.equal(
    checkPossiblePII("member id AB123456"),
    "an insurance or member ID"
  );
});

test("does not warn on staff names or clean messages", () => {
  assert.equal(checkPossiblePII("Dr. Musto faxed the order"), null);
  assert.equal(
    checkPossiblePII("a caregiver called asking to reschedule"),
    null
  );
});

test("the block key for the model name-screen is unchanged", () => {
  assert.equal(PII_SCREEN_REASON, "a possible patient name");
});
