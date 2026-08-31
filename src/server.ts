import { callable, routeAgentRequest } from "agents";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  type UIMessage
} from "ai";
import matter from "gray-matter";
import { checkPHI } from "./lib/phi";

const SYSTEM_PROMPT =
  "You are Cortex, Mindspan's operations advisor. Answer only from the retrieved SOP content. Rank which SOPs apply, then state the appropriate action step by step. If the SOPs do not cover the situation, say so plainly and name the closest SOP. Never invent procedure steps.";

const AI_SEARCH_INSTANCE = "cortex";
const MAX_SOPS = 5;
const HISTORY_LIMIT = 12;

export type SOPRef = {
  title: string;
  category: string;
  last_edited: string | null;
  source_url: string | null;
  score: number;
};

export type CortexMessage = UIMessage<
  { refused?: boolean; reason?: string | null },
  { sops: SOPRef[]; refusal: { reason: string } }
>;

// Shape of entries in the AI Search SSE "chunks" event (same as search()).
type SearchChunk = {
  id?: string;
  score?: number;
  item?: {
    key?: string;
    timestamp?: number;
    metadata?: Record<string, unknown>;
  };
};

function textOf(message: UIMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

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

  @callable()
  async clearConversation(): Promise<void> {
    this.resetTurnState();
    this.sql`delete from cf_ai_chat_agent_messages`;
    this.messages = [];
    // Built-in bidirectional frame: connected clients reset their local state.
    this.broadcast(JSON.stringify({ type: "cf_agent_chat_clear" }));
  }

  // Retention: a daily cron (Durable Object alarm under the hood) purges this
  // conversation once it has had no activity for 7 days. Cron schedules are
  // idempotent by default, so registering on every start is safe.
  async onStart() {
    const schedule = await this.schedule(
      "0 3 * * *",
      "purgeStaleConversations"
    );
    console.log(
      `[cortex] purge cron registered id=${schedule.id} next=${new Date(schedule.time * 1000).toISOString()}`
    );
  }

  async purgeStaleConversations() {
    if (!(await this.waitUntilStable({ timeout: 30_000 }))) return;
    const [row] = this.sql`
      select
        count(*) as total,
        sum(case when created_at > datetime('now', '-7 days') then 1 else 0 end) as recent
      from cf_ai_chat_agent_messages
    `;
    const total = Number(row?.total ?? 0);
    if (total === 0 || Number(row?.recent ?? 0) > 0) return;
    this.sql`delete from cf_ai_chat_agent_messages`;
    this.messages = [];
    this.broadcast(JSON.stringify({ type: "cf_agent_chat_clear" }));
    console.log(`[cortex] purged ${total} stale message(s)`);
  }

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const last = this.messages.at(-1);
    if (last?.role === "user") {
      const meta = (last.metadata ?? {}) as {
        refused?: boolean;
        reason?: string | null;
      };
      const live = meta.refused ? null : checkPHI(textOf(last));
      if (meta.refused || live?.blocked) {
        return this.refuse(
          last.id,
          meta.reason ?? live?.reason ?? "an identifier"
        );
      }
    }

    const history = [
      { role: "system" as const, content: SYSTEM_PROMPT },
      ...this.messages
        .slice(-HISTORY_LIMIT)
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({
          role: m.role as "user" | "assistant",
          content: textOf(m)
        }))
        .filter((m) => m.content.length > 0)
    ];

    const stream = createUIMessageStream<CortexMessage>({
      execute: async ({ writer }) => {
        const textId = crypto.randomUUID();
        let textStarted = false;
        try {
          // One call returns both: an SSE "chunks" event with the ranked
          // sources first, then OpenAI-style text deltas. The generation
          // model is deliberately omitted — the instance's dashboard config
          // is authoritative. Reranking is requested explicitly because it
          // is off by default at the instance level.
          const sse = await this.env.AI_SEARCH.get(
            AI_SEARCH_INSTANCE
          ).chatCompletions({
            messages: history,
            stream: true,
            // Low thresholds on purpose: the advisor must surface the closest
            // SOPs even for loosely-matching situations (the system prompt
            // handles "not covered" honestly); default 0.4 returns nothing
            // for paraphrased ops scenarios. Reranking is requested
            // explicitly because it is off by default at the instance level.
            ai_search_options: {
              retrieval: { match_threshold: 0.1, max_num_results: 15 },
              reranking: { enabled: true, match_threshold: 0.05 }
            }
          });

          const reader = (sse as ReadableStream<Uint8Array>).getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          let currentEvent = "";

          readLoop: while (true) {
            if (options?.abortSignal?.aborted) {
              await reader.cancel();
              break;
            }
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) {
              if (line.startsWith("event: ")) {
                currentEvent = line.slice(7).trim();
                continue;
              }
              if (!line.startsWith("data: ")) continue;
              const payload = line.slice(6).trim();
              if (payload === "[DONE]") break readLoop;

              if (currentEvent === "chunks") {
                currentEvent = "";
                const sops = await this.buildSops(
                  JSON.parse(payload) as SearchChunk[]
                );
                writer.write({ type: "data-sops", id: "sops", data: sops });
                continue;
              }

              let delta: string | undefined;
              try {
                const parsed = JSON.parse(payload) as {
                  choices?: { delta?: { content?: string } }[];
                };
                delta = parsed.choices?.[0]?.delta?.content;
              } catch {
                continue;
              }
              if (!delta) continue;
              if (!textStarted) {
                writer.write({ type: "text-start", id: textId });
                textStarted = true;
              }
              writer.write({ type: "text-delta", id: textId, delta });
            }
          }
        } catch (err) {
          console.error("[cortex] retrieval failed", err);
          if (!textStarted) {
            writer.write({ type: "text-start", id: textId });
            textStarted = true;
          }
          writer.write({
            type: "text-delta",
            id: textId,
            delta:
              "Retrieval failed — check that the AI Search index has completed syncing, then try again."
          });
        } finally {
          if (textStarted) writer.write({ type: "text-end", id: textId });
        }
      }
    });

    return createUIMessageStreamResponse({ stream });
  }

  // Refusal path: the sanitize hook already redacted the stored copy; delete
  // the row outright so the message never survives a reload, then answer with
  // a transient (never-persisted) refusal event. AI Search is never called.
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

  // Display fields come from the markdown frontmatter in R2 — AI Search does
  // not surface frontmatter as metadata. Dedupe chunks to files, keep each
  // file's best score, cap at MAX_SOPS.
  private async buildSops(chunks: SearchChunk[]): Promise<SOPRef[]> {
    const bestByKey = new Map<string, number>();
    for (const chunk of chunks) {
      const key = chunk.item?.key;
      if (!key) continue;
      const score = chunk.score ?? 0;
      const prev = bestByKey.get(key);
      if (prev === undefined || score > prev) bestByKey.set(key, score);
    }
    const ranked = [...bestByKey.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_SOPS);

    return Promise.all(
      ranked.map(async ([key, score]) => {
        const fallback: SOPRef = {
          title: key,
          category: "uncategorized",
          last_edited: null,
          source_url: null,
          score
        };
        try {
          const object = await this.env.SOP_BUCKET.get(key);
          if (!object) return fallback;
          const fm = matter(await object.text()).data as Record<
            string,
            unknown
          >;
          return {
            title: typeof fm.title === "string" && fm.title ? fm.title : key,
            category:
              typeof fm.category === "string" && fm.category
                ? fm.category
                : "uncategorized",
            last_edited:
              typeof fm.last_edited === "string" ? fm.last_edited : null,
            source_url:
              typeof fm.source_url === "string" ? fm.source_url : null,
            score
          };
        } catch {
          return fallback;
        }
      })
    );
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
