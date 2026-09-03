import { DurableObject } from "cloudflare:workers";
import { callable, routeAgentRequest } from "agents";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  type UIMessage
} from "ai";
import { checkPHI, PII_SCREEN_REASON } from "./lib/phi";
import { DEGEN_SNIFF_CHARS, looksDegenerate } from "./lib/degenerate";
import { loadSopMeta, parseSopFile } from "./lib/frontmatter";
import {
  buildPassages,
  buildUserBlock,
  classifyPipelineError,
  isTruncated,
  MAX_MESSAGE_CHARS,
  MAX_OUTPUT_TOKENS,
  rankSops,
  textOf,
  trimHistory,
  windows,
  type FileMeta,
  type GenerationUsage,
  type PipelineStage,
  type SearchChunk,
  type SOPRef,
  type SopStatus,
  type Turn
} from "./lib/pipeline";
import {
  retrievalConfig,
  retrievalTelemetry,
  searchOptions,
  type RetrievalConfig,
  type RetrievalTelemetry,
  type SearchOutcome
} from "./lib/retrieval";
import {
  ANSWER_CUT_SHORT_LINE,
  BUDGET_PAUSED_LINE,
  DEGENERATE_GIVE_UP_LINE,
  messageTooLongLine,
  NO_MATCH_LINE,
  PIPELINE_ERROR_LINES
} from "./lib/copy";
import { SYSTEM_PROMPT } from "./lib/prompt";

// Re-exported for the client, which types its message parts with SOPRef.
export type { SOPRef } from "./lib/pipeline";

const AI_SEARCH_INSTANCE = "cortex";
const GENERATION_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
// Where the id of this conversation's purge schedule is kept between wakes.
const PURGE_SCHEDULE_KEY = "cortex:purge-schedule-id";

// Route Workers AI through the `cortex` AI Gateway for cost/usage analytics and
// the dollar spend limit. Metrics only (collectLog:false) — request/response
// bodies are never stored, matching Cortex's no-content-retention posture. The
// gateway id is a var so it can be renamed/disabled without a code change;
// unset (e.g. local dev) falls back to a direct Workers AI call.
function gatewayOptions(env: Env, step: "screen" | "generation") {
  const id = env.AI_GATEWAY_ID;
  if (!id) return undefined;
  return {
    gateway: {
      id,
      collectLog: false,
      metadata: { app: "cortex", team: "ops", step }
    }
  };
}

// Small fast model that screens messages for patient names the regexes miss.
// Few-shot examples on purpose: llama-3.2-3b without them misclassified
// "My patient, Michael Van Havill" as clean.
const SCREEN_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";
const SCREEN_PROMPT = `You screen internal healthcare ops messages for patient privacy. Answer with exactly one word: yes or no.

Answer yes if the message contains a real personal human name (a first name, last name, or full name) of a patient, or of a patient's family member or caregiver — even when it appears alongside numbers, codes, facility names, or an MRN. A patient, chart, or record number by itself is not a name.

Answer no for everything else, including: names of staff or clinicians (Dr Musto, Taiye), hospital, clinic, university, facility, or company names (UCSF, LabCorp, Valley Radiology, the company Perry Health), system names (Athena; Mindy when it means the Mindspan task system, though "her daughter Mindy" is still a person), product, drug, order, result, protocol, or trial codes (TB006, Kisunla, Leqembi, IQLIK, Cryos), patient, chart, or record numbers (#313, MRN 4471902), and any message with no personal human name.

Examples:
"My patient, John Smith, needs a refill" -> yes
"her husband Robert De Luca called twice" -> yes
"the patient Mary Alvarez is at the desk" -> yes
"#307 Robert Chen wants a callback about his results" -> yes
"her daughter Mindy missed the visit" -> yes
"Dr. Musto faxed the order to LabCorp" -> no
"#313 was on the schedule with Taiye yesterday" -> no
"a caregiver called asking to reschedule an infusion" -> no
"#301 wants their TB006 results sent to the UCSF consulting neurologist" -> no
"check Mindy completion status at T-7" -> no
"Mindy flagged #412 for an infusion check-in" -> no`;

// Sampling per attempt of the fp8 collapse guard: two fresh rolls with the
// production parameters, then one nudged roll to escape a stuck decoding path.
const GENERATION_PARAMS: {
  temperature: number;
  repetition_penalty?: number;
}[] = [
  { temperature: 0.1 },
  { temperature: 0.1 },
  { temperature: 0.35, repetition_penalty: 1.2 }
];

