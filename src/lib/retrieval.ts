// Retrieval settings and shape-only telemetry for the AI Search stage: the
// wrangler vars parsed into a config, that config rendered as the explicit
// per-request search options, and the one log line each search produces. Pure
// — no Workers bindings, no side effects, nothing async — so the knobs and
// the stats can be unit-tested without calling AI Search.

import { bestScoreByFile, type SearchResponse } from "./pipeline.ts";

export type RetrievalConfig = {
  rewrite: boolean;
  maxResults: number;
  keywordMatch: "and" | "or";
};

/** What the live instance does today, so an unset or unreadable var can
 * never change an answer. `wrangler ai-search get cortex` on 3 Sep 2026
 * reported the `cortex` instance as hybrid retrieval, rrf fusion, keyword
 * match mode "and": the literals in searchOptions() below say the same
 * thing per request, and win if the instance is ever reconfigured. */
export const RETRIEVAL_DEFAULTS: RetrievalConfig = {
  rewrite: true,
  maxResults: 15,
  keywordMatch: "and"
};

// AI Search accepts 1-50 results per request.
const MIN_RESULTS = 1;
const MAX_RESULTS = 50;

// Near-zero thresholds on purpose: colloquial ops scenarios score 0.1-0.35
// against SOP prose and the reranker scores them lower still — quality comes
// from rerank ORDERING plus the passage and file caps in pipeline.ts, not
// from a floor that would drop every real question.
const MATCH_THRESHOLD = 0.01;
const RERANK_THRESHOLD = 0.001;

// How many SOPs the telemetry line names.
const TOP_FILES = 5;

function flag(value: string | undefined, fallback: boolean): boolean {
  const raw = (value ?? "").trim().toLowerCase();
  if (raw === "on" || raw === "true" || raw === "1") return true;
  if (raw === "off" || raw === "false" || raw === "0") return false;
  return fallback;
}

/** Wrangler vars arrive as strings (and are typed on Env as the literal
 * string in wrangler.jsonc), so every setting is parsed here from
 * `string | undefined` rather than compared inline. Anything unset,
 * out of range or unrecognised falls back to RETRIEVAL_DEFAULTS. */
export function retrievalConfig(vars: {
  rewrite?: string;
  max?: string;
  keyword?: string;
}): RetrievalConfig {
  const rawMax = (vars.max ?? "").trim();
  const max = Number(rawMax);
  const keyword = (vars.keyword ?? "").trim().toLowerCase();
  return {
    rewrite: flag(vars.rewrite, RETRIEVAL_DEFAULTS.rewrite),
    maxResults:
      rawMax === "" || !Number.isFinite(max)
        ? RETRIEVAL_DEFAULTS.maxResults
        : Math.min(MAX_RESULTS, Math.max(MIN_RESULTS, Math.round(max))),
    keywordMatch:
      keyword === "or" || keyword === "and"
        ? keyword
        : RETRIEVAL_DEFAULTS.keywordMatch
  };
}

/** The options sent with every search. Stating them per request overrides
 * the AI Search instance's own settings, so retrieval behaviour lives in
 * wrangler.jsonc and this file rather than in a dashboard nobody can diff;
 * `retrieval_type` and `fusion_method` restate what the live instance is
 * configured to do (see RETRIEVAL_DEFAULTS) and win if that ever changes. */
export function searchOptions(cfg: RetrievalConfig): {
  retrieval: {
    retrieval_type: "hybrid";
    fusion_method: "rrf";
    keyword_match_mode: "and" | "or";
    match_threshold: number;
    max_num_results: number;
    return_on_failure: boolean;
  };
  reranking: { enabled: boolean; match_threshold: number };
  query_rewrite: { enabled: boolean };
} {
  return {
    retrieval: {
      retrieval_type: "hybrid",
      fusion_method: "rrf",
      keyword_match_mode: cfg.keywordMatch,
      match_threshold: MATCH_THRESHOLD,
      max_num_results: cfg.maxResults,
      // AI Search defaults to returning empty results when its own backend
      // fails, which would reach the reader as the no-match line ("No SOP
      // covers this yet") during an outage. Throwing instead lands on the
      // retrieval error notice, which is the honest one.
      return_on_failure: false
    },
    reranking: { enabled: true, match_threshold: RERANK_THRESHOLD },
    query_rewrite: { enabled: cfg.rewrite }
  };
}

/** One completed search: what AI Search returned, how long the successful
 * call took (retry backoff and failed attempts excluded) and how many calls
 * it took to get it (1 when the first one worked). */
export type SearchOutcome = {
  results: SearchResponse;
  ms: number;
  attempts: number;
};

export type RetrievalTelemetry = {
  chunks: number;
  files: number;
  /** [SOP key, the fused score AI Search reports on the chunk, the reranker
   * score or null], best first. */
  top: [string, number, number | null][];
  rewrite: boolean;
  /** Did AI Search run something other than the latest message? On the first
   * turn Cloudflare searches the message as typed, so this is a canary that
   * the documented behaviour still holds; on follow-up turns it says whether
   * the query really was rewritten (expected with rewrite on) or the latest
   * message was searched verbatim (expected with rewrite off). */
  rewritten: boolean;
  turns: number;
  attempts: number;
  qlen: number;
  sqlen: number;
  max: number;
  kw: "and" | "or";
  ms: number;
};

/** One line per search, so a change to the vars can be judged from the logs:
 * how many chunks and distinct SOPs came back, which SOPs and at what
 * scores, whether the query was rewritten, the config in force, how many
 * calls it took and how long. Shape only — Workers Logs are enabled and
 * nothing Cortex logs may contain message text, so the query, the rewritten
 * query and chunk text are never included; `qlen`/`sqlen` are lengths and
 * `rewritten` a comparison. */
export function retrievalTelemetry(
  search: SearchOutcome,
  latest: string,
  turns: number,
  cfg: RetrievalConfig
): RetrievalTelemetry {
  const { results, ms, attempts } = search;
  // The same dedupe the SOP cards use, so the logged SOPs and the ones the
  // reader saw can never disagree.
  const best = bestScoreByFile(results.chunks);
  // The reranker score reported for each file's best chunk (the first chunk
  // at that score when a file contributed several).
  const rerank = new Map<string, number | null>();
  for (const chunk of results.chunks) {
    const key = chunk.item?.key;
    if (!key || rerank.has(key)) continue;
    if ((chunk.score ?? 0) !== best.get(key)) continue;
    rerank.set(key, chunk.scoring_details?.reranking_score ?? null);
  }
  const top = [...best.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_FILES)
    .map(([key, score]): [string, number, number | null] => [
      key,
      score,
      rerank.get(key) ?? null
    ]);
  return {
    chunks: results.chunks.length,
    files: best.size,
    top,
    rewrite: cfg.rewrite,
    rewritten: results.search_query.trim() !== latest.trim(),
    turns,
    attempts,
    qlen: latest.length,
    sqlen: results.search_query.length,
    max: cfg.maxResults,
    kw: cfg.keywordMatch,
    ms
  };
}
