import { test } from "node:test";
import assert from "node:assert/strict";
import { hasDeepLinkParams, parseDeepLink } from "./deeplink.ts";

const MAX = 8_000;

test("a link without v is a plain visit and nothing is stripped", () => {
  assert.equal(parseDeepLink("?q=hello", MAX), null);
  assert.equal(hasDeepLinkParams("?q=hello"), false);
  assert.equal(hasDeepLinkParams("?foo=1"), false);
  assert.equal(hasDeepLinkParams(""), false);
});

test("any v triggers the strip; only v=1 is honoured", () => {
  assert.equal(hasDeepLinkParams("?v=9"), true);
  assert.equal(hasDeepLinkParams("?v=1&q=x"), true);
  assert.equal(parseDeepLink("?v=2&q=hello", MAX), null);
  assert.equal(parseDeepLink("?v=&q=hello", MAX), null);
  assert.equal(parseDeepLink("?v=1&q=hello", MAX)?.text, "hello");
});

test("q missing or whitespace-only is a plain visit", () => {
  assert.equal(parseDeepLink("?v=1", MAX), null);
  assert.equal(parseDeepLink("?v=1&q=", MAX), null);
  assert.equal(parseDeepLink("?v=1&q=+++", MAX), null);
  assert.equal(parseDeepLink("?v=1&q=%0D%0A", MAX), null);
});

test("q is decoded once as form encoding: + is a space, %0A a newline", () => {
  assert.equal(parseDeepLink("?v=1&q=a+b%0Ac", MAX)?.text, "a b\nc");
  assert.equal(parseDeepLink("?v=1&q=a%252Bb", MAX)?.text, "a%2Bb");
});

test("CRLF and a lone CR normalise to LF and the text is trimmed", () => {
  assert.equal(parseDeepLink("?v=1&q=a%0D%0Ab", MAX)?.text, "a\nb");
  assert.equal(parseDeepLink("?v=1&q=a%0Db", MAX)?.text, "a\nb");
  assert.equal(parseDeepLink("?v=1&q=++x+%0A", MAX)?.text, "x");
});

test("a malformed percent sequence never throws and is a plain visit", () => {
  assert.doesNotThrow(() => parseDeepLink("?v=1&q=%E0%A4%A", MAX));
  assert.equal(parseDeepLink("?v=1&q=%E0%A4%A", MAX), null);
  assert.equal(parseDeepLink("?v=1&action=ask&q=%E0%A4%A", MAX), null);
});

test("the first q wins when it repeats", () => {
  assert.equal(parseDeepLink("?v=1&q=first&q=second", MAX)?.text, "first");
});

test("action defaults to draft; only an exact ask asks", () => {
  assert.equal(parseDeepLink("?v=1&q=x", MAX)?.action, "draft");
  assert.equal(parseDeepLink("?v=1&q=x&action=ask", MAX)?.action, "ask");
  assert.equal(parseDeepLink("?v=1&q=x&action=draft", MAX)?.action, "draft");
  assert.equal(parseDeepLink("?v=1&q=x&action=bogus", MAX)?.action, "draft");
  assert.equal(parseDeepLink("?v=1&q=x&action=ASK", MAX)?.action, "draft");
});

test("text over the cap downgrades ask to draft and keeps the text intact", () => {
  const atCap = "a".repeat(MAX);
  const over = "a".repeat(MAX + 1);
  const ok = parseDeepLink(`?v=1&action=ask&q=${atCap}`, MAX);
  assert.equal(ok?.action, "ask");
  assert.equal(ok?.text.length, MAX);
  const long = parseDeepLink(`?v=1&action=ask&q=${over}`, MAX);
  assert.equal(long?.action, "draft");
  assert.equal(long?.text, over);
});

test("src is a short lowercase slug or dropped", () => {
  assert.equal(parseDeepLink("?v=1&q=x&src=om", MAX)?.src, "om");
  assert.equal(parseDeepLink("?v=1&q=x&src=huddle-2", MAX)?.src, "huddle-2");
  assert.equal(parseDeepLink("?v=1&q=x&src=OM", MAX)?.src, null);
  assert.equal(parseDeepLink("?v=1&q=x&src=a+b", MAX)?.src, null);
  assert.equal(parseDeepLink("?v=1&q=x&src=", MAX)?.src, null);
  assert.equal(parseDeepLink(`?v=1&q=x&src=${"a".repeat(17)}`, MAX)?.src, null);
  assert.equal(parseDeepLink("?v=1&q=x", MAX)?.src, null);
});