export type CortexMessage = UIMessage<
  {
    refused?: boolean;
    reason?: string | null;
    // `override` is the operator "break glass" flag: set on send to skip the
    // probabilistic name-screen (never the checkPHI hard identifiers).
    override?: boolean;
    // Set on assistant turns that are operator notices (budget, no-match and
    // error lines) rather than answers, so they are never replayed as history.
    notice?: boolean;
  },
  { sops: SOPRef[]; refusal: { reason: string } }
>;

type ChatTurn = { role: "system" | "user" | "assistant"; content: string };

type ConsumeResult =
  | { kind: "degenerate" }
  | {
      kind: "done";
      aborted: boolean;
      text: string;
      usage: GenerationUsage | undefined;
    };

export class ChatAgent extends AIChatAgent<Env> {
  maxPersistedMessages = 100;

  // Incoming messages are persisted BEFORE onChatMessage runs, so this hook is
  // the only thing between raw identifiers and SQLite. Flagged user text is
  // redacted here; onChatMessage then deletes the row entirely.
  protected override sanitizeMessageForPersistence(
    message: UIMessage
  ): UIMessage {
    if (message.role !== "user") return message;
    const { blocked, reason } = checkPHI(textOf(message));
    if (!blocked) return message;
    return {
      ...message,
      parts: [{ type: "text", text: "[withheld]" }],
      metadata: { refused: true, reason }
    };
  }

  // Read-only index for the SOP library view: every object in the bucket
  // with its frontmatter display fields. Approved backend addition for the
  // frontend rebuild (phase 3).
  @callable()
  async listSOPs(): Promise<
    {
      title: string;
      category: string;
      source_url: string | null;
      status: SopStatus | null;
      file: string;
    }[]
  > {
    const listing = await this.env.SOP_BUCKET.list({ limit: 500 });
    const entries = await Promise.all(
      listing.objects.map(async (obj) => {
        try {
          const object = await this.env.SOP_BUCKET.get(obj.key);
          if (!object) return null;
          const meta = parseSopFile(obj.key, await object.text());
          return {
            title: meta.title,
            category: meta.category,
            source_url: meta.source_url,
            status: meta.status,
            file: obj.key
          };
        } catch {
          return null;
        }
      })
    );
    return entries
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      .sort((a, b) => a.title.localeCompare(b.title));
  }

  // Model-based patient-name screen. Called by the client before sending and
  // by onChatMessage as a backstop. The whole message is screened, in
  // overlapping windows run in parallel, so a name in the tail of a long
  // paste is seen. Fail-open: screening must never take the app down, and the
  // regex tripwire still guards the hard identifiers.
  @callable()
  async screenPII(text: string): Promise<{ flagged: boolean }> {
    try {
      const verdicts = await Promise.all(
        windows(text).map(async (window) => {
          const result = (await this.env.AI.run(
            SCREEN_MODEL,
            {
              messages: [
                { role: "system", content: SCREEN_PROMPT },
                { role: "user", content: window }
              ],
              temperature: 0,
              max_tokens: 4
            },
            gatewayOptions(this.env, "screen")
          )) as { response?: string };
          return /\byes\b/i.test(result.response ?? "");
        })
      );
      return { flagged: verdicts.some(Boolean) };
    } catch {
      return { flagged: false };
    }
  }

  // Retention: a daily cron (Durable Object alarm under the hood) purges this
  // conversation once it has had no activity for 7 days. Registered lazily on
  // the first answered turn — not on every start — so a page load that never
  // sends a message leaves no alarm behind; cancelled again after a purge.
  // Cron schedules are idempotent by default, so re-registering is safe.
  private async ensurePurgeSchedule(): Promise<void> {
    const schedule = await this.schedule(
      "0 3 * * *",
      "purgeStaleConversations"
    );
    await this.ctx.storage.put(PURGE_SCHEDULE_KEY, schedule.id);
  }

  private async cancelPurgeSchedule(): Promise<void> {
    const id = await this.ctx.storage.get<string>(PURGE_SCHEDULE_KEY);
    if (!id) return;
    await this.cancelSchedule(id);
    await this.ctx.storage.delete(PURGE_SCHEDULE_KEY);
  }

