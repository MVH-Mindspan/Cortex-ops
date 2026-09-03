// Pure helpers for the answer pipeline: ranking retrieved chunks into SOP
// cards, building the labelled passages block, sizing the conversation to the
// generation model's context window, windowing text for the name screen, and
// classifying provider errors. No Workers bindings, no side effects — the
// Durable Object in server.ts is a thin wrapper around these so they can be
// unit-tested with node:test.

export const MAX_SOPS = 5;
// Top-ranked SOPs go into context as complete documents (not chunks) so the
// model can quote every sub-step and click path a first-timer needs.
export const FULL_DOC_COUNT = 3;
// Rough character budget for the SOP passages block (~8k tokens).
export const PASSAGE_CHAR_BUDGET = 27_500;

// The generation model (llama-3.3-70b fp8-fast) has a 24k-token window shared
// by the system prompt (SYSTEM_PROMPT_MAX_CHARS in prompt.ts: the answer
// rules plus the team structure, ≤18.8k chars), the passages (≤27.5k chars),
// the prior turns (≤12k chars), the latest message (≤8k chars) and the
// answer. At ~3.5 chars per token that is 66.3k chars ≈ 18.9k tokens, plus
// MAX_OUTPUT_TOKENS and a reserve for the chat template and the passage
// labels (Notion URLs tokenize poorly): 23.9k of 24k. prompt.test.ts asserts
// the inequality. A collapse retry re-sends the whole prompt up to 3 times.
export const CONTEXT_WINDOW_TOKENS = 24_000;
export const CHARS_PER_TOKEN = 3.5;
export const WINDOW_RESERVE_TOKENS = 2_000;
export const HISTORY_MAX_MESSAGES = 12;
export const HISTORY_CHAR_BUDGET = 12_000;
export const MAX_MESSAGE_CHARS = 8_000;
export const MAX_OUTPUT_TOKENS = 3_000;

// The name screen reads the whole message in overlapping windows so a name in
// the tail of a long paste is seen (the model call is cheap; the cap above
// bounds the number of windows).
export const SCREEN_WINDOW_CHARS = 2_000;
export const SCREEN_WINDOW_OVERLAP = 200;

// The review state of a SOP, normalised from the frontmatter label (or, for
// files exported before the status key existed, from the title suffix) in
// frontmatter.ts — the only place that mapping happens.
export type SopStatus = "draft" | "review" | "approved";

// The one draft-suffix rule, e.g. "… (DRAFT — Needs Review)": the export's
// title convention. Case-sensitive on purpose — a lowercase "(draft)" in a
// title is prose, not a status. statusKind (frontmatter.ts) reads it as the
// fallback when there is no status key; cardTitle (linkify.ts) strips it for
// display. Both must agree, so the pattern lives in this import-free leaf.
export const DRAFT_TITLE_RE = /\((?:DRAFT|Draft)\b[^)]*\)\s*$/;

export type SOPRef = {
  title: string;
  category: string;
  last_edited: string | null;
  source_url: string | null;
  score: number;
  /** R2 object key, e.g. "appointment-scheduling.md" — lets the client
   * linkify filename mentions too. Optional: absent on older stored turns. */
  file?: string;
  /** Drives the "Draft" chip on the card. Optional: absent on older stored
   * turns and on SOPs with no status at all. */
  status?: SopStatus;
};

export type SearchChunk = {
  id?: string;
  score?: number;
  text?: string;
  item?: {
    key?: string;
    timestamp?: number;
    metadata?: Record<string, unknown>;
  };
  /** Per-chunk scores AI Search returns alongside the fused score (see
   * env.d.ts AiSearchSearchResponse). */
  scoring_details?: {
    keyword_score?: number;
    vector_score?: number;
    keyword_rank?: number;
    vector_rank?: number;
    reranking_score?: number;
  };
};

/** What AI_SEARCH.search() returns: the query it actually ran (rewritten on
 * follow-up turns) and the chunks. */