test("ref is an opaque id of up to 64 safe characters or dropped", () => {
  assert.equal(parseDeepLink("?v=1&q=x&ref=M001", MAX)?.ref, "M001");
  assert.equal(
    parseDeepLink("?v=1&q=x&ref=SIM-99205-004", MAX)?.ref,
    "SIM-99205-004"
  );
  assert.equal(parseDeepLink("?v=1&q=x&ref=task_1", MAX)?.ref, "task_1");
  assert.equal(parseDeepLink("?v=1&q=x&ref=-lead", MAX)?.ref, null);
  assert.equal(parseDeepLink("?v=1&q=x&ref=..", MAX)?.ref, null);
  assert.equal(parseDeepLink("?v=1&q=x&ref=a%2Fb", MAX)?.ref, null);
  assert.equal(parseDeepLink("?v=1&q=x&ref=a+b", MAX)?.ref, null);
  assert.equal(parseDeepLink(`?v=1&q=x&ref=${"a".repeat(65)}`, MAX)?.ref, null);
  assert.equal(
    parseDeepLink(`?v=1&q=x&ref=${"a".repeat(64)}`, MAX)?.ref,
    "a".repeat(64)
  );
});

test("unknown parameters are ignored", () => {
  assert.deepEqual(
    parseDeepLink("?v=1&q=x&utm_source=slack&return=https://evil.test", MAX),
    { action: "draft", text: "x", src: null, ref: null }
  );
});

// The Orchestration Manager's worked example (design spec A7). The same
// literal is asserted clean by the screens in phi.test.ts; the drift guard is
// between the two repos, so the text is duplicated here on purpose.
const OM_SAMPLE_M001 = [
  "Caregiver Required: confirm caregiver attendance for a Cognitive Assessment (99483) visit in 7 days.",
  "This task is unclaimed and I am deciding whether to pick it up. In Orchestration Manager it sits with the Member Experience team as Caregiver Liaison, on the Cognitive pathway, core protocol. It was flagged as 'Protocol step missing' by Cognitive Visit Protocol — Phase 2 Readiness Checklist. The visit is a Cognitive Assessment (99483) in 7 days. The caregiver contact status is pending. It is pending, high priority, due in 6 days.",
  "What are the steps to complete this task, and who handles it?"
].join("\n");

const OM_SAMPLE_M001_URL =
  "https://cortex.mvh-9c9.workers.dev/?v=1&action=ask&q=Caregiver+Required%3A+confirm+caregiver+attendance+for+a+Cognitive+Assessment+%2899483%29+visit+in+7+days.%0AThis+task+is+unclaimed+and+I+am+deciding+whether+to+pick+it+up.+In+Orchestration+Manager+it+sits+with+the+Member+Experience+team+as+Caregiver+Liaison%2C+on+the+Cognitive+pathway%2C+core+protocol.+It+was+flagged+as+%27Protocol+step+missing%27+by+Cognitive+Visit+Protocol+%E2%80%94+Phase+2+Readiness+Checklist.+The+visit+is+a+Cognitive+Assessment+%2899483%29+in+7+days.+The+caregiver+contact+status+is+pending.+It+is+pending%2C+high+priority%2C+due+in+6+days.%0AWhat+are+the+steps+to+complete+this+task%2C+and+who+handles+it%3F&src=om&ref=M001";

test("the Orchestration Manager M001 link parses to its fixture", () => {
  const { search } = new URL(OM_SAMPLE_M001_URL);
  assert.equal(hasDeepLinkParams(search), true);
  assert.deepEqual(parseDeepLink(search, MAX), {
    action: "ask",
    text: OM_SAMPLE_M001,
    src: "om",
    ref: "M001"
  });
  assert.equal(OM_SAMPLE_M001.length, 596);
});