  async purgeStaleConversations() {
    if (!(await this.waitUntilStable({ timeout: 30_000 }))) return;
    const [row] = this.sql`
      select
        count(*) as total,
        sum(case when created_at > datetime('now', '-7 days') then 1 else 0 end) as recent
      from cf_ai_chat_agent_messages
    `;
    // Still active: keep the schedule and look again tomorrow.
    if (Number(row?.recent ?? 0) > 0) return;
    const total = Number(row?.total ?? 0);
    if (total > 0) {
      this.resetTurnState();
      this.sql`delete from cf_ai_chat_agent_messages`;
      this.messages = [];
      // Built-in bidirectional frame: connected clients reset their state.
      this.broadcast(JSON.stringify({ type: "cf_agent_chat_clear" }));
      console.log(`[cortex] purged ${total} stale message(s)`);
    }
    // Nothing left to retain: stop waking up for this conversation.
    await this.cancelPurgeSchedule();
  }

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const last = this.messages.at(-1);
    if (last?.role === "user") {
      const meta = (last.metadata ?? {}) as {
        refused?: boolean;
        reason?: string | null;
        override?: boolean;
      };
      const live = meta.refused ? null : checkPHI(textOf(last));
      if (meta.refused || live?.blocked) {
        return this.refuse(
          last.id,
          meta.reason ?? live?.reason ?? "an identifier"
        );
      }
      // Backstop name screen for anything that reached the server unscreened.
      // "Break glass": an explicit operator override skips this probabilistic
      // screen only — the checkPHI hard identifiers above are never bypassed.
      if (meta.override) {
        console.log(
          `[cortex] PII name-screen overridden by operator (message ${last.id})`
        );
      } else {
        const { flagged } = await this.screenPII(textOf(last));
        if (flagged) {
          return this.refuse(last.id, PII_SCREEN_REASON);
        }
      }
    }

    await this.ensurePurgeSchedule();

    // The conversation the model sees, sized to its window: empty and notice
    // turns dropped, oldest turns trimmed, the latest message always kept.
    const conversation = trimHistory(
      this.messages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map(
          (m): Turn => ({
            role: m.role as "user" | "assistant",
            content: textOf(m),
            notice:
              (m.metadata as CortexMessage["metadata"] | undefined)?.notice ===
              true
          })
        )
    );
    const latest = conversation.at(-1);
    const tooLong =
      latest?.role === "user" && latest.content.length > MAX_MESSAGE_CHARS;
    const searchMessages: ChatTurn[] = conversation.length
      ? conversation.map(({ role, content }) => ({ role, content }))
      : [{ role: "user", content: "" }];
    // Retrieval settings for this message, read once from the wrangler vars.
    const cfg = retrievalConfig({
      rewrite: this.env.RETRIEVAL_QUERY_REWRITE,
      max: this.env.RETRIEVAL_MAX_RESULTS,
      keyword: this.env.RETRIEVAL_KEYWORD_MATCH
    });