export type SearchResponse = { search_query: string; chunks: SearchChunk[] };

export type FileMeta = {
  title: string;
  category: string;
  last_edited: string | null;
  source_url: string | null;
  /** Review state, or null when the SOP carries none. */
  status: SopStatus | null;
  /** The Notion "Use When (Agent Hints)" text: written by the export and
   * indexed by AI Search; not read by the Worker yet. */
  use_when: string | null;
  /** Frontmatter-stripped markdown body, for full-document passages. */
  text: string;
};

export type Turn = {
  role: "user" | "assistant";
  content: string;
  /** Operator notices (budget, no-match, error lines) are not conversation. */
  notice?: boolean;
};

export type PipelineStage = "budget" | "retrieval" | "metadata" | "generation";

export type PipelineErrorKind =
  | "allocation"
  | "spend-limit"
  | "context-overflow"
  | "rate-limit"
  | "retrieval"
  | "generation";

export type GenerationUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
};

type TextPart = { type: string; text?: string };

export function textOf(message: { parts: ReadonlyArray<TextPart> }): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n")
    .trim();
}

// Best-effort section label: the first markdown heading in the passage.
export function sectionOf(chunkText: string): string | null {
  const heading = chunkText.match(/^#{1,6}\s+(.+)$/m);
  return heading ? heading[1].trim() : null;
}

// Dedupe chunks to files, keep each file's best score, cap at MAX_SOPS.
export function rankSops(
  chunks: SearchChunk[],
  meta: Map<string, FileMeta>
): SOPRef[] {
  const bestByKey = new Map<string, number>();
  for (const chunk of chunks) {
    const key = chunk.item?.key;
    if (!key) continue;
    const score = chunk.score ?? 0;
    const prev = bestByKey.get(key);
    if (prev === undefined || score > prev) bestByKey.set(key, score);
  }
  return [...bestByKey.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_SOPS)
    .map(([key, score]) => {
      const m = meta.get(key);
      return {
        title: m?.title ?? key,
        category: m?.category ?? "uncategorized",
        last_edited: m?.last_edited ?? null,
        source_url: m?.source_url ?? null,
        score,
        file: key,
        // Omitted rather than null when there is no status, so a stored turn
        // written before status existed stays shape-identical.
        ...(m?.status ? { status: m.status } : {})
      };
    });
}

// AI Search indexes each object with its YAML frontmatter, so chunk 1 of a
// file starts with the `---` block. Strip it from chunk passages: the model
// must never see source_url (a link it could retype), status, or the agent
// hints, none of which are SOP content. Full documents come from meta.text,
// which gray-matter already separated. The lookahead requires `title:`
// right after the opening `---` so a chunk that starts on a Notion divider
// is never treated as frontmatter: every export, legacy and new, writes
// `title:` as the first frontmatter key (matter.stringify keeps object key
// order), and a body line never starts with `title:`.
const FRONTMATTER_RE = /^---\r?\n(?=title:)[\s\S]*?\r?\n---(?:\r?\n|$)/;
export function stripFrontmatter(text: string): string {
  return text.replace(FRONTMATTER_RE, "");
}

// The labelled "SOP passages" block. The top-ranked SOPs go in as FULL
// documents so every sub-step, click path and field name is available to
// quote — chunks alone make thin steps. Remaining chunks follow for breadth.
// Titles and Notion links only, never filenames.
export function buildPassages(
  ranked: SOPRef[],
  chunks: SearchChunk[],
  meta: Map<string, FileMeta>,
  opts: { fullDocCount?: number; charBudget?: number } = {}
): { passages: string[]; used: number } {
  const fullDocCount = opts.fullDocCount ?? FULL_DOC_COUNT;
  const charBudget = opts.charBudget ?? PASSAGE_CHAR_BUDGET;
  let used = 0;
  let label = 0;
  const passages: string[] = [];
  const fullDocFiles = new Set<string>();
  for (const sop of ranked.slice(0, fullDocCount)) {
    if (!sop.file) continue;
    const m = meta.get(sop.file);
    const body = m?.text.trim();
    if (!m || !body) continue;
    if (used + body.length > charBudget) break;
    used += body.length;
    fullDocFiles.add(sop.file);
    label += 1;
    passages.push(
      `[${label}] ${m.title} | full document | ${m.source_url ?? "no link"}\n${body}`
    );
  }
  for (const chunk of chunks) {
    const key = chunk.item?.key;
    if (key && fullDocFiles.has(key)) continue;
    const text = stripFrontmatter((chunk.text ?? "").trim()).trim();
    if (!text) continue;
    if (used + text.length > charBudget) break;
    used += text.length;
    const m = key ? meta.get(key) : undefined;
    const section = sectionOf(text);
    label += 1;
    passages.push(
      `[${label}] ${m?.title ?? "Untitled SOP"}${section ? ` | ${section}` : ""} | ${m?.source_url ?? "no link"}\n${text}`
    );
  }
  return { passages, used };
}

// The user turn sent to the generation model: the labelled passages, then the
// team member's message. One place, so the eval harness sends the same bytes
// as the Worker.
export function buildUserBlock(passages: string[], message: string): string {
  return `SOP passages\n\n${passages.join("\n\n")}\n\nTeam member's message:\n\n${message}`;
}

// Size the conversation to the model window: drop empty and notice turns,
// always keep the latest turn, then walk backwards adding whole prior turns
// until the count cap or the character budget for prior turns is reached.
export function trimHistory(
  turns: Turn[],
  opts: { maxMessages?: number; charBudget?: number } = {}
): Turn[] {
  const maxMessages = opts.maxMessages ?? HISTORY_MAX_MESSAGES;
  const charBudget = opts.charBudget ?? HISTORY_CHAR_BUDGET;
  const usable = turns.filter(
    (turn) => !turn.notice && turn.content.trim().length > 0
  );
  if (usable.length === 0) return [];
  const out: Turn[] = [usable[usable.length - 1]];
  let used = 0;
  for (let i = usable.length - 2; i >= 0; i--) {
    const turn = usable[i];
    if (out.length >= maxMessages) break;
    if (used + turn.content.length > charBudget) break;
    used += turn.content.length;
    out.unshift(turn);
  }
  return out;
}

// Overlapping windows that together cover the whole text.
export function windows(
  text: string,
  size = SCREEN_WINDOW_CHARS,
  overlap = SCREEN_WINDOW_OVERLAP
): string[] {
  if (text.length <= size) return [text];
  const out: string[] = [];
  let start = 0;
  for (;;) {
    const end = Math.min(start + size, text.length);
    out.push(text.slice(start, end));
    if (end >= text.length) break;
    start = end - overlap;
  }
  return out;
}

// Map a provider error to the operator-facing line to show. Ordered from the
// most specific signal to the stage-generic fallback.
export function classifyPipelineError(
  stage: PipelineStage,
  message: string
): PipelineErrorKind {
  if (/allocation.?exceeded|7094/i.test(message)) return "allocation";
  if (/budget|spend.?limit|cost.?limit/i.test(message)) return "spend-limit";
  if (
    /5021|context.?window|context length|too many tokens|maximum context/i.test(
      message
    )
  ) {
    return "context-overflow";
  }
  if (/rate.?limit|429/i.test(message)) return "rate-limit";
  return stage === "generation" ? "generation" : "retrieval";
}

// Was the answer cut off at max_tokens? Prefer the provider's token count
// (Workers AI reports usage on the final SSE event); without it, fall back to
// the answer format itself: both formats must end with "Not covered by the
// SOPs", so an answer without that section stopped early.
export function isTruncated(
  usage: GenerationUsage | null | undefined,
  text: string,
  maxTokens: number
): boolean {
  if (typeof usage?.completion_tokens === "number") {
    return usage.completion_tokens >= maxTokens;
  }
  if (!text.trim()) return false;
  return !/not covered by the sops/i.test(text);
}
