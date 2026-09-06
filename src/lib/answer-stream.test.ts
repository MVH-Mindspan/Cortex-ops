import { test } from "node:test";
import assert from "node:assert/strict";
import { createUIMessageStream, readUIMessageStream } from "ai";
import { AnswerStream } from "./answer-stream.ts";
import { CoverageGate } from "./coverage-gate.ts";
import {
  generateAnswer,
  consumeGeneration,
  GENERATION_PARAMS
} from "./generation.ts";
import { COVERAGE_NONE_LINE, COVERAGE_UNCONFIRMED_LINE } from "./copy.ts";
import { textOf, type SOPRef, type FileMeta } from "./pipeline.ts";
import type { CortexMessage } from "../server";

const rule = "Ops staff never change clinical or billing codes on their own.";
const sop: SOPRef = {
  file: "codes.md",
  title: "Code corrections",
  category: "SOP",
  source_url: "https://example.org/codes",
  score: 1,
  last_edited: null,
  cited: true,
  quote: "old"
};
const meta: FileMeta = {
  ...sop,
  status: null,
  use_when: null,
  text: `## Corrections\n1. ${rule}`
};
const ctx = {
  labels: [{ label: 1, file: "codes.md" }],
  sops: [sop],
  meta: new Map([["codes.md", meta]])
};
const body = `Situation: A code needs correcting.\n\nDo now\n1. Route the request to the provider.\n\n**What the SOPs say:** 1. [1] Code corrections "${rule}"\n\nNot covered by the SOPs\nNothing.`;
function collect(aborted = () => false) {
  const events: { kind: string; data: unknown }[] = [];
  const stream = new AnswerStream({
    ctx,
    isAborted: aborted,
    emit: (text) => events.push({ kind: "text", data: text }),
    metadata: (data) => events.push({ kind: "metadata", data }),
    sources: (data) => events.push({ kind: "sources", data })
  });
  return { stream, events };
}
function sse(parts: string[], fail = false): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index < parts.length)
        controller.enqueue(
          new TextEncoder().encode(
            `data: ${JSON.stringify({ response: parts[index++] })}\n\n`
          )
        );
      else if (fail) controller.error(new Error("synthetic provider failure"));
      else controller.close();
    }
  });
}

for (const declaration of [
  "Coverage: full\n",
  "**Coverage: Full.**\r\n",
  "__Coverage — partial__\n",
  "\n \nCoverage: partial. Situation:"
]) {
  test(`coverage admission preserves metadata ordering at every split: ${JSON.stringify(declaration)}`, () => {
    const input = declaration + body;
    for (let at = 0; at <= input.length; at++) {
      const { stream, events } = collect();
      stream.push(input.slice(0, at));
      stream.push(input.slice(at));
      stream.finish();
      assert.equal(events[0]?.kind, "metadata", String(at));
      assert.ok(stream.delivered.includes(rule), String(at));
      assert.ok(
        stream.delivered.includes("**What the SOPs say:**\n"),
        String(at)
      );
      assert.doesNotMatch(stream.delivered, /Coverage:/);
      assert.equal(stream.stats().delivered_steps, 1);
    }
  });
}

for (const prefix of [
  "Coverage: none\n",
  "Coverage: unknown\n",
  "Coverage: fuller\n",
  "**Coverage: full\n",
  "Coverage: full-not-confirmed\n",
  "Situation: x\n",
  " ".repeat(256),
  "Coverage: full" + " ".repeat(256)
]) {
  test(`blocked answers never emit their instructions: ${JSON.stringify(prefix.slice(0, 40))}`, () => {
    const input = prefix + body;
    for (let at = 0; at <= input.length; at++) {
      const { stream, events } = collect();
      stream.push(input.slice(0, at));
      stream.push(input.slice(at));
      stream.finish();
      stream.fail();
      stream.finish();
      assert.equal(
        stream.delivered,
        prefix === "Coverage: none\n"
          ? COVERAGE_NONE_LINE
          : COVERAGE_UNCONFIRMED_LINE
      );
      assert.equal(stream.stats().delivered_steps, 0);
      const sources = events.find((e) => e.kind === "sources")
        ?.data as SOPRef[];
      assert.equal(sources[0].cited, false);
      assert.equal(sources[0].quote, null);
      assert.doesNotMatch(
        JSON.stringify(stream.stats()),
        /Code corrections|Route the request/
      );
    }
  });
}

test("short declarations resolve only when complete; the bounded gate accepts same-line answers", () => {
  for (const [input, expected] of [
    ["Coverage: full", ""],
    ["Coverage: none", COVERAGE_NONE_LINE],
    ["", COVERAGE_UNCONFIRMED_LINE],
    ["Coverage: full. Answer: A short answer.", "Answer: A short answer."]
  ]) {
    const { stream } = collect();
    for (const char of input) stream.push(char);
    stream.finish();
    assert.equal(stream.delivered, expected);
  }
  const { stream } = collect();
  stream.push("Coverage: full");
  assert.equal(stream.decision, null);
  stream.push("er\nunsafe");
  stream.finish();
  assert.equal(stream.delivered, COVERAGE_UNCONFIRMED_LINE);
});

