// The pure half of the retrieval eval: the config matrix and its validation,
// the scoring of one search against a question's expected SOPs, the per-config
// summary, and the markdown report. No IO — scripts/eval/run.ts does the
// fetching and the writing — so all of this is unit-tested in report.test.ts
// without a Worker, a network, or a neuron.
//
// Runs on Node 24 native type stripping: erasable TS syntax only.

import { MAX_SOPS } from "../../src/lib/pipeline.ts";

export type Turn = { role: "user" | "assistant"; content: string };

// One entry in questions.json. Single-turn cases carry `prompt`; the follow-up
// cases carry `messages`, because query rewrite only applies to a turn that has
// history behind it. An empty `expected` means no SOP covers the question and
// the wanted answer is no files at all.
export type Question = {
  id: string;
  block: string;
  prompt?: string;
  messages?: Turn[];
  expected: string[];
  notes?: string;
};

export type Config = { rewrite: string; max: string; keyword: string };

export type ScoringDetails = {
  keyword_score?: number;
  vector_score?: number;
  keyword_rank?: number;
  vector_rank?: number;
  reranking_score?: number;
};

// What POST /search returns (scripts/eval/worker.ts). `config` is the Worker's
// own resolved RetrievalConfig, which run.ts checks against what it asked for.
export type SearchOut = {
  search_query: string;
  /** The successful AI Search call only, per the Worker's SearchOutcome. */
  ms: number;
  /** Calls it took to get it: 1 unless a rate limit forced a retry. */
  attempts: number;
  config: { rewrite: boolean; maxResults: number; keywordMatch: string };
  chunks: {
    key: string | null;
    score: number | null;
    scoring_details: ScoringDetails | null;
    section: string | null;
  }[];
  ranked: {
    file?: string;
    title: string;
    score: number;
    status: string | null;
  }[];
};

export type EvalRecord = {
  config: string;
  id: string;
  block: string;
  expected: string[];
  /** 1-based position of the first expected key in `ranked`, or null when no
   * expected key made the cards. Always null when `expected` is empty. */
  rank: number | null;
  /** Which expected key matched, when more than one would have counted. */
  matched: string | null;
  /** Distinct files returned. The number that matters for the questions no
   * SOP covers, where the wanted answer is 0. */
  files: number;
  /** The matched file's best chunk carried a keyword_rank, i.e. the BM25 leg
   * of the hybrid search fired rather than vector-only. */
  keywordRank: number | null;
  /** AI Search ran a different query than the one asked (query rewrite). */
  rewritten: boolean;
  ms: number;
  /** Calls the Worker made for this one search (1 unless it hit a rate
   * limit and retried). `ms` excludes the backoff, so a record with
   * attempts > 1 took longer in wall-clock than it reports. */
  attempts: number;
  top3: string[];
  /** The triple the Worker echoed back, derived from its own resolved
   * RetrievalConfig rather than from what was asked for. A divergence aborts
   * the run, so on a completed run this always equals `config`; it is kept so
   * the sidecar records what the Worker said, not what the runner assumed. */
  resolved: string | null;
  error: string | null;
};

export type Summary = {
  config: string;
  hits1: number;
  hits3: number;
  hits5: number;
  misses: number;
  meanRank: number | null;
  meanMs: number;
  errors: number;
};

const REWRITE_VALUES = ["on", "off"];
const KEYWORD_VALUES = ["and", "or"];
// AI Search accepts 1-50 results per request (see lib/retrieval.ts).
const MAX_RESULTS_RE = /^\d+$/;
const MIN_RESULTS = 1;
const MAX_RESULTS = 50;

export function label(cfg: Config): string {
  return `${cfg.rewrite}/${cfg.max}/${cfg.keyword}`;
}

// rewrite {on,off} x max {15,30,50} x keyword {and,or}.
export function defaultMatrix(): Config[] {
  const out: Config[] = [];
  for (const rewrite of ["on", "off"]) {
    for (const max of ["15", "30", "50"]) {
      for (const keyword of ["and", "or"]) out.push({ rewrite, max, keyword });
    }
  }
  return out;
}

/** Parse `--configs`. Throws on anything the Worker would silently coerce:
 * retrievalConfig() falls back to the defaults for an unrecognised value, so
 * a typo would otherwise run the default config under a wrong label and be
 * read as a result. Duplicate triples are dropped rather than searched twice. */
