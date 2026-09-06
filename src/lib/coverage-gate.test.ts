// The gate is the fail-closed boundary: nothing the model generated may be
// delivered until a declaration is read, and a declaration that is missing,
// malformed or overlong must resolve to "unconfirmed", never to "full".
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COVERAGE_PREFIX_MAX_CHARS,
  CoverageGate,
  type CoverageDecision
} from "./coverage-gate.ts";

type Run = {
  emitted: string[];
  decisions: CoverageDecision[];
  gate: CoverageGate;
};

function gate(aborted = () => false): Run {
  const emitted: string[] = [];
  const decisions: CoverageDecision[] = [];
  const g = new CoverageGate(
    (text) => emitted.push(text),
    (decision) => decisions.push(decision),
    aborted
  );
  return { emitted, decisions, gate: g };
}

// Feed the stream in `size`-char deltas so every test also covers the case
// where a declaration straddles a chunk boundary.
function run(text: string, size = 1, aborted?: () => boolean): Run {
  const r = gate(aborted);
  for (let i = 0; i < text.length; i += size)
    r.gate.push(text.slice(i, i + size));
  r.gate.end();
  return r;
}

const blocked = {
  coverage: "none",
  coverageBlocked: "unconfirmed",
  reason: "invalid"
} as const;

test("accepts the three values in any case and forwards the body", () => {
  for (const [line, coverage] of [
    ["Coverage: full", "full"],
    ["coverage: FULL", "full"],
    ["COVERAGE: Partial", "partial"],
    ["Coverage: none", "none"]
  ] as const) {
    const r = run(`${line}\n\nSituation: x`);
    assert.equal(r.gate.decision?.coverage, coverage, line);
    assert.equal(
      r.gate.decision?.coverageBlocked,
      coverage === "none" ? "none" : undefined
    );
    assert.equal(
      r.emitted.join(""),
      coverage === "none" ? "" : "\nSituation: x",
      line
    );
  }
});

test("accepts the documented Markdown, dash and trailing-period variants", () => {
  for (const line of [
    "**Coverage: partial**",
    "__Coverage: partial__",
    "Coverage - partial",
    "Coverage – partial",
    "Coverage — partial",
    "Coverage: partial.",
    "  Coverage: partial  ",
    "**Coverage: partial.**"
  ]) {
    const r = run(`${line}\nBody`);
    assert.deepEqual(
      r.gate.decision,
      { coverage: "partial", reason: null },
      line
    );
    assert.equal(r.emitted.join(""), "Body", line);
  }
});

test("tolerates leading blank lines and a CRLF break", () => {
  const r = run("\n\n**Coverage: None.**\r\nWho handles this:");
  assert.equal(r.gate.decision?.coverage, "none");
  assert.equal(r.gate.decision?.coverageBlocked, "none");
  assert.equal(r.emitted.join(""), "");
});

test("reads the same-line form without waiting for a newline", () => {
  const r = gate();
  r.gate.push("Coverage: partial. Situation: A patient called.");
  assert.equal(r.gate.decision?.coverage, "partial");
  assert.equal(r.emitted.join(""), "Situation: A patient called.");
});

test("a missing declaration fails closed as unconfirmed", () => {
  for (const text of [
    "Situation: A patient called.\n\n1. Do the thing.",
    "Who handles this: Care Navigation\n",
    "1. Call the facility.\n"
  ]) {
    const r = run(text);
    assert.deepEqual(
      r.gate.decision,
      { coverage: "none", coverageBlocked: "unconfirmed", reason: "missing" },
      text
    );
    assert.equal(r.emitted.join(""), "", text);
  }
});

test("an unknown or run-on value fails closed as unconfirmed", () => {
  for (const line of [
    "Coverage: unknown",
    "Coverage: fuller",
    "Coverage: partially",
    "Coverage:"
  ]) {
    const r = run(`${line}\n\nSituation: x`);
    assert.deepEqual(r.gate.decision, blocked, line);
    assert.equal(r.emitted.join(""), "", line);
  }
});