    const stream = createUIMessageStream<CortexMessage>({
      execute: async ({ writer }) => {
        // One id shared by both ends: the client adopts it from this `start`
        // chunk and ai-chat persists under it, so a stopped answer reconciles
        // by id on the next send instead of being duplicated.
        writer.write({ type: "start", messageId: crypto.randomUUID() });
        const textId = crypto.randomUUID();
        let textStarted = false;
        const say = (delta: string) => {
          if (!textStarted) {
            writer.write({ type: "text-start", id: textId });
            textStarted = true;
          }
          writer.write({ type: "text-delta", id: textId, delta });
        };
        // Operator notices are tagged so they are never replayed as history.
        const notice = (line: string) => {
          writer.write({
            type: "message-metadata",
            messageMetadata: { notice: true }
          });
          say(line);
        };
        let stage: PipelineStage = "budget";
        try {
          if (tooLong) {
            notice(messageTooLongLine(MAX_MESSAGE_CHARS));
            return;
          }

          // 0. Monthly budget gate — before any AI spend.
          const budgetStub = this.env.USAGE_BUDGET.get(
            this.env.USAGE_BUDGET.idFromName("global")
          );
          const budget = await budgetStub.consume();
          if (!budget.allowed) {
            notice(BUDGET_PAUSED_LINE);
            return;
          }

          // 1. Retrieval only, via AI Search. The settings, the near-zero
          // thresholds and their rationale, and the telemetry shape all live
          // in lib/retrieval.ts.
          stage = "retrieval";
          const search = await this.searchWithRetry(searchMessages, cfg);
          // Logged before the no-match check below, so a question that
          // retrieved nothing is measured too — that is the case worth
          // watching when the settings change.
          this.logRetrieval(() =>
            retrievalTelemetry(
              search,
              latest?.content ?? "",
              conversation.length,
              cfg
            )
          );
          const chunks = search.results.chunks;

          // Per the answer prompt: nothing retrieved -> fixed line, no model.
          if (chunks.length === 0) {
            notice(NO_MATCH_LINE);
            return;
          }

          // 2. Resolve display fields from R2 frontmatter for every source
          // file, emit the ranked top-5 as the sops cards event.
          stage = "metadata";
          const meta = await this.fileMetaFor(chunks);
          const ranked = rankSops(chunks, meta);
          writer.write({ type: "data-sops", id: "sops", data: ranked });

          // 3. The labelled "SOP passages" block: top SOPs as full documents,
          // then remaining chunks for breadth (see buildPassages).
          const { passages } = buildPassages(ranked, chunks, meta);

          // 4. Generation via Workers AI with the operator's answer prompt,
          // behind the collapse guard.
          stage = "generation";
          const userBlock = buildUserBlock(passages, latest?.content ?? "");
          const genMessages: ChatTurn[] = [
            { role: "system", content: SYSTEM_PROMPT },
            ...conversation
              .slice(0, -1)
              .map(({ role, content }) => ({ role, content })),
            { role: "user", content: userBlock }
          ];
          const outcome = await this.generate(
            genMessages,
            say,
            options?.abortSignal
          );
          if (outcome === "degenerate") {
            notice(DEGENERATE_GIVE_UP_LINE);
            return;
          }
          if (outcome.truncated) say(`\n\n${ANSWER_CUT_SHORT_LINE}`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          // Logged as text (stack or message), never the raw object: a
          // provider error object can carry the request payload.
          console.error(
            "[cortex] answer pipeline failed",
            stage,
            err instanceof Error ? (err.stack ?? message) : message
          );
          notice(PIPELINE_ERROR_LINES[classifyPipelineError(stage, message)]);
        } finally {
          if (textStarted) writer.write({ type: "text-end", id: textId });
        }
      }
    });

    return createUIMessageStreamResponse({ stream });
  }