export function parseConfigs(raw: string | null): Config[] {
  if (raw === null) return defaultMatrix();
  const entries = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const out: Config[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const parts = entry.split("/");
    const [rewrite, max, keyword] = parts;
    if (
      parts.length !== 3 ||
      !REWRITE_VALUES.includes(rewrite) ||
      !KEYWORD_VALUES.includes(keyword) ||
      !MAX_RESULTS_RE.test(max) ||
      Number(max) < MIN_RESULTS ||
      Number(max) > MAX_RESULTS
    ) {
      throw new Error(
        `Bad --configs entry "${entry}": want ` +
          `on|off/${MIN_RESULTS}-${MAX_RESULTS}/and|or, e.g. on/30/or`
      );
    }
    const cfg = { rewrite, max, keyword };
    if (seen.has(label(cfg))) continue;
    seen.add(label(cfg));
    out.push(cfg);
  }
  if (out.length === 0) throw new Error("--configs listed no usable triples");
  return out;
}

/** The Worker's own resolved RetrievalConfig, rendered as a triple. */
export function resolvedLabel(resolved: SearchOut["config"]): string {
  return label({
    rewrite: resolved.rewrite ? "on" : "off",
    max: String(resolved.maxResults),
    keyword: resolved.keywordMatch
  });
}

/** The Worker's resolved config against the one asked for. A mismatch means
 * every number in the report is filed under the wrong heading, so the caller
 * stops rather than writing it. */
export function configMismatch(
  requested: Config,
  resolved: SearchOut["config"] | undefined
): string | null {
  if (!resolved) return `asked for ${label(requested)}, the Worker sent none`;
  const actual = resolvedLabel(resolved);
  return actual === label(requested)
    ? null
    : `asked for ${label(requested)}, the Worker resolved ${actual}`;
}

/** The turns sent to the binding: the follow-up cases as written, everything
 * else as a single user turn. */
export function turnsOf(question: Question): Turn[] {
  return (
    question.messages ?? [{ role: "user", content: question.prompt ?? "" }]
  );
}

/** What the eval "asked", for the search_query comparison: the last user turn. */
export function askOf(question: Question): string {
  const turns = turnsOf(question);
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role === "user") return turns[i].content;
  }
  return "";
}

/** 1-based position of the first expected key among the SOP cards. A question
 * with no expected key never has a rank: what matters there is how many files
 * came back at all. */
export function rankOf(
  ranked: SearchOut["ranked"],
  expected: string[]
): { rank: number | null; matched: string | null } {
  if (expected.length === 0) return { rank: null, matched: null };
  for (let i = 0; i < ranked.length; i++) {
    const file = ranked[i].file;
    if (file && expected.includes(file)) return { rank: i + 1, matched: file };
  }
  return { rank: null, matched: null };
}

/** keyword_rank on the matched file's best-scoring chunk. Present means the
 * chunk came back through the keyword index too, not through vectors alone. */
export function keywordRankOf(
  chunks: SearchOut["chunks"],
  key: string | null
): number | null {
  if (!key) return null;
  let best: SearchOut["chunks"][number] | null = null;
  for (const chunk of chunks) {
    if (chunk.key !== key) continue;
    if (!best || (chunk.score ?? 0) > (best.score ?? 0)) best = chunk;
  }
  const rank = best?.scoring_details?.keyword_rank;
  return typeof rank === "number" ? rank : null;
}

/** Per-config stats. Errored records are excluded from every number except
 * `errors` itself: a failed request is missing data, not a miss, and averaging
 * its zero latency in would flatter the config. */
export function summarise(config: string, records: EvalRecord[]): Summary {
  const mine = records.filter((r) => r.config === config);
  const ok = mine.filter((r) => !r.error);
  const scored = ok.filter((r) => r.expected.length > 0);
  const ranks = scored
    .map((r) => r.rank)
    .filter((rank): rank is number => rank !== null);
  return {
    config,
    hits1: ranks.filter((rank) => rank <= 1).length,
    hits3: ranks.filter((rank) => rank <= 3).length,
    hits5: ranks.filter((rank) => rank <= 5).length,
    misses: scored.length - ranks.length,
    meanRank: ranks.length
      ? Math.round((ranks.reduce((a, b) => a + b, 0) / ranks.length) * 100) /
        100
      : null,
    meanMs: ok.length
      ? Math.round(ok.reduce((a, r) => a + r.ms, 0) / ok.length)
      : 0,
    errors: mine.filter((r) => r.error).length
  };
}

