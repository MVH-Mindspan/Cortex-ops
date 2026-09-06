// Only the opening declaration is buffered. No generated text may reach the
// downstream citation holder until coverage is known. A failed declaration
// never becomes "full", including on end(), error cleanup, or retry.
import type { Coverage } from "./coverage";

export const COVERAGE_PREFIX_MAX_CHARS = 256;
export type CoverageMetadata = {
  coverage: Coverage;
  coverageBlocked?: "none" | "unconfirmed";
};
export type CoverageDecision = CoverageMetadata & {
  reason: "none" | "missing" | "invalid" | null;
};

const DECLARATION =
  /^[ \t]*(\*\*|__)?[ \t]*coverage[ \t]*[:–—-][ \t]*(full|partial|none)(?![a-z0-9])\.?[ \t]*(\*\*|__)?[ \t]*/i;
const BODY_HEADING = /^(?:Situation|Answer|Who handles this)[ \t]*:/i;

export class CoverageGate {
  private pending = "";
  decision: CoverageDecision | null = null;
  private readonly emit: (text: string) => void;
  private readonly decide: (decision: CoverageDecision) => void;
  private readonly isAborted: () => boolean;

  constructor(
    emit: (text: string) => void,
    decide: (decision: CoverageDecision) => void,
    isAborted: () => boolean
  ) {
    this.emit = emit;
    this.decide = decide;
    this.isAborted = isAborted;
  }

  reset(): void {
    this.pending = "";
    this.decision = null;
  }

  push(delta: string): void {
    if (this.isAborted()) return;
    if (this.decision) {
      if (!this.decision.coverageBlocked && delta) this.emit(delta);
      return;
    }
    // Inspect at most the bounded declaration, even if the provider gives us
    // a complete answer in one delta. The body is forwarded only after decide.
    for (let i = 0; i < delta.length; i++) {
      this.pending += delta[i];
      this.inspect(false);
      if (this.decision) {
        this.push(delta.slice(i + 1));
        return;
      }
      if (this.pending.length >= COVERAGE_PREFIX_MAX_CHARS) {
        this.block("invalid");
        return;
      }
    }
  }

  end(): void {
    if (this.isAborted() || this.decision) return;
    this.inspect(true);
  }

  private block(reason: "missing" | "invalid"): void {
    this.pending = "";
    this.decision = {
      coverage: "none",
      coverageBlocked: "unconfirmed",
      reason
    };
    this.decide(this.decision);
  }

  private inspect(final: boolean): void {
    const start = this.pending.search(/\S/);
    if (start < 0) {
      if (final) this.block("missing");
      return;
    }
    const lineEnd = this.pending.indexOf("\n", start);
    const line = this.pending
      .slice(start, lineEnd < 0 ? undefined : lineEnd)
      .replace(/\r$/, "");
    const match = DECLARATION.exec(line);
    const rest = match ? line.slice(match[0].length) : "";
    const sameLine = BODY_HEADING.test(rest);
    // Wait for a line boundary, end of stream, or a recognized body heading.
    // In particular "Coverage: full" alone could still become "fuller".
    if (lineEnd < 0 && !final && !sameLine) return;
    if (!match || match[1] !== match[3] || (rest && !sameLine)) {
      this.block(/coverage/i.test(line) ? "invalid" : "missing");
      return;
    }
    const coverage = match[2].toLowerCase() as Coverage;
    this.decision = {
      coverage,
      ...(coverage === "none" ? { coverageBlocked: "none" as const } : {}),
      reason: coverage === "none" ? "none" : null
    };
    this.pending = "";
    this.decide(this.decision);
    if (coverage !== "none" && rest) this.emit(rest);
  }
}
