// Message blocks shared by the conversation and the how-to guide: the user
// bubble, the assistant answer, and the SOP cards under it, plus the small
// chips and helpers they use. Moved here unchanged from app.tsx so the guide
// can replay a transcript through the same components a real answer uses.

import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Streamdown } from "streamdown";
import { normalizeAnswerMarkdown } from "@/lib/markdown";
import { cardTitle, displayTitle, linkifySOPs, reasonFor } from "@/lib/linkify";
import type { SOPRef, SopStatus } from "@/lib/pipeline";
import {
  COPY_ANSWER,
  COPY_DONE,
  COPY_FAILED,
  COVERAGE_PARTIAL_LINE,
  DRAFT_BADGE,
  DRAFT_BADGE_TITLE,
  HINT_FIRST_PIN,
  SOP_CARDS_HEADING,
  SOP_CARDS_HEADING_RELATED,
  SOP_CITED_BADGE
} from "@/lib/copy";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { PinIcon } from "@/components/icons";
import type { CortexMessage } from "@/server";

// Stable identity: an inline object would defeat the memoized answer block.
export const STREAMDOWN_ANIMATION = {
  animation: "fadeIn",
  sep: "word",
  duration: 250,
  stagger: 12
} as const;

export type PinnedSOP = {
  title: string;
  source_url: string | null;
  file?: string;
  // Absent on pins stored before draft status existed.
  status?: SopStatus | null;
};

export function pinKey(pin: { title: string; file?: string }): string {
  return pin.file ?? pin.title;
}

export function sopsOf(message: CortexMessage): SOPRef[] | null {
  for (const part of message.parts) {
    if (part.type === "data-sops") return part.data as SOPRef[];
  }
  return null;
}

export function textOf(message: CortexMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

export function isRenderable(message: CortexMessage): boolean {
  if (message.role === "user") return textOf(message).trim().length > 0;
  return sopsOf(message) !== null || textOf(message).trim().length > 0;
}

// Shown on an SOP whose frontmatter status is "draft", beside the title on
// cards, library rows and pinned rows. Deliberately muted — amber is the PII
// and budget warnings' colour, and a draft is not a warning. `shrink-0` keeps
// the chip whole wherever it lands: on a card the title truncates beside it,
// and on a pinned or library row the title is flex-1, so the chip sits at the
// right edge next to the pin button.
export function DraftChip() {
  return (
    <span
      title={DRAFT_BADGE_TITLE}
      className="shrink-0 rounded-[4px] border px-1.5 py-0.5 text-[12px] leading-none text-muted-foreground"
    >
      {DRAFT_BADGE}
    </span>
  );
}

// Shown on a card the answer actually quoted (set by the citation repair, so
// it means "checked against this SOP's own text", not merely "retrieved").
// Blue, the link colour: this card carries the sentence the answer rests on.
export function CitedChip() {
  return (
    <span className="shrink-0 rounded-[4px] border px-1.5 py-0.5 text-[12px] leading-none text-brand-blue">
      {SOP_CITED_BADGE}
    </span>
  );
}

// A draft SOP wears the word twice otherwise: once in the chip, once in the
// title suffix the chip is derived from.
export function titleFor(sop: {
  title: string;
  status?: SopStatus | null;
}): string {
  return sop.status === "draft"
    ? cardTitle(sop.title)
    : displayTitle(sop.title);
}

// Pin toggle with a small "stamp" on pin (scale/rotate decelerating to rest).
// The icon is remounted via key so the animation retriggers; `stamped` stays
// false until the first interaction so history replays mount silently. Unpin
// never animates — removal is instant.
export function PinButton({
  isPinned,
  onToggle,
  iconClass = "h-4 w-4",
  className
}: {
  isPinned: boolean;
  onToggle: () => void;
  iconClass?: string;
  className?: string;
}) {
  const [stamped, setStamped] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        if (!isPinned) setStamped(true);
        onToggle();
      }}
      aria-label={isPinned ? "Unpin SOP" : "Pin SOP"}
      aria-pressed={isPinned}
      className={cn(
        "pressable",
        isPinned
          ? "text-brand-orange"
          : "text-muted-foreground hover:text-foreground",
        className
      )}
    >
      <PinIcon
        key={isPinned ? "pinned" : "unpinned"}
        className={cn(iconClass, isPinned && stamped && "animate-pin-stamp")}
      />
    </button>
  );
}

