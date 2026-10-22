import { test } from "node:test";
import assert from "node:assert/strict";
import {
  gradeReserve,
  gradeGapGate,
  gradeOneQuestion,
  gradeConstraint,
  stepsOf,
  gradeAnswer,
  gradeQuoteWhole
} from "./grade.ts";

// Synthetic minimal reproductions; full feedback answers stay in .context.
test("reserved-code grader catches the D1/R2/R4/B1 failure shapes", () => {
  for (const step of [
    "Add a Medicare-covered ICD-10 code to the order.",
    "Add the correct ICD-10 code to the order. The prescriber selects it.",
    "If the code is listed, add it to the order.",
    "Select the correct diagnosis code, which the prescriber chooses."
  ]) {
    assert.equal(
      gradeReserve(
        `Do now: 1. ${step}\nWhat the SOPs say: provider selects the code`
      ),
      false,
      step
    );
  }
});
test("routing and provider-authored corrections remain allowed (R5)", () => {
  const text =
    "Do now: 1. Open the order. 2. Route the order to the provider to add the diagnosis code.\nThen: 3. Once the provider adds the diagnosis code, confirm it is covered.\nWhat the SOPs say: 1. Source";
  assert.equal(gradeReserve(text), true);
  assert.equal(stepsOf(text).length, 3);
});
test("C3 gaps cannot excuse invented instructions", () => {
  assert.equal(
    gradeGapGate(
      "Do now: 1. Update the reminder settings.\nWhat the SOPs say: Nothing.\nNot covered by the SOPs: The specific steps to update reminder settings."
    ),
    false
  );
});
test("question and timeframe indicators catch the reported failure shapes", () => {
  assert.equal(
    gradeOneQuestion("One question: What is the patient's name?"),
    false
  );
  assert.equal(
    gradeOneQuestion(
      "One question: Which code corresponds to the patient's diagnosis?"
    ),
    false
  );
  assert.equal(
    gradeOneQuestion("One question: What is the current procedure?"),
    false
  );
  assert.equal(gradeOneQuestion("One question: When is the MRI?"), true);
  assert.equal(
    gradeConstraint(
      'Tell the patient: "Your scan is booked for tomorrow."\nStop and escalate: x'
    ),
    false
  );
  assert.equal(
    gradeConstraint(
      'Tell the patient: "Authorization can take 5–15 business days, so the scan may need to move."'
    ),
    true
  );
});
test("whole-quote grading rejects shortened or unverified source units", () => {
  const passages = [
    {
      file: "x",
      text: "## Rule\n1. The provider selects the code (ops never changes it)."
    }
  ];
  const good = {
    file: "x",
    quote: "The provider selects the code (ops never changes it).",
    verified: true
  };
  assert.equal(gradeQuoteWhole([good], passages), true);
  assert.equal(
    gradeQuoteWhole(
      [{ ...good, quote: "The provider selects the code" }],
      passages
    ),
    false
  );
});

test("a specific diagnosis question still delegates a reserved decision to ops", () => {
  assert.equal(
    gradeOneQuestion(
      "One question: What is the patient's specific diagnosis that requires the PET order?"
    ),
    false
  );
});

// The three 2026-09-05 smoke reports counted no-match notices as clean rows,
// because the fixed notice sentence trips no indicator and a citation-free
// answer passed the whole-quote check vacuously. Neither may read as a pass.
test("a row that generated no answer is reported as null, never as a pass", () => {
  const notice =
    "No SOP matched that. Try naming the task, the system, or the step you are stuck on.";
  const graded = gradeAnswer("B1", notice, false);
  assert.deepEqual(graded, {
    reserve: null,
    routing: null,
    gapGate: null,
    oneQuestion: null,
    timeframe: null,
    steps: 0
  });
  assert.notEqual(gradeAnswer("B1", notice).reserve, null);
});
test("an answer with no citations is unexamined, not whole-quote clean", () => {
  assert.equal(gradeQuoteWhole([], []), null);
  assert.equal(
    gradeQuoteWhole([], [{ file: "x", text: "## Rule\n1. A rule." }]),
    null
  );
});

// Both shapes below were scored as failures in the 6 Sep 2026 pass while the
// answers were correct. Pinned so the graders cannot drift back.
test("waiting for, or acting after, the role that decides is not ops deciding", () => {
  for (const step of [
    "Wait for the prescriber to select the code.",
    "Once the prescriber responds with the selected code, add it to the order.",
    "Once the provider adds the diagnosis code, confirm it is covered."
  ]) {
    assert.equal(
      gradeReserve(
        `Do now: 1. ${step}\nWhat the SOPs say: provider selects the code`
      ),
      true,
      step
    );
  }
  // The role has to come first: this is still ops choosing.
  assert.equal(
    gradeReserve(
      "Do now: 1. Select the correct diagnosis code, which the prescriber chooses.\nWhat the SOPs say: x"
    ),
    false
  );
});
test("a step about something other than a code is not a reserved-code failure", () => {
  assert.equal(
    gradeReserve(
      'Do now: 1. If the study name is incorrect, update it to "PET CT amyloid brain scan".\nWhat the SOPs say: Medicare-covered ICD-10 code'
    ),
    true
  );
  // But a step that does name a code still fails.
  assert.equal(
    gradeReserve(
      "Do now: 1. If the code is listed, add it to the order.\nWhat the SOPs say: x"
    ),
    false
  );
});
test("identity screening is scoped to the person, not any noun called a name", () => {
  for (const q of [
    "One question: What is the exact study name for the order, to ensure it matches VRI's requirements?",
    "One question: Is the facility's phone number on file correct?",
    "One question: Did the referral arrive by fax or email?"
  ]) {
    assert.equal(gradeOneQuestion(q), true, q);
  }
  for (const q of [
    "One question: What is the patient's full name?",
    "One question: What is the patient's date of birth?",
    "One question: Can you confirm the caregiver's phone number?"
  ]) {
    assert.equal(gradeOneQuestion(q), false, q);
  }
});
