// Shared production/evaluation generation path. The collapse guard examines
// each attempt before the coverage gate receives anything. No content logging.
import { DEGEN_SNIFF_CHARS, looksDegenerate } from "./degenerate.ts";
import {
  isTruncated,
  MAX_OUTPUT_TOKENS,
  type GenerationUsage
} from "./pipeline.ts";
export const GENERATION_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
export type ChatTurn = {
  role: "system" | "user" | "assistant";
  content: string;
};
export type GenerationInput = {
  messages: ChatTurn[];
  stream: true;
  max_tokens: number;
  temperature: number;
  repetition_penalty?: number;
};
export type GenerationSink = { reset(): void; push(text: string): void };
export const GENERATION_PARAMS: {
  temperature: number;
  repetition_penalty?: number;
}[] = [
  { temperature: 0.1 },
  { temperature: 0.1 },
  { temperature: 0.35, repetition_penalty: 1.2 }
];

export type ConsumeResult =
  | { kind: "degenerate" }
  | {
      kind: "done";
      aborted: boolean;
      text: string;
      usage: GenerationUsage | undefined;
    };

export async function consumeGeneration(
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

export async function generateAnswer(
  messages: ChatTurn[],
  sink: GenerationSink,
  run: (input: GenerationInput) => Promise<ReadableStream<Uint8Array>>,
  abortSignal?: AbortSignal
): Promise<{
  degenerate: boolean;
  aborted: boolean;
  truncated: boolean;
  attempt: number;
  usage?: GenerationUsage;
}> {
  for (const [attempt, params] of GENERATION_PARAMS.entries()) {
    if (abortSignal?.aborted)
      return { degenerate: false, aborted: true, truncated: false, attempt };
    sink.reset();
    const sse = await run({
      messages,
      stream: true,
      max_tokens: MAX_OUTPUT_TOKENS,
      ...params
    });
    const result = await consumeGeneration(
      sse,
      (text) => sink.push(text),
      abortSignal
    );
    if (result.kind === "degenerate") continue;
    return {
      degenerate: false,
      aborted: result.aborted,
      truncated:
        !result.aborted &&
        isTruncated(result.usage, result.text, MAX_OUTPUT_TOKENS),
      attempt: attempt + 1,
      usage: result.usage
    };
  }
  return {
    degenerate: true,
    aborted: false,
    truncated: false,
    attempt: GENERATION_PARAMS.length
  };
}
