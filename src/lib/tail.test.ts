import { test } from "node:test";
import assert from "node:assert/strict";
import { TailHold } from "./tail.ts";

// Collects every emit so a test can assert both the joined stream (what the
// reader sees) and the individual deltas (no empty ones, ever).
function harness(aborted: () => boolean = () => false) {
  const emitted: string[] = [];
  const hold = new TailHold((text) => emitted.push(text), aborted);
  return { emitted, hold, seen: () => emitted.join("") };
}

// T21: the heading arrives one fragment at a time, the way the model streams
// it. Nothing before "What" may be delayed and nothing after the heading line
// may reach the reader.
test("holds the items when the heading is split across deltas", () => {
  const { emitted, hold, seen } = harness();
  hold.push("Done when\nThe order is sent.\n\n");
  assert.equal(seen(), "Done when\nThe order is sent.\n\n");
  for (const delta of ["What", " the", " SO", "Ps", " say"]) hold.push(delta);
  // Still nothing new: the partial line is a live prefix of the heading.
  assert.equal(seen(), "Done when\nThe order is sent.\n\n");
  hold.push("\n1. [1] Imaging...");
  assert.equal(seen(), "Done when\nThe order is sent.\n\nWhat the SOPs say\n");
  assert.equal(hold.end(), "1. [1] Imaging...");
  assert.ok(!emitted.includes(""));
});

// T22: every heading spelling the prompt can produce triggers at a line start.
test("triggers on the ### heading form", () => {
  const { hold, seen } = harness();
  hold.push("Answer: Yes.\n\n### What the SOPs say\n1. [1] A\n");
  assert.equal(seen(), "Answer: Yes.\n\n### What the SOPs say\n");
  assert.equal(hold.end(), "1. [1] A\n");
});

test("triggers on the bold heading form", () => {
  const { hold, seen } = harness();
  hold.push("Answer: Yes.\n\n**What the SOPs say**\n1. [1] A\n");
  assert.equal(seen(), "Answer: Yes.\n\n**What the SOPs say**\n");
  assert.equal(hold.end(), "1. [1] A\n");
});

// Convention pinned here: the colon form emits the heading through the ":" and
// holds the rest of the line VERBATIM, leading space included. B2's parser must
// therefore trim what it is handed rather than assume a newline starts it.
test("holds inline content after the colon form verbatim", () => {
  const { hold, seen } = harness();
  hold.push("What the SOPs say: 1. [1] X");
  assert.equal(seen(), "What the SOPs say:");
  assert.equal(hold.end(), " 1. [1] X");
});

// The colon terminates the heading even when a newline follows it, so that
// newline is the first character of the tail. Pinned because it is the one
// place the convention bites: B2 must trim what it is handed, not assume the
// tail opens on a fresh line.
test("ends the heading at the colon, leaving the newline with the tail", () => {
  const { hold, seen } = harness();
  hold.push("Answer: Yes.\n\n### What the SOPs say:\n1. [1] A\n");
  assert.equal(seen(), "Answer: Yes.\n\n### What the SOPs say:");
  assert.equal(hold.end(), "\n1. [1] A\n");
});

test("passes prose that merely names the heading straight through", () => {
  const { hold, seen } = harness();
  const prose =
    "Before you start\nWhat the SOPs say about ICD-10 is limited.\n";
  hold.push(prose);
  assert.equal(seen(), prose);
  assert.equal(hold.end(), null);
});

// T22b: a mention mid-line must not trigger even though the heading text (and
// its colon, and a numbered line after it) all appear.
test("does not trigger on a mid-line mention split across deltas", () => {
  const { emitted, hold, seen } = harness();
  hold.push("...as described under");
  assert.equal(seen(), "...as described under");
  hold.push(" What the SOPs say:\n5. Next step\n");
  assert.equal(
    seen(),
    "...as described under What the SOPs say:\n5. Next step\n"
  );
  assert.equal(hold.end(), null);
  assert.ok(!emitted.includes(""));
});

test("does not trigger on a mid-line mention in a single delta", () => {
  const { hold, seen } = harness();
  const line = "...as described under What the SOPs say.\n";
  hold.push(line);
  assert.equal(seen(), line);
  assert.equal(hold.end(), null);
});

// T23: the short-answer case, where the whole answer flushes in one delta.
test("splits a body, heading and items delivered in one push", () => {
  const { hold, seen } = harness();
  hold.push(
    "Answer: Use Clinic Missed.\n\nWhat the SOPs say\n1. [1] A\n2. [2] B\n"
  );
  assert.equal(seen(), "Answer: Use Clinic Missed.\n\nWhat the SOPs say\n");
  assert.equal(hold.end(), "1. [1] A\n2. [2] B\n");
});

