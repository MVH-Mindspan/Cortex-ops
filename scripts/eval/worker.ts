// Throwaway local Worker for the retrieval eval: one POST /search endpoint
// that runs Cortex's retrieval stage exactly as src/server.ts does — the AI
// Search binding with the Worker's own per-request options (lib/retrieval.ts),
// R2 frontmatter through the shared read (lib/frontmatter.ts), then rankSops —
// and reports the shape of what came back.
//
// It exists because `wrangler ai-search search` is not representative: the CLI
// applies the instance's own reranker threshold whatever flags it is given, so
// only the binding can answer questions about the per-request options.
//
// Local only. Never `wrangler deploy` this file (see wrangler.jsonc): it has
// no auth beyond the hostname check below. No answer generation here — a later
// task adds POST /answer.

import { loadSopMeta } from "../../src/lib/frontmatter.ts";
import {
  rankSops,
  sectionOf,
  stripFrontmatter,
  type SearchResponse
} from "../../src/lib/pipeline.ts";
import {
  retrievalConfig,
  searchOptions,
  type RetrievalConfig,
  type SearchOutcome
} from "../../src/lib/retrieval.ts";

type EvalEnv = Pick<Env, "AI" | "AI_SEARCH" | "SOP_BUCKET" | "AI_GATEWAY_ID">;

// The same instance production searches, so the corpus and the index settings
// under test are the real ones.
const AI_SEARCH_INSTANCE = "cortex";

// `hostname` keeps the brackets for an IPv6 literal, so `[::1]` is the form to
// compare against — some clients resolve "localhost" to ::1.
const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

type EvalRequest = {
  messages: { role: "user" | "assistant"; content: string }[];
  config?: { rewrite?: string; max?: string; keyword?: string };
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

// The same retry the server uses (ChatAgent.searchWithRetry): AI Search
// rate-limits bursts while it is in open beta, and a matrix run is a burst by
// definition. Everything else is rethrown, so a real failure still surfaces.
// SearchOutcome is the server's own type, so the timing the harness reports
// means the same thing as the timing the Worker logs.
async function searchWithRetry(
  env: EvalEnv,
  messages: EvalRequest["messages"],
  cfg: RetrievalConfig
): Promise<SearchOutcome> {
  const instance = env.AI_SEARCH.get(AI_SEARCH_INSTANCE);
  for (let attempt = 0; ; attempt++) {
    const startedAt = Date.now();
    try {
      const results: SearchResponse = await instance.search({
        messages,
        ai_search_options: searchOptions(cfg)
      });
      // The successful call only: retry backoff is not search latency.
      return { results, ms: Date.now() - startedAt, attempts: attempt + 1 };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (attempt < 2 && /rate.?limit/i.test(message)) {
        await new Promise((resolve) =>
          setTimeout(resolve, 1500 * (attempt + 1))
        );
        continue;
      }
      throw err;
    }
  }
}

export default {
  async fetch(request: Request, env: EvalEnv): Promise<Response> {
    const url = new URL(request.url);
    // Belt and braces against an accidental deploy: off localhost this Worker
    // is a 404 and nothing else.
    if (!LOCAL_HOSTS.includes(url.hostname)) {
      return new Response("Not found", { status: 404 });
    }
    if (request.method !== "POST" || url.pathname !== "/search") {
      return new Response("Not found", { status: 404 });
    }
    try {
      const body = (await request.json()) as EvalRequest;
      const cfg = retrievalConfig(body.config ?? {});
      const { results, ms, attempts } = await searchWithRetry(
        env,
        body.messages,
        cfg
      );
      // The one shared R2 read, so the harness and the Worker resolve titles
      // and statuses identically.
      const meta = await loadSopMeta(env.SOP_BUCKET, [
        ...new Set(
          results.chunks
            .map((chunk) => chunk.item?.key)
            .filter((key): key is string => Boolean(key))
        )
      ]);
      const ranked = rankSops(results.chunks, meta);
      return json({
        search_query: results.search_query,
        ms,
        // 1 unless a rate limit forced a retry, in which case `ms` is the
        // successful call and the wall-clock was longer.
        attempts,
        config: cfg,
        // Scores and section headings only. Chunk text never leaves this
        // Worker: an eval report is committed to a public repo.
        chunks: results.chunks.map((chunk) => ({
          key: chunk.item?.key ?? null,
          score: chunk.score ?? null,
          scoring_details: chunk.scoring_details ?? null,
          section: sectionOf(stripFrontmatter(chunk.text ?? ""))
        })),
        ranked: ranked.map(({ file, title, score, status }) => ({
          file,
          title,
          score,
          status: status ?? null
        }))
      });
    } catch (err) {
      // Message only: a provider error object can carry the request payload.
      const message = err instanceof Error ? err.message : String(err);
      return json({ error: message }, 500);
    }
  }
};