  // One AI Search call with the retrieval settings stated explicitly, so the
  // instance's own defaults never decide how Cortex searches. AI Search
  // rate-limits bursts (open beta), so retry briefly with backoff; every
  // other failure is rethrown for the pipeline's error classifier.
  private async searchWithRetry(
    messages: ChatTurn[],
    cfg: RetrievalConfig
  ): Promise<SearchOutcome> {
    const instance = this.env.AI_SEARCH.get(AI_SEARCH_INSTANCE);
    for (let attempt = 0; ; attempt++) {
      const startedAt = Date.now();
      try {
        const results = await instance.search({
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

  // Telemetry, never at the answer's expense: a bug in the stats would
  // otherwise land in the pipeline's catch and re-label an answer that was
  // already delivered as an error notice.
  private logRetrieval(build: () => RetrievalTelemetry): void {
    try {
      console.log("[cortex] retrieval", JSON.stringify(build()));
    } catch (err) {
      // Safe to log in full: the throw can only come from our own pure code
      // in lib/retrieval.ts, which never holds message text.
      console.warn(
        "[cortex] retrieval telemetry failed",
        err instanceof Error ? (err.stack ?? err.message) : String(err)
      );
    }
  }

  // Streams one answer into `say`, re-rolling when the opening characters
  // read as the fp8 collapse. Returns "degenerate" once every attempt has
  // collapsed; otherwise whether the answer was stopped or cut off.
  private async generate(
    messages: ChatTurn[],
    say: (delta: string) => void,
    abortSignal?: AbortSignal
  ): Promise<"degenerate" | { aborted: boolean; truncated: boolean }> {
    for (const [attempt, params] of GENERATION_PARAMS.entries()) {
      const sse = (await this.env.AI.run(
        GENERATION_MODEL,
        {
          messages,
          stream: true,
          max_tokens: MAX_OUTPUT_TOKENS,
          ...params
        },
        gatewayOptions(this.env, "generation")
      )) as ReadableStream<Uint8Array>;
      const result = await this.consume(sse, say, abortSignal);
      if (result.kind === "degenerate") {
        console.warn(
          `[cortex] degenerate generation on attempt ${attempt + 1}/${GENERATION_PARAMS.length}, regenerating`
        );
        continue;
      }
      return {
        aborted: result.aborted,
        truncated:
          !result.aborted &&
          isTruncated(result.usage, result.text, MAX_OUTPUT_TOKENS)
      };
    }
    return "degenerate";
  }

  // Reads one Workers AI SSE stream. Text is held back until DEGEN_SNIFF_CHARS
  // have arrived (or the stream ends) and released only if it does not read
  // as collapsed; a collapsed stream is cancelled so nothing reaches the UI.
  private async consume(
    sse: ReadableStream<Uint8Array>,
    say: (delta: string) => void,
    abortSignal?: AbortSignal
  ): Promise<ConsumeResult> {
    const reader = sse.getReader();
    // Cancel promptly on stop, not just at the next read.
    const onAbort = () => {
      void reader.cancel().catch(() => undefined);
    };
    abortSignal?.addEventListener("abort", onAbort, { once: true });
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    let held = "";
    let released = false;
    let usage: GenerationUsage | undefined;
    // Returns true when the held sample reads as collapsed.
    const emit = (delta: string): boolean => {
      text += delta;
      if (released) {
        say(delta);
        return false;
      }
      held += delta;
      if (held.length < DEGEN_SNIFF_CHARS) return false;
      if (looksDegenerate(held)) return true;
      say(held);
      held = "";
      released = true;
      return false;
    };
    try {
      readLoop: while (!abortSignal?.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6).trim();
          if (payload === "[DONE]") break readLoop;
          try {
            const event = JSON.parse(payload) as {
              response?: string;
              usage?: GenerationUsage;
            };
            if (event.usage) usage = event.usage;
            if (event.response && emit(event.response)) {
              await reader.cancel();
              return { kind: "degenerate" };
            }
          } catch {
            // ignore malformed keep-alive lines
          }
        }
      }
    } finally {
      abortSignal?.removeEventListener("abort", onAbort);
    }
    const aborted = abortSignal?.aborted === true;
    if (!released) {
      // The stream ended inside the sniff window: judge what arrived.
      if (!aborted && looksDegenerate(held)) return { kind: "degenerate" };
      if (held) say(held);
    }
    return { kind: "done", aborted, text, usage };
  }

  // Refusal path: the sanitize hook already redacted the stored copy; delete
  // the row outright so the message never survives a reload, then answer with
  // a transient (never-persisted) refusal event. Retrieval is never called.
  private refuse(messageId: string, reason: string): Response {
    this.sql`delete from cf_ai_chat_agent_messages where id = ${messageId}`;
    this.messages = this.messages.filter((m) => m.id !== messageId);
    this.broadcast(
      JSON.stringify({
        type: "cf_agent_chat_messages",
        messages: this.messages
      })
    );
    const stream = createUIMessageStream<CortexMessage>({
      execute: async ({ writer }) => {
        writer.write({
          type: "data-refusal",
          data: { reason },
          transient: true
        });
      }
    });
    return createUIMessageStreamResponse({ stream });
  }

  // Read frontmatter from R2 for every unique source file in the chunk set.
  // AI Search does not surface frontmatter as metadata, so titles, categories,
  // Notion links and the status come straight from the bucket objects. The
  // read itself is loadSopMeta in lib/frontmatter.ts, shared with the eval
  // harness so the two cannot drift; this only dedupes the keys.
  private async fileMetaFor(
    chunks: SearchChunk[]
  ): Promise<Map<string, FileMeta>> {
    return loadSopMeta(this.env.SOP_BUCKET, [
      ...new Set(
        chunks
          .map((chunk) => chunk.item?.key)
          .filter((key): key is string => Boolean(key))
      )
    ]);
  }
}

// Hard monthly spend breaker: one global instance counts answered messages
// per UTC month and refuses once MONTHLY_MESSAGE_BUDGET is reached. Cloudflare
// has no platform-level spend cap, so this is the enforcement layer.
export class UsageBudget extends DurableObject<Env> {
  async consume(): Promise<{ allowed: boolean; used: number; budget: number }> {
    const month = new Date().toISOString().slice(0, 7);
    const sql = this.ctx.storage.sql;
    sql.exec(
      "create table if not exists usage (month text primary key, used integer not null default 0)"
    );
    const budget = Number(this.env.MONTHLY_MESSAGE_BUDGET ?? "2500");
    const row = sql
      .exec("select used from usage where month = ?", month)
      .toArray()[0];
    const used = Number(row?.used ?? 0);
    if (used >= budget) return { allowed: false, used, budget };
    sql.exec(
      "insert into usage (month, used) values (?, 1) on conflict(month) do update set used = used + 1",
      month
    );
    return { allowed: true, used: used + 1, budget };
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
