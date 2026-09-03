import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cell,
  configMismatch,
  resolvedLabel,
  defaultMatrix,
  parseConfigs,
  rankOf,
  renderReport,
  summarise,
  type EvalRecord,
  type Question,
  type SearchOut
} from "./report.ts";

const IMAGING = "imaging-order-requirements.md";
const EXTERNAL = "external-facility-provider-calls.md";

function ranked(...files: string[]): SearchOut["ranked"] {
  return files.map((file, i) => ({
    file,
    title: file,
    score: 1 - i / 10,
    status: null
  }));
}

function record(over: Partial<EvalRecord> = {}): EvalRecord {
  return {
    config: "on/15/and",
    id: "Q",
    block: "A",
    expected: [IMAGING],
    rank: 1,
    matched: IMAGING,
    files: 3,
    keywordRank: null,
    rewritten: false,
    ms: 100,
    attempts: 1,
    top3: [],
    resolved: "on/15/and",
    error: null,
    ...over
  };
}

test("parseConfigs defaults to the full 12-config matrix", () => {
  const matrix = defaultMatrix();
  assert.equal(matrix.length, 12);
  assert.deepEqual(parseConfigs(null), matrix);
  assert.equal(
    new Set(matrix.map((c) => `${c.rewrite}${c.max}${c.keyword}`)).size,
    12
  );
});

test("parseConfigs accepts well-formed triples and dedupes them", () => {
  assert.deepEqual(parseConfigs("on/15/and, off/50/or"), [
    { rewrite: "on", max: "15", keyword: "and" },
    { rewrite: "off", max: "50", keyword: "or" }
  ]);
  // Same triple twice is one search, not two.
  assert.deepEqual(parseConfigs("on/30/or,on/30/or"), [
    { rewrite: "on", max: "30", keyword: "or" }
  ]);
  assert.deepEqual(parseConfigs("on/1/and"), [
    { rewrite: "on", max: "1", keyword: "and" }
  ]);
});

test("parseConfigs rejects anything retrievalConfig would silently coerce", () => {
  // Each of these would fall back to a default and run under a wrong label.
  const bad = [
    "yes/15/and", // rewrite is on|off
    "on/15/AND", // keyword is and|or, lowercase
    "on/0/and", // below the 1-50 range
    "on/51/and", // above it
    "on/15.5/and", // not an integer
    "on/fifteen/and",
    "on/15", // too few parts
    "on/15/and/extra", // too many
    "" // nothing usable at all
  ];
  for (const entry of bad) {
    assert.throws(() => parseConfigs(entry), /Bad --configs|no usable/, entry);
  }
});

test("rankOf is 1-based, null on a miss, and never ranks an uncovered question", () => {
  assert.deepEqual(rankOf(ranked(IMAGING, EXTERNAL), [IMAGING]), {
    rank: 1,
    matched: IMAGING
  });
  assert.deepEqual(rankOf(ranked("other.md", "next.md", IMAGING), [IMAGING]), {
    rank: 3,
    matched: IMAGING
  });
  // Either expected key counts, at the position of whichever came first.
  assert.deepEqual(rankOf(ranked("other.md", EXTERNAL), [IMAGING, EXTERNAL]), {
    rank: 2,
    matched: EXTERNAL
  });
  assert.deepEqual(rankOf(ranked("other.md"), [IMAGING]), {
    rank: null,
    matched: null
  });
  assert.deepEqual(rankOf([], [IMAGING]), { rank: null, matched: null });
  // A question no SOP covers has no rank however many files came back.
  assert.deepEqual(rankOf(ranked(IMAGING, EXTERNAL), []), {
    rank: null,
    matched: null
  });
});

test("summarise counts hits at 1, 3 and 5 and means the ranks of hits only", () => {
  const s = summarise("c", [
    record({ config: "c", id: "a", rank: 1, ms: 100 }),
    record({ config: "c", id: "b", rank: 3, ms: 200 }),
    record({ config: "c", id: "d", rank: 5, ms: 300 }),
    record({ config: "c", id: "e", rank: null, matched: null, ms: 400 }),
    // Another config's records must not leak into this one.
    record({ config: "other", id: "a", rank: 1, ms: 9000 })
  ]);
  assert.equal(s.hits1, 1);
  assert.equal(s.hits3, 2);
  assert.equal(s.hits5, 3);
  assert.equal(s.misses, 1);
  assert.equal(s.meanRank, 3);
  assert.equal(s.meanMs, 250);
  assert.equal(s.errors, 0);
});

test("summarise excludes errored records from every column but errors", () => {
  const s = summarise("c", [
    record({ config: "c", id: "a", rank: 1, ms: 100 }),
    record({
      config: "c",
      id: "b",
      rank: null,
      matched: null,
      ms: 0,
      error: "500 boom"
    })
  ]);
  // The failure is missing data, not a miss, and its zero ms is not latency.
  assert.equal(s.misses, 0);
  assert.equal(s.hits1, 1);
  assert.equal(s.meanRank, 1);
  assert.equal(s.meanMs, 100);
  assert.equal(s.errors, 1);
});