test("mismatched emphasis markers fail closed", () => {
  for (const line of [
    "**Coverage: full__",
    "**Coverage: full",
    "Coverage: full__"
  ]) {
    const r = run(`${line}\n\nSituation: x`);
    assert.deepEqual(r.gate.decision, blocked, line);
    assert.equal(r.emitted.join(""), "", line);
  }
});

test("trailing prose that is not a body heading fails closed", () => {
  const r = run("Coverage: full and here is what to do\n1. Go.");
  assert.deepEqual(r.gate.decision, blocked);
  assert.equal(r.emitted.join(""), "");
});

test("an overlong opening prefix fails closed before it can be delivered", () => {
  const r = gate();
  r.gate.push("Coverage: full ".padEnd(COVERAGE_PREFIX_MAX_CHARS + 1, "x"));
  assert.deepEqual(r.gate.decision, blocked);
  assert.equal(r.emitted.join(""), "");
});

test("an empty or whitespace-only generation fails closed as missing", () => {
  for (const text of ["", "   ", "\n\n"]) {
    const r = run(text);
    assert.deepEqual(r.gate.decision, {
      coverage: "none",
      coverageBlocked: "unconfirmed",
      reason: "missing"
    });
    assert.equal(r.emitted.join(""), "");
  }
});

test("a declaration with no trailing newline is read at end of stream", () => {
  const r = run("Coverage: full");
  assert.deepEqual(r.gate.decision, { coverage: "full", reason: null });
  assert.equal(r.emitted.join(""), "");
});

test("the decision is announced once, before any body text is emitted", () => {
  const order: string[] = [];
  const g = new CoverageGate(
    (text) => order.push(`emit:${text}`),
    (d) => order.push(`decide:${d.coverage}`),
    () => false
  );
  g.push("Coverage: full\nSituation: x");
  g.end();
  assert.deepEqual(order, ["decide:full", "emit:Situation: x"]);
});

test("nothing generated after a block is ever emitted", () => {
  const r = gate();
  r.gate.push("Situation: x\n");
  r.gate.push("1. Do the thing.\n");
  r.gate.push("What the SOPs say\n");
  r.gate.end();
  assert.equal(r.gate.decision?.coverageBlocked, "unconfirmed");
  assert.equal(r.emitted.join(""), "");
  assert.equal(r.decisions.length, 1);
});

test("delta size never changes the decision or the delivered text", () => {
  const text =
    "**Coverage: partial**\n\nSituation: A patient called.\n\n1. Route it.";
  const one = run(text, 1);
  for (const size of [2, 3, 5, 8, 13, 21, text.length]) {
    const many = run(text, size);
    assert.deepEqual(many.gate.decision, one.gate.decision, `size ${size}`);
    assert.equal(many.emitted.join(""), one.emitted.join(""), `size ${size}`);
  }
  assert.equal(
    one.emitted.join(""),
    "\nSituation: A patient called.\n\n1. Route it."
  );
});

test("an aborted generation decides nothing and emits nothing", () => {
  const r = run("Coverage: full\n\nSituation: x", 1, () => true);
  assert.equal(r.gate.decision, null);
  assert.deepEqual(r.decisions, []);
  assert.equal(r.emitted.join(""), "");
});

test("reset clears a blocked decision so the retry starts clean", () => {
  const r = gate();
  r.gate.push("Situation: x\n");
  r.gate.end();
  assert.equal(r.gate.decision?.coverageBlocked, "unconfirmed");
  r.gate.reset();
  assert.equal(r.gate.decision, null);
  r.gate.push("Coverage: full\nSituation: y");
  r.gate.end();
  assert.deepEqual(r.gate.decision, { coverage: "full", reason: null });
  assert.equal(r.emitted.join(""), "Situation: y");
});

test("a half-read declaration cannot survive a reset into the next attempt", () => {
  const r = gate();
  r.gate.push("Coverage: fu");
  assert.equal(r.gate.decision, null);
  r.gate.reset();
  r.gate.push("ll\nSituation: x");
  r.gate.end();
  assert.deepEqual(r.gate.decision, {
    coverage: "none",
    coverageBlocked: "unconfirmed",
    reason: "missing"
  });
  assert.equal(r.emitted.join(""), "");
});