// End-of-answer action: operators relay answers into Slack threads and call
// notes. Copies the raw answer text — Notion links are already inline and the
// text contains no identifiers by construction.
export function CopyAnswerButton({ text }: { text: string }) {
  const [state, setState] = useState<"idle" | "done" | "failed">("idle");
  const revertRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (revertRef.current) clearTimeout(revertRef.current);
    },
    []
  );
  return (
    <div className="animate-rise-in">
      <button
        type="button"
        aria-label="Copy answer to clipboard"
        onClick={() => {
          navigator.clipboard.writeText(text).then(
            () => {
              setState("done");
              if (revertRef.current) clearTimeout(revertRef.current);
              revertRef.current = setTimeout(() => setState("idle"), 2000);
            },
            () => setState("failed")
          );
        }}
        className="text-[13px] font-medium text-muted-foreground hover:text-foreground"
      >
        {state === "idle"
          ? COPY_ANSWER
          : state === "done"
            ? COPY_DONE
            : COPY_FAILED}
      </button>
    </div>
  );
}

export function SOPCards({
  sops,
  answer,
  unused = false,
  pinned,
  onTogglePin
}: {
  sops: SOPRef[];
  answer: string;
  unused?: boolean;
  pinned: Set<string>;
  onTogglePin: (sop: PinnedSOP) => void;
}) {
  // Live retrieval mounts the cards before any answer text exists; a history
  // replay arrives with the answer already present. Only the live case gets
  // the staggered entrance — a replayed thread fades in as one unit.
  // (Lazy useState = captured once at mount, never re-evaluated.)
  const [fresh] = useState(() => answer.trim().length === 0);
  const [pinHint, setPinHint] = useState(false);
  useEffect(() => {
    if (!pinHint) return;
    const t = setTimeout(() => setPinHint(false), 5000);
    return () => clearTimeout(t);
  }, [pinHint]);
  if (sops.length === 0) return null;
  return (
    <div>
      <p
        className={cn(
          "mb-2 text-[13px] font-medium text-muted-foreground",
          fresh && "animate-in fade-in duration-300"
        )}
      >
        {unused ? SOP_CARDS_HEADING_RELATED : SOP_CARDS_HEADING}
      </p>
      <div className="flex flex-col gap-2">
        {sops.map((sop, rank) => {
          // The verified quote from the citation repair; reasonFor is the
          // fallback for turns stored before SOPRef.quote existed.
          const reason = unused ? null : (sop.quote ?? reasonFor(answer, sop));
          const isPinned = pinned.has(pinKey(sop));
          return (
            <Card
              // Keyed by file so a mid-answer re-emit of the cards updates
              // them in place instead of replaying the entrance animation.
              key={sop.file ?? sop.title + String(sop.score)}
              className={cn(
                "flex-row items-center justify-between gap-3 rounded-[12px] px-4 py-3",
                fresh &&
                  "animate-in fade-in slide-in-from-bottom-1 fill-mode-both duration-300 ease-out-quart"
              )}
              style={
                fresh
                  ? { animationDelay: `${Math.min(rank, 4) * 50}ms` }
                  : undefined
              }
            >
              <div className="flex min-w-0 items-start gap-3">
                <span className="mt-0.5 w-4 shrink-0 text-right text-[13px] text-muted-foreground">
                  {rank + 1}
                </span>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 truncate text-sm font-medium">
                      {titleFor(sop)}
                    </span>
                    {sop.status === "draft" && <DraftChip />}
                    {sop.cited && <CitedChip />}
                  </div>
                  {reason && (
                    <p className="mt-0.5 truncate text-[13px] text-muted-foreground">
                      {reason}
                    </p>
                  )}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                {sop.source_url && (
                  <a
                    href={sop.source_url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-sm font-medium text-brand-blue underline-offset-4 hover:underline"
                  >
                    Open in Notion
                  </a>
                )}
                <PinButton
                  isPinned={isPinned}
                  onToggle={() => {
                    if (!isPinned) {
                      try {
                        if (!localStorage.getItem("cortex-hint-pin")) {
                          localStorage.setItem("cortex-hint-pin", "1");
                          setPinHint(true);
                        }
                      } catch {
                        // storage unavailable — skip the hint
                      }
                    }
                    onTogglePin({
                      title: sop.title,
                      source_url: sop.source_url,
                      file: sop.file,
                      status: sop.status ?? null
                    });
                  }}
                />
              </div>
            </Card>
          );
        })}
      </div>
      {pinHint && (
        <p className="animate-hint-fade mt-2 text-[13px] text-muted-foreground">
          {HINT_FIRST_PIN}
        </p>
      )}
    </div>
  );
}

// Memoized message blocks: the thread re-renders on every streamed delta and
// every composer keystroke, so each message must be able to skip work when
// its own inputs are unchanged.
export const UserBubble = memo(function UserBubble({
  text,
  fresh
}: {
  text: string;
  fresh: boolean;
}) {
  return (
    <div className="flex justify-end">
      <div
        className={cn(
          "max-w-[80%] rounded-[12px] border bg-surface px-4 py-3 text-[15px] whitespace-pre-wrap",
          fresh &&
            "animate-in fade-in slide-in-from-bottom-2 duration-300 ease-out-quart"
        )}
      >
        {text}
      </div>
    </div>
  );
});

export const AssistantMessage = memo(function AssistantMessage({
  message,
  streaming,
  fresh,
  pinnedKeys,
  onTogglePin
}: {
  message: CortexMessage;
  streaming: boolean;
  fresh: boolean;
  pinnedKeys: Set<string>;
  onTogglePin: (sop: PinnedSOP) => void;
}) {
  const text = textOf(message);
  const sops = sopsOf(message);
  // Operator notices (budget, no-match, error lines) are not answers to relay.
  const isNotice = message.metadata?.notice === true;
  // Link + list repair once per text change, not once per render.
  const rendered = useMemo(
    () => normalizeAnswerMarkdown(linkifySOPs(text, sops)),
    [text, sops]
  );
  return (
    // Fade only on the answer block — its streamed text pushes the cards
    // below it down continuously, and opacity is the one axis that can't
    // fight that.
    <div
      className={cn(
        "flex flex-col gap-4",
        fresh && "animate-in fade-in duration-300"
      )}
    >
      {message.metadata?.coverage === "partial" && !isNotice && (
        <p className="text-[13px] text-muted-foreground">
          {COVERAGE_PARTIAL_LINE}
        </p>
      )}
      {text.trim() && (
        <div className="text-[15px] leading-relaxed [&_a]:font-medium [&_a]:text-brand-blue [&_a]:underline [&_a]:underline-offset-4">
          <Streamdown
            mode="streaming"
            isAnimating={streaming}
            caret="circle"
            animated={STREAMDOWN_ANIMATION}
          >
            {rendered}
          </Streamdown>
        </div>
      )}
      {text.trim() && !streaming && !isNotice && (
        <CopyAnswerButton text={text} />
      )}
      {sops && (
        <SOPCards
          sops={sops}
          answer={text}
          unused={Boolean(message.metadata?.coverageBlocked)}
          pinned={pinnedKeys}
          onTogglePin={onTogglePin}
        />
      )}
    </div>
  );
});