test("summarise reports no mean rank when nothing hit", () => {
  const s = summarise("c", [
    record({ config: "c", rank: null, matched: null })
  ]);
  assert.equal(s.meanRank, null);
  assert.equal(s.misses, 1);
});

test("cell shows the rank, the BM25 marker, the file count and failures", () => {
  assert.equal(cell(record({ rank: 2 })), "2");
  assert.equal(cell(record({ rank: 2, keywordRank: 4 })), "2k");
  assert.equal(cell(record({ rank: null, matched: null })), "—");
  assert.equal(cell(record({ expected: [], rank: null, files: 3 })), "3");
  assert.equal(cell(record({ expected: [], rank: null, files: 0 })), "0");
  assert.equal(cell(record({ error: "500 boom" })), "err");
  assert.equal(cell(undefined), "");
});

test("configMismatch passes an honoured config and names a diverging one", () => {
  const asked = { rewrite: "on", max: "30", keyword: "or" };
  // What lands in the record's `resolved` field: the Worker's own numbers.
  assert.equal(
    resolvedLabel({ rewrite: false, maxResults: 50, keywordMatch: "or" }),
    "off/50/or"
  );
  assert.equal(
    configMismatch(asked, {
      rewrite: true,
      maxResults: 30,
      keywordMatch: "or"
    }),
    null
  );
  // The Worker fell back to the defaults: every number would be mislabelled.
  const drift = configMismatch(asked, {
    rewrite: true,
    maxResults: 15,
    keywordMatch: "and"
  });
  assert.match(drift ?? "", /asked for on\/30\/or/);
  assert.match(drift ?? "", /resolved on\/15\/and/);
  assert.match(configMismatch(asked, undefined) ?? "", /sent none/);
});

// The rank grid is the table the flip decision is read off, so its shape is
// worth asserting: one row per question, one column per config, in order.
test("renderReport writes a grid of every question by every config", () => {
  const questions: Question[] = [
    { id: "R3", block: "rerun", prompt: "?", expected: [IMAGING], notes: "n" },
    { id: "C3", block: "C", prompt: "?", expected: [] },
    {
      id: "T1",
      block: "follow-up",
      messages: [{ role: "user", content: "?" }],
      expected: [IMAGING]
    }
  ];
  const configs = parseConfigs("on/15/and,on/30/or");
  const records = configs.flatMap((cfg, i) =>
    questions.map((q) =>
      record({
        config: `${cfg.rewrite}/${cfg.max}/${cfg.keyword}`,
        id: q.id,
        block: q.block,
        expected: q.expected,
        rank: q.expected.length ? i + 1 : null,
        matched: q.expected.length ? IMAGING : null,
        files: 2,
        rewritten: q.block === "follow-up"
      })
    )
  );
  const md = renderReport(questions, configs, records, {
    base: "http://127.0.0.1:8790",
    date: "2026-09-03",
    halted: null
  });

  const start = md.indexOf("## Rank grid");
  const grid = md
    .slice(start, md.indexOf("## ", start + 3))
    .split("\n")
    .filter((line) => line.startsWith("|"))
    .map((line) =>
      line
        .slice(1, -1)
        .split("|")
        .map((c) => c.trim())
    );
  const [header, separator, ...rows] = grid;
  assert.deepEqual(header, ["id", "on/15/and", "on/30/or"]);
  assert.equal(separator.length, 3);
  assert.deepEqual(
    rows.map((row) => row[0]),
    ["R3", "C3", "T1"]
  );
  for (const row of rows) assert.equal(row.length, configs.length + 1);
  // C3 has no expected SOP, so its cell is the file count, not a rank.
  assert.deepEqual(rows[1], ["C3", "2", "2"]);
  assert.deepEqual(rows[0], ["R3", "1", "2"]);

  // The follow-up table carries only the follow-up rows.
  const rewriteStart = md.indexOf("## Query rewrite");
  const rewrite = md
    .slice(rewriteStart)
    .split("\n")
    .filter((line) => line.startsWith("|"));
  assert.equal(rewrite.length, 3); // header, separator, T1
  assert.match(rewrite[2], /^\| T1 \| yes \| yes \|$/);

  // Sanity: the caption is derived from MAX_SOPS, not hard-coded.
  assert.match(md, /rankSops caps at 5/);
  assert.match(md, /2 questions with an expected SOP/);
});

test("renderReport says so when the run stopped early", () => {
  const md = renderReport([], parseConfigs("on/15/and"), [], {
    base: "b",
    date: "2026-09-03",
    halted: "the allocation is exhausted."
  });
  assert.match(md, /\*\*Stopped early:\*\* the allocation is exhausted\./);
});
