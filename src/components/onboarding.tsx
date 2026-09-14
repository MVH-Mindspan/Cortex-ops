import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Streamdown } from "streamdown";
import {
  COMPOSER_PLACEHOLDER,
  GUIDE_EXAMPLES,
  MODEL_LABEL,
  ONBOARDING_COPY,
  QUICK_STARTS,
  readingPreferencesSummary,
  SCREENING_LINE
} from "@/lib/copy";
import {
  guidePrompt,
  splitAnswerSections,
  type AnswerSection
} from "@/lib/guide";
import { linkifySOPs } from "@/lib/linkify";
import { normalizeAnswerMarkdown } from "@/lib/markdown";
import type { SOPRef } from "@/lib/pipeline";
import type { ReadingPreferences } from "@/lib/reading-preferences";
import { cn } from "@/lib/utils";
import { SOPCards, UserBubble, type PinnedSOP } from "@/components/message";
import {
  ArrowUpIcon,
  ChevronDownIcon,
  LogoMark,
  ShieldIcon,
  SlidersIcon
} from "@/components/icons";

// The how-to flow: five screens, one idea each. A headline, a sentence, and
// a live visual built from the same pieces the product uses (the composer's
// own toolbar, the answer's own sections, the real SOP cards). Ends in the
// product: the last screen's cards drop a situation into the composer.
//
// Motion follows the app's vocabulary: screens cross-fade in 300ms on the
// quart ease, the composer types at reading pace, the follow-up exchange
// arrives bubble by bubble. Reduced motion collapses all of it to cuts.

const STEPS = ["paste", "shape", "source", "followUp", "tryOne"] as const;
type Step = (typeof STEPS)[number];

function reducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function exampleById(id: string) {
  const example = GUIDE_EXAMPLES.find((e) => e.id === id);
  if (!example) throw new Error(`Missing onboarding example: ${id}`);
  return example;
}

function assistantTurns(id: string) {
  return exampleById(id).turns.filter((t) => t.role === "assistant");
}