test("emits a bare trailing heading at end() and reports an empty tail", () => {
  const { hold, seen } = harness();
  hold.push("Answer: Yes.\n\nWhat the SOPs say");
  assert.equal(seen(), "Answer: Yes.\n\n");
  assert.equal(hold.end(), "");
  assert.equal(seen(), "Answer: Yes.\n\nWhat the SOPs say");
});

test("reports an empty tail when the stream stops right after the heading", () => {
  const { hold } = harness();
  hold.push("Answer: Yes.\n\nWhat the SOPs say\n");
  assert.equal(hold.end(), "");
});

// T24: a stop mid-citation must hand the reader everything already buffered,
// in order, and then get out of the way.
test("releases pending and held text in order when aborted", () => {
  let aborted = false;
  const { emitted, hold, seen } = harness(() => aborted);
  hold.push("Answer: X.\n\nWhat the SOPs say\n1. [1] A\n");
  assert.equal(seen(), "Answer: X.\n\nWhat the SOPs say\n");

  aborted = true;
  hold.push("2. [2] B\n");
  assert.equal(seen(), "Answer: X.\n\nWhat the SOPs say\n1. [1] A\n2. [2] B\n");
  hold.push("3. [3] C\n");
  assert.equal(
    seen(),
    "Answer: X.\n\nWhat the SOPs say\n1. [1] A\n2. [2] B\n3. [3] C\n"
  );
  // Nothing was withheld, so there is no rebuilt tail to report.
  assert.equal(hold.end(), null);
  assert.ok(!emitted.includes(""));
});

test("release() gives back a partial heading that never confirmed", () => {
  const { hold, seen } = harness();
  hold.push("Answer: X.\n\nWhat the SO");
  assert.equal(seen(), "Answer: X.\n\n");
  hold.release();
  assert.equal(seen(), "Answer: X.\n\nWhat the SO");
  hold.push("Ps say\n1. [1] A\n");
  assert.equal(seen(), "Answer: X.\n\nWhat the SOPs say\n1. [1] A\n");
  assert.equal(hold.end(), null);
});

test("reset() starts the next attempt clean", () => {
  let aborted = true;
  const { emitted, hold } = harness(() => aborted);
  hold.push("Aborted attempt.\n");
  hold.reset();
  aborted = false;
  emitted.length = 0;

  hold.push("Answer: Fresh.\n\nWhat the SOPs say\n1. [1] A\n");
  assert.equal(emitted.join(""), "Answer: Fresh.\n\nWhat the SOPs say\n");
  assert.equal(hold.end(), "1. [1] A\n");
  assert.ok(!emitted.includes(""));
});

// Deterministic 32-bit LCG. The split points must be reproducible, so the
// property test never touches Math.random.
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function splitInto(text: string, random: () => number): string[] {
  const parts: string[] = [];
  for (let index = 0; index < text.length; ) {
    const size = 1 + Math.floor(random() * 40);
    parts.push(text.slice(index, index + size));
    index += size;
  }
  return parts;
}

const ANSWER = `Answer: Use Clinic Missed when the patient arrives after the grace period.

What the SOPs say
1. Missed Visits, 2. Statuses (https://app.notion.com/p/x)
   "Use Clinic Missed when the patient arrives after the grace period."

Not covered by the SOPs
Whether the grace period differs by clinic.

One question
Did the patient call ahead?
`;

const FIRST_ITEM = "1. Missed Visits, 2. Statuses (https://app.notion.com/p/x)";

test("is lossless and holds the items back for every split point", () => {
  const random = makeRandom(0x5eed);
  for (let run = 0; run < 20; run++) {
    const { emitted, hold, seen } = harness();
    hold.reset();
    for (const delta of splitInto(ANSWER, random)) {
      hold.push(delta);
      // The whole point: the first citation item never reaches the reader
      // while the stream is open, no matter where the deltas fall.
      assert.ok(!seen().includes(FIRST_ITEM), `run ${run} leaked the item`);
    }
    // end() flushes into the emit callback, so the invariant reads the
    // collected stream after it, not before.
    const tail = hold.end();
    assert.equal(seen() + (tail ?? ""), ANSWER, `run ${run} lost text`);
    assert.equal(tail, ANSWER.slice(ANSWER.indexOf(FIRST_ITEM)), `run ${run}`);
    assert.ok(!emitted.includes(""), `run ${run} emitted an empty delta`);
  }
});