export function table(headers: string[], rows: string[][]): string {
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`)
  ].join("\n");
}

/** One grid cell: the rank, with `k` when the BM25 leg fired; the file count
 * for the questions no SOP covers; an em dash for a miss, `err` for a failure. */
export function cell(record: EvalRecord | undefined): string {
  if (!record) return "";
  if (record.error) return "err";
  if (record.expected.length === 0) return String(record.files);
  if (record.rank === null) return "—";
  return `${record.rank}${record.keywordRank === null ? "" : "k"}`;
}

export function renderReport(
  questions: Question[],
  configs: Config[],
  records: EvalRecord[],
  meta: { base: string; date: string; halted: string | null }
): string {
  const labels = configs.map(label);
  const find = (config: string, id: string) =>
    records.find((r) => r.config === config && r.id === id);
  const scored = questions.filter((q) => q.expected.length > 0).length;
  const followUps = questions.filter((q) => q.block === "follow-up");

  const lines: string[] = [];
  lines.push(`# Retrieval eval — ${meta.date}`);
  lines.push("");
  lines.push(
    `Binding-level run against the \`cortex\` AI Search instance through` +
      ` \`scripts/eval/worker.ts\` at ${meta.base}: ${questions.length}` +
      ` questions × ${labels.length} configs, ${records.length} searches.` +
      ` Configs are \`query_rewrite / max_num_results / keyword_match_mode\`.`
  );
  if (meta.halted) {
    lines.push("");
    lines.push(
      `**Stopped early:** ${meta.halted} The tables below are partial.`
    );
  }
  lines.push("");
  lines.push("## Summary by config");
  lines.push("");
  lines.push(
    table(
      [
        "config",
        "hits@1",
        "hits@3",
        "hits@5",
        "misses",
        "mean rank",
        "mean ms",
        "errors"
      ],
      labels.map((config) => {
        const s = summarise(config, records);
        return [
          config,
          String(s.hits1),
          String(s.hits3),
          String(s.hits5),
          String(s.misses),
          s.meanRank === null ? "—" : String(s.meanRank),
          String(s.meanMs),
          String(s.errors)
        ];
      })
    )
  );
  lines.push("");
  lines.push(
    `Scored over the ${scored} questions with an expected SOP. Rank is the` +
      ` 1-based position of the first expected key in \`ranked\`, which` +
      ` rankSops caps at ${MAX_SOPS} — so hits@${MAX_SOPS} is every hit, and` +
      ` "miss" means the SOP was not among the ${MAX_SOPS} files offered.` +
      ` Failed requests are excluded from every column but \`errors\`.`
  );
  lines.push("");
  lines.push("## Questions");
  lines.push("");
  // A list rather than a table: the R2 keys and the notes are long enough that
  // an aligned table pads every row out to the widest one.
  for (const q of questions) {
    const expected = q.expected.length
      ? `expected ${q.expected.map((key) => `\`${key}\``).join(" or ")}`
      : "_no SOP covers this_";
    const notes = q.notes ? ` — ${q.notes}` : "";
    lines.push(`- **${q.id}** (${q.block}) — ${expected}${notes}`);
  }
  lines.push("");
  lines.push("## Rank grid");
  lines.push("");
  lines.push(
    table(
      ["id", ...labels],
      questions.map((q) => [q.id, ...labels.map((c) => cell(find(c, q.id)))])
    )
  );
  lines.push("");
  lines.push(
    `\`—\` = not in the top ${MAX_SOPS}. A trailing \`k\` means the matched` +
      " file's best chunk carried a `keyword_rank`, i.e. the BM25 leg fired" +
      " rather than vector-only. For the questions no SOP covers the cell is" +
      " the number of files returned."
  );
  lines.push("");
  lines.push("## Query rewrite (follow-up turns)");
  lines.push("");
  lines.push(
    table(
      ["id", ...labels],
      followUps.map((q) => [
        q.id,
        ...labels.map((c) => {
          const record = find(c, q.id);
          if (!record) return "";
          if (record.error) return "err";
          return record.rewritten ? "yes" : "no";
        })
      ])
    )
  );
  lines.push("");
  lines.push(
    "`yes` = AI Search ran a query different from the last user turn." +
      " With rewrite on this happens on every turn, the first included" +
      " (observed 3 Sep 2026); with rewrite off it must never happen."
  );
  lines.push("");
  return `${lines.join("\n")}\n`;
}