export function Onboarding({
  onTryExample,
  onDone,
  pinnedKeys,
  onTogglePin,
  readingPreferences
}: {
  onTryExample: (text: string) => void;
  onDone: () => void;
  pinnedKeys: Set<string>;
  onTogglePin: (sop: PinnedSOP) => void;
  readingPreferences: ReadingPreferences;
}) {
  const [step, setStep] = useState(0);
  const [direction, setDirection] = useState<1 | -1>(1);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const total = STEPS.length;
  const last = step === total - 1;

  const go = useCallback(
    (next: number) => {
      const clamped = Math.max(0, Math.min(total - 1, next));
      setDirection(clamped >= step ? 1 : -1);
      setStep(clamped);
    },
    [step, total]
  );

  // Arrow keys page, Escape leaves. Not while typing anywhere.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      )
        return;
      if (event.key === "ArrowRight") go(step + 1);
      else if (event.key === "ArrowLeft") go(step - 1);
      else if (event.key === "Escape") onDone();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, step, onDone]);

  // Hand focus to the new headline on every page turn, not on mount: the
  // first visit lands here by itself and must not yank focus.
  const mountedRef = useRef(false);
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    headingRef.current?.focus();
  }, [step]);

  const current: Step = STEPS[step];
  const screen = ONBOARDING_COPY.screens[current];

  return (
    // Native scroll container on purpose, like the empty state: the flow is
    // designed to fit the viewport, and short windows scroll rather than
    // clip.
    <div className="relative min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex min-h-full w-full max-w-[640px] flex-col px-6 pt-2 pb-6">
        <div className="flex items-center justify-between">
          <span className="text-[13px] text-muted-foreground tabular-nums">
            {step + 1} / {total}
          </span>
          <button
            type="button"
            onClick={onDone}
            className="text-[13px] text-muted-foreground hover:text-foreground"
          >
            {ONBOARDING_COPY.skip}
          </button>
        </div>

        {/* Content and controls travel together: the column is centered
            as one unit, so Next sits right under the visual on any window
            height instead of pinned to the bottom edge, far from the eye.
            Only the screen animates; the dots and buttons stay put. */}
        <div className="flex flex-1 flex-col justify-center py-8">
          <div
            key={step}
            className={cn(
              "animate-in fade-in duration-300 ease-out-quart",
              direction === 1 ? "slide-in-from-right-2" : "slide-in-from-left-2"
            )}
          >
            <h1
              ref={headingRef}
              tabIndex={-1}
              className="text-center font-serif text-[40px] leading-tight text-foreground outline-none max-[560px]:text-[32px]"
            >
              {screen.title}
            </h1>
            <p className="mx-auto mt-3 max-w-[520px] text-center text-[15px] leading-relaxed text-muted-foreground">
              {screen.body}
            </p>
            <div className="mt-10">
              {current === "paste" && (
                <ComposerDemo readingPreferences={readingPreferences} />
              )}
              {current === "shape" && <AnswerAnatomy />}
              {current === "source" && (
                <SourceScreen
                  pinnedKeys={pinnedKeys}
                  onTogglePin={onTogglePin}
                />
              )}
              {current === "followUp" && (
                <FollowUpScreen readingPreferences={readingPreferences} />
              )}
              {current === "tryOne" && <TryOneScreen onTry={onTryExample} />}
            </div>
          </div>

          <div className="mt-10 flex flex-col items-center gap-5">
            <div className="flex items-center gap-1.5">
              {STEPS.map((name, index) => (
                <button
                  key={name}
                  type="button"
                  onClick={() => go(index)}
                  aria-label={`${index + 1} of ${total}`}
                  aria-current={index === step ? "step" : undefined}
                  className={cn(
                    "h-1.5 rounded-full transition-[width,background-color] duration-200 ease-out-quart",
                    index === step
                      ? "w-4 bg-foreground"
                      : "w-1.5 bg-muted-foreground/40 hover:bg-muted-foreground"
                  )}
                />
              ))}
            </div>
            <div className="flex h-[38px] items-center gap-6">
              {step > 0 && (
                <button
                  type="button"
                  onClick={() => go(step - 1)}
                  className="text-[13px] text-muted-foreground hover:text-foreground"
                >
                  {ONBOARDING_COPY.back}
                </button>
              )}
              {!last && (
                // The one accent, spent on the one primary action.
                <button
                  type="button"
                  onClick={() => go(step + 1)}
                  className="pressable flex h-[38px] items-center justify-center rounded-full bg-brand-orange px-7 text-[15px] font-medium text-white hover:opacity-90"
                >
                  {ONBOARDING_COPY.next}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// A static copy of the composer's chip so the demo toolbar matches the real
// one pixel for pixel, without a menu behind it.
function StyleChip({ value }: { value: ReadingPreferences }) {
  return (
    <span className="flex h-7 shrink-0 items-center gap-1.5 rounded-[6px] border px-2 text-[13px] whitespace-nowrap text-muted-foreground">
      <SlidersIcon className="h-3.5 w-3.5 shrink-0" />
      <span className="max-[560px]:hidden">
        {readingPreferencesSummary(value)}
      </span>
      <ChevronDownIcon className="h-3 w-3 shrink-0" />
    </span>
  );
}

// Screen 1: the composer types a scenario in at reading pace, the shield
// line runs its name check, and Send lights up. Same markup as the real
// composer's box and toolbar, minus the controls.
const DEMO_TEMPLATE = QUICK_STARTS[2].template;
const TYPE_MS = 14;

function ComposerDemo({
  readingPreferences
}: {
  readingPreferences: ReadingPreferences;
}) {
  const [reduce] = useState(reducedMotion);
  const [typed, setTyped] = useState(reduce ? DEMO_TEMPLATE.length : 0);
  const [phase, setPhase] = useState<"typing" | "checking" | "ready">(
    reduce ? "ready" : "typing"
  );
  useEffect(() => {
    if (reduce) return;
    let timer: ReturnType<typeof setTimeout>;
    if (typed < DEMO_TEMPLATE.length) {
      timer = setTimeout(
        () => setTyped((n) => n + 1),
        typed === 0 ? 500 : TYPE_MS
      );
    } else if (phase === "typing") {
      timer = setTimeout(() => setPhase("checking"), 500);
    } else if (phase === "checking") {
      timer = setTimeout(() => setPhase("ready"), 1400);
    } else {
      return;
    }
    return () => clearTimeout(timer);
  }, [typed, phase, reduce]);

  const complete = typed === DEMO_TEMPLATE.length;
  return (
    <div aria-hidden="true" className="rounded-[12px] border bg-surface">
      <div className="min-h-[70px] px-4 pt-3.5 pb-2 text-[15px] leading-relaxed whitespace-pre-wrap">
        {typed === 0 ? (
          <span className="text-[16px] text-muted-foreground/70">
            {COMPOSER_PLACEHOLDER}
          </span>
        ) : (
          <>
            {DEMO_TEMPLATE.slice(0, typed)}
            {!complete && (
              <span className="ml-px inline-block h-[1.1em] w-px translate-y-[3px] bg-foreground" />
            )}
          </>
        )}
      </div>
      <div className="flex items-center justify-between gap-2 px-3.5 pb-3">
        <span className="flex min-w-0 items-center gap-1.5 text-[13px] text-muted-foreground">
          <ShieldIcon className="h-3.5 w-3.5 shrink-0" />
          {phase === "checking" ? (
            <span className="animate-in fade-in duration-300 truncate">
              {SCREENING_LINE}
            </span>
          ) : (
            <span className="truncate">No names or contact info</span>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-3">
          <StyleChip value={readingPreferences} />
          <span className="text-[13px] text-muted-foreground max-[480px]:hidden">
            {MODEL_LABEL}
          </span>
          <span
            className={cn(
              "flex h-8 w-8 items-center justify-center rounded-full transition-colors duration-200",
              complete
                ? "bg-brand-orange text-white"
                : "bg-muted text-muted-foreground"
            )}
          >
            {phase === "checking" ? (
              <LogoMark className="animate-thinking h-4 w-4" />
            ) : (
              <ArrowUpIcon className="h-4 w-4" />
            )}
          </span>
        </span>
      </div>
    </div>
  );
}

function AnswerBody({ body, sops }: { body: string; sops: SOPRef[] }) {
  const rendered = useMemo(
    () => normalizeAnswerMarkdown(linkifySOPs(body, sops)),
    [body, sops]
  );
  return (
    <div className="text-[15px] leading-relaxed [&_a]:font-medium [&_a]:text-brand-blue [&_a]:underline [&_a]:underline-offset-4">
      <Streamdown mode="static">{rendered}</Streamdown>
    </div>
  );
}

// Screen 2: a real answer with one section lit at a time. The chips are the
// answer's own headings; the line under them says what that part is for.
function AnswerAnatomy() {
  const turn = assistantTurns("on-the-phone")[0];
  const sops = turn.sops ?? [];
  const sections = useMemo(() => splitAnswerSections(turn.text), [turn.text]);
  const [active, setActive] = useState("Do now");
  const [reduce] = useState(reducedMotion);
  const refs = useRef(new Map<string, HTMLElement>());
  useEffect(() => {
    refs.current.get(active)?.scrollIntoView({
      block: "nearest",
      behavior: reduce ? "auto" : "smooth"
    });
  }, [active, reduce]);
  const meaning = ONBOARDING_COPY.sections.find(
    (s) => s.heading === active
  )?.meaning;

  return (
    <div>
      <div className="flex flex-wrap justify-center gap-1.5">
        {sections.map((section) => (
          <button
            key={section.heading}
            type="button"
            onClick={() => setActive(section.heading)}
            aria-pressed={active === section.heading}
            className={cn(
              "h-7 rounded-[6px] border px-2.5 text-[13px]",
              active === section.heading
                ? "border-muted-foreground/60 bg-accent text-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-foreground"
            )}
          >
            {section.heading}
          </button>
        ))}
      </div>
      <p
        key={active}
        className="animate-in fade-in duration-200 mt-3 min-h-[20px] text-center text-[13px] text-muted-foreground"
      >
        {meaning}
      </p>
      <div className="mt-5 max-h-[300px] overflow-y-auto rounded-[12px] border bg-surface px-5 py-2 [mask-image:linear-gradient(to_bottom,black_calc(100%-40px),transparent)]">
        {sections.map((section) => (
          <SectionBlock
            key={section.heading}
            section={section}
            sops={sops}
            dimmed={active !== section.heading}
            register={(el) => {
              if (el) refs.current.set(section.heading, el);
              else refs.current.delete(section.heading);
            }}
          />
        ))}
        <div className="h-8" />
      </div>
    </div>
  );
}

function SectionBlock({
  section,
  sops,
  dimmed,
  register
}: {
  section: AnswerSection;
  sops: SOPRef[];
  dimmed: boolean;
  register: (el: HTMLElement | null) => void;
}) {
  return (
    <section
      ref={register}
      className={cn(
        "py-2.5 transition-opacity duration-200",
        dimmed && "opacity-35"
      )}
    >
      <p className="text-[13px] font-medium text-muted-foreground">
        {section.heading}
      </p>
      {section.body && <AnswerBody body={section.body} sops={sops} />}
    </section>
  );
}

// Screen 3: the real SOP cards from that answer, cited card first, and what
// each chip and the pin mean. Pinning here pins for real.
function SourceScreen({
  pinnedKeys,
  onTogglePin
}: {
  pinnedKeys: Set<string>;
  onTogglePin: (sop: PinnedSOP) => void;
}) {
  const turn = assistantTurns("on-the-phone")[0];
  const sops = useMemo(
    () =>
      [...(turn.sops ?? [])].sort(
        (a, b) => Number(Boolean(b.cited)) - Number(Boolean(a.cited))
      ),
    [turn.sops]
  );
  const { notes } = ONBOARDING_COPY.screens.source;
  return (
    <div>
      <SOPCards
        sops={sops}
        answer={turn.text}
        pinned={pinnedKeys}
        onTogglePin={onTogglePin}
      />
      <dl className="mt-6 grid grid-cols-3 gap-4 max-[560px]:grid-cols-1">
        {notes.map((note) => (
          <div key={note.term}>
            <dt className="text-[13px] font-medium text-foreground">
              {note.term}
            </dt>
            <dd className="text-[13px] leading-snug text-muted-foreground">
              {note.meaning}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

// Screen 4: a two-turn exchange arriving bubble by bubble. The answers are
// cut to one or two sections so the shape of a conversation reads at a
// glance; the line under it says so.
const FOLLOW_UP_SECTIONS: readonly (readonly string[])[] = [
  ["Answer"],
  ["Do now", "One question"]
];
const ARRIVALS_MS = [300, 900, 1700, 2400];

function FollowUpScreen({
  readingPreferences
}: {
  readingPreferences: ReadingPreferences;
}) {
  const example = exampleById("follow-up");
  const [reduce] = useState(reducedMotion);
  const [shown, setShown] = useState(reduce ? example.turns.length : 0);
  useEffect(() => {
    if (reduce) return;
    const timers = ARRIVALS_MS.slice(0, example.turns.length).map((ms, i) =>
      setTimeout(() => setShown(i + 1), ms)
    );
    return () => timers.forEach(clearTimeout);
  }, [reduce, example.turns.length]);

  // Which answer each turn is (first, second) decides which sections it
  // keeps; computed up front rather than counted while rendering.
  const answerIndex = example.turns.map(
    (_, i) =>
      example.turns.slice(0, i + 1).filter((t) => t.role === "assistant")
        .length - 1
  );
  return (
    <div>
      <div className="flex flex-col gap-4">
        {example.turns.slice(0, shown).map((turn, index) => {
          if (turn.role === "user") {
            return <UserBubble key={index} text={turn.text} fresh={!reduce} />;
          }
          const keep = FOLLOW_UP_SECTIONS[answerIndex[index]] ?? [];
          const sections = splitAnswerSections(turn.text).filter((s) =>
            keep.includes(s.heading)
          );
          return (
            <div
              key={index}
              className={cn(
                "flex flex-col gap-3",
                !reduce && "animate-in fade-in duration-300"
              )}
            >
              {sections.map((section) => (
                <div key={section.heading}>
                  {section.heading !== "Answer" && (
                    <p className="mb-1 text-[13px] font-medium text-muted-foreground">
                      {section.heading}
                    </p>
                  )}
                  <AnswerBody body={section.body} sops={turn.sops ?? []} />
                </div>
              ))}
            </div>
          );
        })}
      </div>
      {shown === example.turns.length && (
        <div
          className={cn(
            "mt-6 flex flex-col gap-3",
            !reduce && "animate-in fade-in duration-300"
          )}
        >
          <p className="text-[13px] text-muted-foreground/70">
            {ONBOARDING_COPY.screens.followUp.shortened}
          </p>
          <div className="flex items-center gap-3">
            <StyleChip value={readingPreferences} />
            <p className="text-[13px] text-muted-foreground">
              {ONBOARDING_COPY.screens.followUp.styleNote}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

// Screen 5: the situations themselves are the call to action.
function TryOneScreen({ onTry }: { onTry: (text: string) => void }) {
  return (
    <div className="flex flex-col gap-2.5">
      {GUIDE_EXAMPLES.map((example) => {
        const prompt = guidePrompt(example);
        return (
          <button
            key={example.id}
            type="button"
            onClick={() => onTry(prompt)}
            className="flex flex-col gap-1 rounded-[12px] border bg-surface px-4 py-3.5 text-left hover:border-muted-foreground/50 hover:bg-accent"
          >
            <span className="text-[15px] font-medium text-foreground">
              {example.label}
            </span>
            <span className="line-clamp-2 text-[13px] leading-snug text-muted-foreground">
              {prompt}
            </span>
          </button>
        );
      })}
    </div>
  );
}
