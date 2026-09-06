// Shared by the chat Worker and local eval: only this adapter may forward
// generated text. Suppression happens before TailHold, so raw-tail cleanup
// cannot accidentally publish a blocked answer.
import {
  CoverageGate,
  type CoverageDecision,
  type CoverageMetadata
} from "./coverage-gate.ts";
import { countGaps, countSteps } from "./coverage.ts";
import { TailHold } from "./tail.ts";
import {
  repairCitations,
  markCited,
  type CitationContext,
  type RepairResult
} from "./citations.ts";
import { COVERAGE_NONE_LINE, COVERAGE_UNCONFIRMED_LINE } from "./copy.ts";
import type { SOPRef } from "./pipeline";

export class AnswerStream {
  readonly gate: CoverageGate;
  private readonly tail: TailHold;
  private readonly ctx: CitationContext;
  private readonly emit: (text: string) => void;
  private readonly isAborted: () => boolean;
  private readonly sources: (sops: SOPRef[]) => void;
  private finished = false;
  raw = "";
  delivered = "";
  repair: RepairResult | null = null;

  constructor(options: {
    ctx: CitationContext;
    emit: (text: string) => void;
    metadata: (metadata: CoverageMetadata) => void;
    sources: (sops: SOPRef[]) => void;
    isAborted: () => boolean;
  }) {
    this.ctx = options.ctx;
    this.sources = options.sources;
    this.isAborted = options.isAborted;
    this.emit = (text) => {
      if (!text || this.isAborted()) return;
      this.delivered += text;
      options.emit(text);
    };
    this.tail = new TailHold(this.emit, this.isAborted);
    this.gate = new CoverageGate(
      (text) => this.tail.push(text),
      (decision) => {
        const { coverage, coverageBlocked } = decision;
        options.metadata({
          coverage,
          ...(coverageBlocked ? { coverageBlocked } : {})
        });
        if (coverageBlocked) {
          this.sources(markCited(this.ctx.sops, []));
          this.emit(
            coverageBlocked === "none"
              ? COVERAGE_NONE_LINE
              : COVERAGE_UNCONFIRMED_LINE
          );
        }
      },
      this.isAborted
    );
  }

  reset(): void {
    this.gate.reset();
    this.tail.reset();
    this.finished = false;
    this.raw = "";
    this.delivered = "";
    this.repair = null;
  }
  push(delta: string): void {
    if (this.finished || this.isAborted()) return;
    this.raw += delta;
    this.gate.push(delta);
  }
  finish(): void {
    if (this.finished) return;
    this.finished = true;
    if (this.isAborted()) return;
    this.gate.end();
    if (this.gate.decision?.coverageBlocked) return;
    const tail = this.tail.end();
    if (tail === null) return;
    try {
      this.repair = repairCitations(tail, this.ctx);
    } catch {
      /* Raw fallback is allowed only for an admitted answer. */
    }
    this.emit(this.repair?.text ?? tail);
    if (this.repair) this.sources(markCited(this.ctx.sops, this.repair.cited));
  }
  // A provider failure retains already-admitted text, then the caller emits
  // its normal error notice. It cannot trigger a missing-header fallback.
  fail(): void {
    if (this.finished) return;
    this.finished = true;
    if (
      this.isAborted() ||
      !this.gate.decision ||
      this.gate.decision.coverageBlocked
    )
      return;
    const tail = this.tail.end();
    if (tail) this.emit(tail);
  }
  get decision(): CoverageDecision | null {
    return this.gate.decision;
  }
  stats() {
    return {
      coverage: this.decision?.coverage ?? null,
      coverage_line: Boolean(
        this.decision &&
        this.decision.reason !== "missing" &&
        this.decision.reason !== "invalid"
      ),
      suppression: this.decision?.reason ?? null,
      generated_steps: countSteps(this.raw),
      delivered_steps: countSteps(this.delivered),
      generated_gaps: countGaps(this.raw),
      delivered_gaps: countGaps(this.delivered),
      generated_chars: this.raw.length,
      delivered_chars: this.delivered.length,
      coverage_none_with_steps:
        this.decision?.reason === "none" && countSteps(this.raw) > 0,
      citations: this.repair?.stats ?? null
    };
  }
}
