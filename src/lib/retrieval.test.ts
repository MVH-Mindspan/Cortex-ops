import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RETRIEVAL_DEFAULTS,
  retrievalConfig,
  retrievalTelemetry,
  searchOptions,
  type RetrievalConfig,
  type SearchOutcome
} from "./retrieval.ts";
import type { SearchChunk, SearchResponse } from "./pipeline.ts";

// The two things telemetry must never carry: the query AI Search ran (built
// from the team member's message) and anything AI Search returns from the SOP
// itself — chunk text, chunk ids, item metadata. All of them are marked, so a
// leak of any shows up as "SENTINEL" in the serialised log line. `item.key` is
// deliberately NOT marked: SOP keys are logged on purpose, and naming them is
// the point of `top`.
const QUERY = "SENTINEL QUERY TEXT";
const CHUNK_TEXT = "SENTINEL CHUNK TEXT";
const METADATA = { title: "SENTINEL TITLE", use_when: CHUNK_TEXT };

const chunk = (key: string, score: number, rerank?: number): SearchChunk => ({
  id: `SENTINEL CHUNK ID ${key}`,
  score,
  text: CHUNK_TEXT,
  item: { key, metadata: METADATA },
  ...(rerank === undefined
    ? {}
    : { scoring_details: { reranking_score: rerank } })
});

// Three files in five chunks: a.md's best chunk is the second one, b.md was
// not reranked, one chunk came back with no source key at all (its high score
// must not reach `top`) and one with no score (read as 0).
const results: SearchResponse = {
  search_query: QUERY,
  chunks: [
    chunk("a.md", 0.4, 0.91),
    chunk("a.md", 0.6, 0.22),
    chunk("b.md", 0.5),
    { id: "SENTINEL CHUNK ID orphan", score: 0.99, text: CHUNK_TEXT, item: {} },
    {
      id: "SENTINEL CHUNK ID c.md",
      text: CHUNK_TEXT,
      item: { key: "c.md", metadata: METADATA }
    }
  ]
};

const outcome = (
  response: SearchResponse,
  ms = 42,
  attempts = 1
): SearchOutcome => ({ results: response, ms, attempts });

const CFG: RetrievalConfig = {
  rewrite: true,
  maxResults: 15,
  keywordMatch: "and"
};

test("nothing configured is today's live behaviour", () => {
  assert.deepEqual(retrievalConfig({}), {
    rewrite: true,
    maxResults: 15,
    keywordMatch: "and"
  });
  assert.deepEqual(retrievalConfig({}), RETRIEVAL_DEFAULTS);
});

test("max results is trimmed, clamped to 1-50, else the default", () => {
  const max = (value?: string) => retrievalConfig({ max: value }).maxResults;
  assert.equal(max("0"), 1);
  assert.equal(max("99"), 50);
  assert.equal(max("abc"), 15);
  assert.equal(max("30"), 30);
  assert.equal(max(" 30 "), 30);
  assert.equal(max(""), 15);
});

test("query rewrite reads the usual on/off spellings, else stays on", () => {
  const rewrite = (value?: string) =>
    retrievalConfig({ rewrite: value }).rewrite;
  for (const on of ["on", "true", "1", "ON"]) {
    assert.equal(rewrite(on), true, on);
  }
  for (const off of ["off", "false", "0"]) {
    assert.equal(rewrite(off), false, off);
  }
  assert.equal(rewrite(""), true);
  assert.equal(rewrite("maybe"), true);
});

test("keyword match is 'and' unless the var says 'or'", () => {
  const keyword = (value?: string) =>
    retrievalConfig({ keyword: value }).keywordMatch;
  assert.equal(keyword("or"), "or");
  assert.equal(keyword("OR"), "or");
  assert.equal(keyword("and"), "and");
  assert.equal(keyword("xor"), "and");
  assert.equal(keyword(""), "and");
});