test("abort during the header, body, or citation tail publishes nothing further", () => {
  const input = "Coverage: full\n" + body;
  for (let at = 0; at < input.length; at++) {
    let aborted = false;
    const { stream, events } = collect(() => aborted);
    stream.push(input.slice(0, at));
    const before = JSON.stringify(events);
    aborted = true;
    stream.push(input.slice(at));
    stream.finish();
    stream.fail();
    assert.equal(JSON.stringify(events), before, String(at));
  }
});

test("provider failures cannot flush suppressed or undecided text", async () => {
  for (const prefix of [
    "Coverage: none\n",
    "Coverage: unknown\n",
    "unfinished"
  ]) {
    const { stream } = collect();
    await assert.rejects(
      consumeGeneration(sse([prefix + body.repeat(2)], true), (text) =>
        stream.push(text)
      )
    );
    const before = stream.delivered;
    stream.fail();
    stream.finish();
    assert.equal(stream.delivered, before);
    assert.doesNotMatch(stream.delivered, /Route the request/);
  }
});

test("collapse retries reset the full sink and use production parameters", async () => {
  const { stream } = collect();
  const params: unknown[] = [];
  const result = await generateAnswer([], stream, async (input) => {
    params.push({
      temperature: input.temperature,
      ...(input.repetition_penalty
        ? { repetition_penalty: input.repetition_penalty }
        : {})
    });
    return sse([
      params.length < 3 ? "the a of ".repeat(80) : "Coverage: full\n" + body
    ]);
  });
  stream.finish();
  assert.equal(result.attempt, 3);
  assert.deepEqual(params, GENERATION_PARAMS);
  assert.doesNotMatch(stream.delivered, /the a of/);
  assert.equal(stream.stats().delivered_steps, 1);
});

test("exhausted collapse retries and pre-aborted requests emit nothing", async () => {
  const { stream, events } = collect();
  const result = await generateAnswer([], stream, async () =>
    sse(["the a of ".repeat(80)])
  );
  assert.equal(result.degenerate, true);
  assert.deepEqual(events, []);
  const controller = new AbortController();
  controller.abort();
  let called = false;
  const aborted = await generateAnswer(
    [],
    stream,
    async () => {
      called = true;
      return sse([]);
    },
    controller.signal
  );
  assert.equal(called, false);
  assert.equal(aborted.aborted, true);
});

test("reset discards an undecided prefix from an abandoned attempt", () => {
  const emitted: string[] = [];
  const gate = new CoverageGate(
    (s) => emitted.push(s),
    () => {},
    () => false
  );
  gate.push("Coverage: no");
  gate.reset();
  gate.push("Coverage: full\nAnswer: supported");
  gate.end();
  assert.equal(emitted.join(""), "Answer: supported");
});

test("AI SDK message reconstruction and JSON reload preserve only delivered text and metadata", async () => {
  for (const coverage of ["full", "partial", "none", "invalid"]) {
    let delivered = "";
    const output = createUIMessageStream<CortexMessage>({
      execute: ({ writer }) => {
        writer.write({ type: "start", messageId: "answer" });
        writer.write({ type: "data-sops", id: "sops", data: [sop] });
        let started = false;
        const adapter = new AnswerStream({
          ctx,
          isAborted: () => false,
          metadata: (messageMetadata) =>
            writer.write({ type: "message-metadata", messageMetadata }),
          sources: (data) =>
            writer.write({ type: "data-sops", id: "sops", data }),
          emit: (delta) => {
            if (!started) {
              writer.write({ type: "text-start", id: "text" });
              started = true;
            }
            writer.write({ type: "text-delta", id: "text", delta });
          }
        });
        for (const char of `Coverage: ${coverage}\n${body}`) adapter.push(char);
        adapter.finish();
        delivered = adapter.delivered;
        if (started) writer.write({ type: "text-end", id: "text" });
      }
    });
    let saved: CortexMessage | undefined;
    for await (const message of readUIMessageStream<CortexMessage>({
      stream: output
    }))
      saved = message;
    const reloaded = JSON.parse(JSON.stringify(saved)) as CortexMessage;
    assert.equal(textOf(reloaded), delivered);
    assert.equal(
      reloaded.metadata?.coverage,
      coverage === "invalid" ? "none" : coverage
    );
    assert.equal(
      reloaded.parts.filter((p) => p.type === "data-sops").length,
      1
    );
    if (coverage === "none" || coverage === "invalid") {
      assert.equal(
        reloaded.metadata?.coverageBlocked,
        coverage === "none" ? "none" : "unconfirmed"
      );
      assert.doesNotMatch(textOf(reloaded), /Route the request/);
    }
  }
});
