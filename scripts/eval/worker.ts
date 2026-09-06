import { AnswerStream } from "../../src/lib/answer-stream.ts";
import { generateAnswer, GENERATION_MODEL } from "../../src/lib/generation.ts";
import {
  buildPassages,
  buildUserBlock,
  generationHistory,
  trimHistory
} from "../../src/lib/pipeline.ts";
import { selectRules, renderRulesBlock } from "../../src/lib/rules.ts";
import { SYSTEM_PROMPT } from "../../src/lib/prompt.ts";
import {
  ANSWER_CUT_SHORT_LINE,
  DEGENERATE_GIVE_UP_LINE,
  NO_MATCH_LINE
} from "../../src/lib/copy.ts";
import type { CoverageMetadata } from "../../src/lib/coverage-gate";
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
  rules?: boolean;
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
    if (
      request.method !== "POST" ||
      !["/search", "/answer"].includes(url.pathname)
    ) {
      return new Response("Not found", { status: 404 });
    }
    try {
      const body = (await request.json()) as EvalRequest;
      if (
        !Array.isArray(body.messages) ||
        !body.messages.length ||
        body.messages.some(
          (m) =>
            !["user", "assistant"].includes(m.role) ||
            typeof m.content !== "string"
        ) ||
        body.messages.at(-1)?.role !== "user" ||
        (body.messages.at(-1)?.content.length ?? 0) > 8000
      )
        return json({ error: "Invalid eval messages" }, 400);
      const answering = url.pathname === "/answer";
      const cfg = retrievalConfig(
        body.config ??
          (answering ? { rewrite: "on", max: "30", keyword: "and" } : {})
      );
      const conversation = answering
        ? trimHistory(body.messages)
        : body.messages;
      const { results, ms, attempts } = await searchWithRetry(
        env,
        conversation,
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
      if (answering) {
        if (!results.chunks.length)
          return json({
            answer: NO_MATCH_LINE,
            raw: "",
            notice: true,
            ranked,
            metadata: null,
            stats: {},
            rules: [],
            passages: []
          });
        const { passages, entries } = buildPassages(
          ranked,
          results.chunks,
          meta
        );
        const rules = body.rules === false ? [] : selectRules(entries);
        let answer = "";
        let metadata: CoverageMetadata | null = null;
        let sources = ranked;
        const sink = new AnswerStream({
          ctx: {
            labels: entries.map((e) => ({ label: e.label, file: e.file })),
            sops: ranked,
            meta
          },
          emit: (text) => {
            answer += text;
          },
          metadata: (data) => {
            metadata = data;
          },
          sources: (data) => {
            sources = data;
          },
          isAborted: () => request.signal.aborted
        });
        const outcome = await generateAnswer(
          [
            { role: "system", content: SYSTEM_PROMPT },
            ...generationHistory(conversation.slice(0, -1)),
            {
              role: "user",
              content: buildUserBlock(
                passages,
                conversation.at(-1)?.content ?? "",
                renderRulesBlock(rules)
              )
            }
          ],
          sink,
          async (input) =>
            (await env.AI.run(
              GENERATION_MODEL,
              input,
              env.AI_GATEWAY_ID
                ? {
                    gateway: {
                      id: env.AI_GATEWAY_ID,
                      collectLog: false,
                      metadata: { app: "cortex", team: "ops", step: "eval" }
                    }
                  }
                : undefined
            )) as ReadableStream<Uint8Array>,
          request.signal
        );
        if (outcome.degenerate) answer = DEGENERATE_GIVE_UP_LINE;
        else {
          sink.finish();
          if (outcome.truncated && !sink.decision?.coverageBlocked)
            answer += `\n\n${ANSWER_CUT_SHORT_LINE}`;
        }
        // Local-only response. The runner keeps content under .context and
        // writes only aggregate counts to public docs/eval reports.
        return json({
          answer,
          raw: sink.raw,
          metadata,
          ranked: sources,
          stats: sink.stats(),
          rules,
          passages: entries,
          outcome,
          citations: sink.repair?.cited ?? [],
          ms
        });
      }
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