test("searchOptions states every knob explicitly on each request", () => {
  assert.deepEqual(searchOptions(RETRIEVAL_DEFAULTS), {
    retrieval: {
      retrieval_type: "hybrid",
      fusion_method: "rrf",
      keyword_match_mode: "and",
      match_threshold: 0.01,
      max_num_results: 15,
      return_on_failure: false
    },
    reranking: { enabled: true, match_threshold: 0.001 },
    query_rewrite: { enabled: true }
  });
  const flipped = retrievalConfig({ rewrite: "off", max: "30", keyword: "or" });
  assert.deepEqual(searchOptions(flipped), {
    retrieval: {
      retrieval_type: "hybrid",
      fusion_method: "rrf",
      keyword_match_mode: "or",
      match_threshold: 0.01,
      max_num_results: 30,
      return_on_failure: false
    },
    reranking: { enabled: true, match_threshold: 0.001 },
    query_rewrite: { enabled: false }
  });
});

test("telemetry is counts, SOP keys, scores, config, calls and latency", () => {
  const stats = retrievalTelemetry(
    outcome(results, 42, 2),
    "what do I do",
    1,
    CFG
  );
  assert.deepEqual(Object.keys(stats).sort(), [
    "attempts",
    "chunks",
    "files",
    "kw",
    "max",
    "ms",
    "qlen",
    "rewrite",
    "rewritten",
    "sqlen",
    "top",
    "turns"
  ]);
  assert.equal(stats.chunks, 5);
  assert.equal(stats.files, 3);
  assert.deepEqual(stats.top, [
    ["a.md", 0.6, 0.22],
    ["b.md", 0.5, null],
    ["c.md", 0, null]
  ]);
  assert.equal(stats.rewrite, true);
  assert.equal(stats.turns, 1);
  assert.equal(stats.attempts, 2);
  assert.equal(stats.qlen, "what do I do".length);
  assert.equal(stats.sqlen, QUERY.length);
  assert.equal(stats.max, 15);
  assert.equal(stats.kw, "and");
  assert.equal(stats.ms, 42);
});

test("no query text and no chunk text reach the log line", () => {
  const stats = retrievalTelemetry(outcome(results), QUERY, 1, CFG);
  assert.ok(!JSON.stringify(stats).includes("SENTINEL"));
});

test("the search response is not mutated", () => {
  const before = structuredClone(results);
  retrievalTelemetry(outcome(results), "hello", 3, CFG);
  assert.deepEqual(results, before);
});

test("rewritten compares the query that ran, on every turn", () => {
  const seen = (latest: string, turns: number, response = results) =>
    retrievalTelemetry(outcome(response), latest, turns, CFG).rewritten;
  // Turn 1 is searched as typed, so a true here is the canary firing.
  assert.equal(seen(QUERY, 1), false);
  assert.equal(seen(`  ${QUERY}\n`, 1), false);
  assert.equal(seen("something else entirely", 1), true);
  // A follow-up turn AI Search rewrote, and one it searched verbatim.
  const followUp: SearchResponse = {
    ...results,
    search_query: "the query AI Search built from the thread"
  };
  assert.equal(seen(QUERY, 2, followUp), true);
  assert.equal(seen(QUERY, 4), false);
});

test("top is each file's best chunk, highest first, capped at five", () => {
  const many: SearchResponse = {
    search_query: QUERY,
    chunks: Array.from({ length: 7 }, (_, i) => chunk(`f${i}.md`, i / 10))
  };
  const stats = retrievalTelemetry(outcome(many), "q", 1, CFG);
  assert.equal(stats.chunks, 7);
  assert.equal(stats.files, 7);
  assert.deepEqual(
    stats.top.map(([key]) => key),
    ["f6.md", "f5.md", "f4.md", "f3.md", "f2.md"]
  );
});

test("a search that matched nothing is still measured", () => {
  const stats = retrievalTelemetry(
    outcome({ search_query: QUERY, chunks: [] }, 7),
    "q",
    1,
    CFG
  );
  assert.equal(stats.chunks, 0);
  assert.equal(stats.files, 0);
  assert.deepEqual(stats.top, []);
  assert.equal(stats.ms, 7);
});
