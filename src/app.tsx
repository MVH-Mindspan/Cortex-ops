import {
  memo,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction
} from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { DropdownMenu } from "radix-ui";
import { Streamdown } from "streamdown";
import { checkPHI, checkPossiblePII, PII_SCREEN_REASON } from "@/lib/phi";
import { normalizeAnswerMarkdown } from "@/lib/markdown";
import { displayTitle, linkifySOPs, reasonFor } from "@/lib/linkify";
import { MAX_MESSAGE_CHARS, type SOPRef } from "@/lib/pipeline";
import {
  BLOCKED_GUIDANCE,
  COMPOSER_PLACEHOLDER,
  COMPOSER_PLACEHOLDER_FOLLOW_UP,
  composerCounter,
  COPY_ANSWER,
  COPY_DONE,
  COPY_FAILED,
  EMPTY_PINS,
  EMPTY_RECENTS,
  greetingForHour,
  hardBlockWarning,
  HINT_FIRST_ANSWER,
  HINT_FIRST_PIN,
  LIBRARY_ERROR,
  LIBRARY_LOADING,
  NO_SEARCH_MATCH,
  PHI_FOOTER,
  PHI_WARNING,
  QUICK_STARTS,
  REACH_OUT_FOOTER,
  REACH_OUT_FOOTER_COPIED,
  REACH_OUT_REASONS,
  REACH_OUT_STARTERS,
  RETRIEVAL_LINES,
  RETRIEVAL_LONG_WAIT,
  SCREENING_LINE,
  softPIIWarning,
  THANKS_LINE,
  THANKS_RE
} from "@/lib/copy";
import { cn } from "@/lib/utils";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import {
  ArrowUpIcon,
  ChatIcon,
  ClockIcon,
  LibraryIcon,
  PanelIcon,
  PinIcon,
  PlusIcon,
  SearchIcon,
  ShieldIcon,
  LogoMark,
  StopIcon
} from "@/components/icons";
import type { ChatAgent, CortexMessage } from "./server";

const MODEL_LABEL = "llama-3.3-70b";

// Pre-send name screen: fail open after this long so a dropped socket never
// holds the composer (the callable RPC would otherwise wait a full minute).
// The server backstop still screens the message.
const SCREEN_TIMEOUT_MS = 8_000;
// A tab hidden this long refetches its thread on return, so a conversation
// purged server-side in the meantime is not re-posted from the tab's cache.
const STALE_TAB_MS = 60 * 60 * 1000;
// The character counter appears this close to the message cap.
const COUNTER_FROM = MAX_MESSAGE_CHARS - 1_000;
// Stable identity: an inline object would defeat the memoized answer block.
const STREAMDOWN_ANIMATION = {
  animation: "fadeIn",
  sep: "word",
  duration: 250,
  stagger: 12
} as const;

// Deep link that opens a Slack direct message to the Cortex admin (MVH). Not a
// secret: it only resolves for people already signed into the Mindspan Slack,
// and the app sits behind Cloudflare Access. Slack can't pre-fill DM text, so
// all three reasons open the same DM — the reasons are guidance for the person
// reaching out. To change who this messages, swap the member ID (U…).
const SLACK_DM_URL = "https://slack.com/app_redirect?channel=U06M2DEP693";

function sopsOf(message: CortexMessage): SOPRef[] | null {
  for (const part of message.parts) {
    if (part.type === "data-sops") return part.data as SOPRef[];
  }
  return null;
}

function textOf(message: CortexMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function isRenderable(message: CortexMessage): boolean {
  if (message.role === "user") return textOf(message).trim().length > 0;
  return sopsOf(message) !== null || textOf(message).trim().length > 0;
}

// Pin toggle with a small "stamp" on pin (scale/rotate decelerating to rest).
// The icon is remounted via key so the animation retriggers; `stamped` stays
// false until the first interaction so history replays mount silently. Unpin
// never animates — removal is instant.
function PinButton({
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
function CopyAnswerButton({ text }: { text: string }) {
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

function SOPCards({
  sops,
  answer,
  pinned,
  onTogglePin
}: {
  sops: SOPRef[];
  answer: string;
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
        Relevant SOPs
      </p>
      <div className="flex flex-col gap-2">
        {sops.map((sop, rank) => {
          const reason = reasonFor(answer, sop);
          const isPinned = pinned.has(pinKey(sop));
          return (
            <Card
              key={sop.title + String(sop.score)}
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
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-medium">
                      {displayTitle(sop.title)}
                    </span>
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
                      file: sop.file
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

type RecentSituation = { id: string; title: string; ts: number };
const RECENTS_KEY = "cortex-recents";

function loadRecents(): RecentSituation[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    const parsed = raw ? (JSON.parse(raw) as RecentSituation[]) : [];
    return Array.isArray(parsed) ? parsed.slice(0, 30) : [];
  } catch {
    return [];
  }
}

function saveRecents(recents: RecentSituation[]): void {
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(recents.slice(0, 30)));
  } catch {
    // storage unavailable — recents just don't persist
  }
}

type PinnedSOP = { title: string; source_url: string | null; file?: string };
const PINS_KEY = "cortex-pins";

function pinKey(pin: { title: string; file?: string }): string {
  return pin.file ?? pin.title;
}

function loadPins(): PinnedSOP[] {
  try {
    const raw = localStorage.getItem(PINS_KEY);
    const parsed = raw ? (JSON.parse(raw) as PinnedSOP[]) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function savePins(pins: PinnedSOP[]): void {
  try {
    localStorage.setItem(PINS_KEY, JSON.stringify(pins));
  } catch {
    // storage unavailable — pins just don't persist
  }
}

type LibrarySOP = {
  title: string;
  category: string;
  source_url: string | null;
  file: string;
};

// Module scope on purpose: useAgentChat suspends on its initial fetch, and a
// suspended first mount is discarded and replayed — useState initializers run
// again on replay. A render-time uuid would mint a new room (and a new fetch)
// every replay, looping forever. One id per page load, stable across replays.
const initialThreadId = crypto.randomUUID();

// Top-right control: opens a Slack DM to the Cortex admin. Link-out only —
// nothing is sent from Cortex, so there is no PHI surface here. Built on the
// Radix dropdown so arrow-key navigation, focus return, and outside-click /
// Escape dismissal come for free.
function ReachOutMenu() {
  // Slack deep links can't pre-fill DM text, so selecting a reason copies a
  // starter message instead. The menu stays open for those items — Slack
  // steals focus anyway, and the swapped footer is the receipt waiting when
  // the operator tabs back to paste.
  const [copiedStarter, setCopiedStarter] = useState(false);

  return (
    <DropdownMenu.Root
      onOpenChange={(open) => {
        if (open) setCopiedStarter(false);
      }}
    >
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label="Reach out to the Cortex admin on Slack"
          className="pressable flex h-8 items-center gap-1.5 rounded-[6px] border px-2.5 text-[13px] text-muted-foreground hover:bg-accent hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground"
        >
          <ChatIcon className="h-4 w-4" />
          Reach out
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          className="animate-in fade-in zoom-in-95 slide-in-from-top-1 duration-200 ease-out-quart z-50 w-[256px] origin-top-right rounded-[10px] border bg-popover p-1.5 shadow-xl outline-none"
        >
          <DropdownMenu.Label className="px-2.5 pt-1.5 pb-1 text-[12px] text-muted-foreground">
            Message the Cortex admin on Slack
          </DropdownMenu.Label>
          {REACH_OUT_REASONS.map((reason) => (
            <DropdownMenu.Item
              key={reason.label}
              asChild
              onSelect={(event) => {
                const starter = REACH_OUT_STARTERS[reason.label];
                if (!starter) return;
                // Keep the menu open so the copied receipt is visible.
                event.preventDefault();
                navigator.clipboard.writeText(starter).then(
                  () => setCopiedStarter(true),
                  () => {
                    // clipboard unavailable — the DM still opens
                  }
                );
              }}
            >
              <a
                href={SLACK_DM_URL}
                target="_blank"
                rel="noreferrer"
                className="flex flex-col rounded-[6px] px-2.5 py-2 outline-none hover:bg-accent data-[highlighted]:bg-accent"
              >
                <span className="text-[14px] text-foreground">
                  {reason.label}
                </span>
                <span className="text-[12px] text-muted-foreground">
                  {reason.hint}
                </span>
              </a>
            </DropdownMenu.Item>
          ))}
          <p
            key={copiedStarter ? "copied" : "default"}
            className={cn(
              "px-2.5 pt-1 pb-1.5 text-[12px] text-muted-foreground/70",
              copiedStarter &&
                "animate-in fade-in duration-300 text-muted-foreground"
            )}
          >
            {copiedStarter ? REACH_OUT_FOOTER_COPIED : REACH_OUT_FOOTER}
          </p>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

// Retrieval wait: the lines advance through the real pipeline stages and hold
// on the last (never loop) — progress, not flavor. Mounts fresh per retrieval,
// so the timers reset for free; removal is instant (the cards fading in over
// it reads as a crossfade).
function PendingSOPs() {
  const [step, setStep] = useState(0);
  const [longWait, setLongWait] = useState(false);
  useEffect(() => {
    const advance = setInterval(
      () => setStep((s) => Math.min(s + 1, RETRIEVAL_LINES.length - 1)),
      2500
    );
    const long = setTimeout(() => setLongWait(true), 10000);
    return () => {
      clearInterval(advance);
      clearTimeout(long);
    };
  }, []);
  const line = longWait ? RETRIEVAL_LONG_WAIT : RETRIEVAL_LINES[step];
  return (
    <div className="animate-in fade-in duration-300 flex items-center gap-3 text-muted-foreground">
      <LogoMark className="animate-thinking h-5 w-5 text-brand-orange" />
      <span key={line} className="animate-in fade-in duration-300 text-sm">
        {line}
      </span>
    </div>
  );
}

// Resolves with `fallback` if the promise takes longer than `ms`.
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  fallback: T
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

// Memoized message blocks: the thread re-renders on every streamed delta and
// every composer keystroke, so each message must be able to skip work when
// its own inputs are unchanged.
const UserBubble = memo(function UserBubble({
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

const AssistantMessage = memo(function AssistantMessage({
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
          pinned={pinnedKeys}
          onTogglePin={onTogglePin}
        />
      )}
    </div>
  );
});

function SidebarRow({
  label,
  onSelect
}: {
  label: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex h-[34px] w-full items-center gap-2.5 rounded-[6px] px-2.5 text-left text-[15px] text-foreground/85 hover:bg-accent"
    >
      <span className="h-1.5 w-1.5 shrink-0 rounded-full border border-muted-foreground" />
      <span className="truncate">{label}</span>
    </button>
  );
}

function Conversation({
  threadId,
  input,
  setInput,
  blockedReason,
  setBlockedReason,
  textareaRef,
  resizeComposer,
  onFirstMessage,
  pinnedKeys,
  onTogglePin,
  insertPulse
}: {
  threadId: string;
  input: string;
  setInput: Dispatch<SetStateAction<string>>;
  blockedReason: string | null;
  setBlockedReason: (reason: string | null) => void;
  textareaRef: { current: HTMLTextAreaElement | null };
  resizeComposer: () => void;
  onFirstMessage: (id: string, title: string) => void;
  pinnedKeys: Set<string>;
  onTogglePin: (sop: PinnedSOP) => void;
  insertPulse: number;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);
  // Text of the last message sent, kept so a server-side refusal can restore it
  // to the composer (the composer is cleared on send and refuse() drops the row
  // from the thread) — this is what makes "Send anyway" reachable on that path.
  const lastSentTextRef = useRef("");
  // Set when the server refuses a message: the stream still "completes", but a
  // refusal round must not fire the completion beat or the first-answer hint
  // (refuse() deletes the user row, so `last` points at the PREVIOUS answer).
  const refusedRef = useRef(false);
  // Live pre-send check, debounced: hard tripwire matches warn early (they
  // will be blocked at send), fuzzy heuristics advise without blocking.
  const [preWarning, setPreWarning] = useState<string | null>(null);
  useEffect(() => {
    const id = setTimeout(() => {
      const text = input.trim();
      if (!text) {
        setPreWarning(null);
        return;
      }
      const hard = checkPHI(text);
      if (hard.blocked) {
        setPreWarning(hardBlockWarning(hard.reason ?? "an identifier"));
        return;
      }
      const soft = checkPossiblePII(text);
      setPreWarning(soft ? softPIIWarning(soft) : null);
    }, 350);
    return () => clearTimeout(id);
  }, [input]);

  const agent = useAgent<ChatAgent>({ agent: "ChatAgent", name: threadId });

  const { messages, sendMessage, status, stop } = useAgentChat<
    unknown,
    CortexMessage
  >({
    agent,
    // Coalesce streamed deltas: one re-render per ~50ms instead of per token.
    experimental_throttle: 50,
    onData: useCallback(
      (part: { type: string; data?: unknown }) => {
        if (part.type === "data-refusal") {
          refusedRef.current = true;
          setBlockedReason((part.data as { reason: string }).reason);
          // Bring the refused text back so the operator can edit it or break
          // glass — without this the composer is empty and the action is inert.
          if (lastSentTextRef.current) {
            // Never clobber a draft typed while the request was in flight.
            const sent = lastSentTextRef.current;
            setInput((prev) => (prev.trim() ? prev : sent));
            requestAnimationFrame(resizeComposer);
          }
        }
      },
      [setBlockedReason, setInput, resizeComposer]
    )
  });

  const isStreaming = status === "streaming" || status === "submitted";
  // Messages already present at mount are a history replay — they arrive as
  // one unit (the Suspense reveal) and must not each perform an entrance.
  // Only messages that appear after mount animate. (Lazy useState = captured
  // once; useAgentChat suspends until history is loaded, so the first render
  // sees the full replay.)
  const [initialIds] = useState(() => new Set(messages.map((m) => m.id)));
  const visibleMessages: CortexMessage[] = messages.filter(isRenderable);
  const last: CortexMessage | undefined = messages.at(-1);
  const awaitingSops =
    isStreaming && !(last?.role === "assistant" && sopsOf(last) !== null);
  const hasConversation = visibleMessages.length > 0 || isStreaming;

  // Unmount guard for the async send path: a thread switch while the name
  // screen is in flight must not set state on the new thread.
  const aliveRef = useRef(true);
  useEffect(
    () => () => {
      aliveRef.current = false;
    },
    []
  );

  // The recents entry is written only once the server has accepted the first
  // message (its answer has started to arrive) — never at send time, so a
  // refused message leaves nothing behind on the device.
  const recordedRef = useRef(false);
  useEffect(() => {
    if (recordedRef.current) return;
    const firstUser = messages.find(
      (m) => m.role === "user" && textOf(m).trim().length > 0
    );
    const answered = messages.some(
      (m) => m.role === "assistant" && isRenderable(m)
    );
    if (!firstUser || !answered) return;
    recordedRef.current = true;
    onFirstMessage(threadId, textOf(firstUser).slice(0, 48));
  }, [messages, threadId, onFirstMessage]);

  // The empty state and the conversation lay the composer out differently,
  // so the first send remounts the textarea; hand focus back to it.
  const composerHadFocusRef = useRef(false);
  useEffect(() => {
    if (composerHadFocusRef.current) textareaRef.current?.focus();
  }, [hasConversation, textareaRef]);

  // Follow the stream only while the operator is near the bottom: scrolling
  // up more than 80px disengages, returning re-engages. Instant scroll during
  // token streaming (queued smooth scrolls lag and rubber-band); smooth for
  // discrete arrivals. Refs only — no re-render per scroll event.
  const viewportRef = useRef<HTMLElement | null>(null);
  const nearBottomRef = useRef(true);
  useEffect(() => {
    const vp = bottomRef.current?.closest<HTMLElement>(
      '[data-slot="scroll-area-viewport"]'
    );
    viewportRef.current = vp ?? null;
    if (!vp) return;
    const onScroll = () => {
      nearBottomRef.current =
        vp.scrollHeight - vp.scrollTop - vp.clientHeight < 80;
    };
    vp.addEventListener("scroll", onScroll, { passive: true });
    return () => vp.removeEventListener("scroll", onScroll);
  }, [hasConversation]);

  const lastTextLen = last ? textOf(last).length : 0;
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
      return;
    }
    if (!nearBottomRef.current) return;
    const reduce = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches;
    vp.scrollTo({
      top: vp.scrollHeight,
      behavior: isStreaming || reduce ? "auto" : "smooth"
    });
  }, [lastTextLen, visibleMessages.length, awaitingSops, isStreaming]);

  const [screening, setScreening] = useState(false);

  // Completion beat: when a stream finishes with a real answer, the composer
  // border breathes teal once ("Cortex finished for you") and — exactly once
  // per device — a hint under the answer teaches the SOP grounding.
  const wasStreaming = useRef(false);
  const [settled, setSettled] = useState(false);
  const [firstAnswerHint, setFirstAnswerHint] = useState(false);
  useEffect(() => {
    const completed = wasStreaming.current && !isStreaming;
    wasStreaming.current = isStreaming;
    if (!completed) return;
    // A server refusal also ends the stream; it must read as a block, not a
    // completion (and must not consume the one-time hint).
    if (refusedRef.current) {
      refusedRef.current = false;
      return;
    }
    if (!(last?.role === "assistant" && textOf(last).trim())) return;
    setSettled(true);
    // The hint's claim ("every step comes from the SOPs") is only true of a
    // grounded answer — error lines and the no-match line carry no SOPs.
    const sops = sopsOf(last);
    if (sops && sops.length > 0) {
      try {
        if (!localStorage.getItem("cortex-hint-first-answer")) {
          localStorage.setItem("cortex-hint-first-answer", "1");
          setFirstAnswerHint(true);
        }
      } catch {
        // storage unavailable — skip the hint
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStreaming]);
  // Dedicated reset so a follow-up send inside the 750ms window can't cancel
  // the timer and strand `settled` (which would swallow the next breath).
  useEffect(() => {
    if (!settled) return;
    const t = setTimeout(() => setSettled(false), 750);
    return () => clearTimeout(t);
  }, [settled]);
  useEffect(() => {
    if (!firstAnswerHint) return;
    const t = setTimeout(() => setFirstAnswerHint(false), 5000);
    return () => clearTimeout(t);
  }, [firstAnswerHint]);

  // A scenario insert reuses the same breath — "Cortex handed you something".
  // Seeding the ref from the mount-time prop makes remounts (thread switch,
  // library round-trip) a no-op; only genuine increments pulse.
  const lastPulseRef = useRef(insertPulse);
  useEffect(() => {
    if (insertPulse === lastPulseRef.current) return;
    lastPulseRef.current = insertPulse;
    setSettled(true);
  }, [insertPulse]);

  // Gratitude intercept: a bare "thanks" would burn a full pipeline run and
  // come back with the no-match line. Answer it locally instead.
  const [thanks, setThanks] = useState(false);
  useEffect(() => {
    if (!thanks) return;
    const t = setTimeout(() => setThanks(false), 5000);
    return () => clearTimeout(t);
  }, [thanks]);
  const submit = useCallback(
    async (options?: { override?: boolean }) => {
      const text = input.trim();
      if (!text || isStreaming || screening) return;
      if (THANKS_RE.test(text)) {
        setInput("");
        setThanks(true);
        requestAnimationFrame(resizeComposer);
        return;
      }
      const { blocked, reason } = checkPHI(text);
      // Hard identifiers are never break-glass-able — they are deterministic.
      if (blocked) {
        setBlockedReason(reason);
        return;
      }
      // Model name-screen before anything leaves the composer — a block keeps
      // the text here for editing. Fail-open on errors and on timeout; the
      // server re-screens. Break glass (options.override) skips the screen on
      // both ends.
      if (!options?.override) {
        setScreening(true);
        try {
          const screen = await withTimeout(
            agent.stub.screenPII(text) as Promise<{ flagged: boolean }>,
            SCREEN_TIMEOUT_MS,
            { flagged: false }
          );
          if (!aliveRef.current) return;
          if (screen.flagged) {
            setBlockedReason(PII_SCREEN_REASON);
            return;
          }
        } catch {
          // screening unavailable — proceed, the server backstop still runs
        } finally {
          if (aliveRef.current) setScreening(false);
        }
      }
      if (!aliveRef.current) return;
      setBlockedReason(null);
      lastSentTextRef.current = text;
      composerHadFocusRef.current =
        document.activeElement === textareaRef.current;
      // Sending your own message always re-engages follow-scroll, even if
      // you'd scrolled up to re-read an earlier answer.
      nearBottomRef.current = true;
      sendMessage({
        role: "user",
        parts: [{ type: "text", text }],
        ...(options?.override ? { metadata: { override: true } } : {})
      });
      setInput("");
      requestAnimationFrame(resizeComposer);
    },
    [
      input,
      isStreaming,
      screening,
      agent,
      sendMessage,
      textareaRef,
      setInput,
      setBlockedReason,
      resizeComposer
    ]
  );

  const composer = (
    <div>
      <div
        className={cn(
          "rounded-[12px] border bg-surface transition-colors focus-within:border-muted-foreground/50",
          settled && "animate-settle-border"
        )}
      >
        <Textarea
          ref={textareaRef}
          rows={2}
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            if (blockedReason) setBlockedReason(null);
          }}
          onInput={resizeComposer}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder={
            hasConversation
              ? COMPOSER_PLACEHOLDER_FOLLOW_UP
              : COMPOSER_PLACEHOLDER
          }
          aria-label="Situation"
          maxLength={MAX_MESSAGE_CHARS}
          className="max-h-[200px] min-h-[70px] resize-none border-0 bg-transparent px-4 pt-3.5 text-[15px] shadow-none placeholder:text-[16px] placeholder:text-muted-foreground/70 focus-visible:border-transparent focus-visible:ring-0"
        />
        <div className="flex items-center justify-between gap-2 px-3.5 pb-3">
          <span
            title={PHI_WARNING}
            className="flex cursor-help items-center gap-1.5 text-[13px] text-muted-foreground"
          >
            <ShieldIcon className="h-3.5 w-3.5" />
            No names or contact info
          </span>
          <span className="flex items-center gap-3">
            {screening ? (
              // Mounted immediately, invisible for 400ms (fill-mode-backwards
              // holds the from-frame through the delay) so fast screens never
              // flash text. <output> is an implicit status live region, so
              // the appearance is announced.
              <output className="animate-in fade-in fill-mode-backwards delay-400 duration-300 text-[13px] text-muted-foreground">
                {SCREENING_LINE}
              </output>
            ) : input.length >= COUNTER_FROM ? (
              // Near the cap the model label gives way to a counter; at the
              // cap it turns amber (the textarea stops accepting input there).
              <span
                className={cn(
                  "text-[13px] tabular-nums",
                  input.length >= MAX_MESSAGE_CHARS
                    ? "text-amber-400"
                    : "text-muted-foreground"
                )}
              >
                {composerCounter(input.length, MAX_MESSAGE_CHARS)}
              </span>
            ) : (
              <span className="text-[13px] text-muted-foreground">
                {MODEL_LABEL}
              </span>
            )}
            {isStreaming ? (
              <button
                type="button"
                onClick={() => void stop()}
                aria-label="Stop"
                className="pressable flex h-8 w-8 items-center justify-center rounded-full bg-muted text-foreground hover:bg-accent"
              >
                <StopIcon className="h-4 w-4" />
              </button>
            ) : (
              // One persistent button absorbs the screening state: the press
              // "took", so it stays orange with the brand mark doing the
              // working loop. Keeping the element (not disabling it) preserves
              // keyboard focus; submit() already guards re-entry while
              // screening. The exhale replays via the class toggle on the
              // same node — no remount, no focus loss.
              <button
                type="button"
                onClick={() => void submit()}
                disabled={!input.trim() && !screening}
                aria-label={screening ? "Checking for patient names" : "Send"}
                className={cn(
                  "pressable flex h-8 w-8 items-center justify-center rounded-full",
                  screening || input.trim()
                    ? "bg-brand-orange text-white"
                    : "bg-muted text-muted-foreground",
                  settled &&
                    "animate-in fade-in zoom-in-90 duration-200 ease-out-quart"
                )}
              >
                {screening ? (
                  <LogoMark className="animate-thinking h-4 w-4" />
                ) : (
                  <ArrowUpIcon className="h-4 w-4" />
                )}
              </button>
            )}
          </span>
        </div>
      </div>
      {preWarning && (
        <p className="mt-2.5 flex items-start justify-center gap-1.5 px-2 text-center text-[13px] leading-snug text-amber-400">
          <ShieldIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{preWarning}</span>
        </p>
      )}
      {thanks && !preWarning && (
        <p className="animate-hint-fade mt-2.5 px-2 text-center text-[13px] leading-snug text-muted-foreground">
          {THANKS_LINE}
        </p>
      )}
      <p className="mt-2.5 flex items-start justify-center gap-1.5 px-2 text-center text-[13px] leading-snug text-foreground/75">
        <ShieldIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand-orange" />
        <span>{PHI_FOOTER}</span>
      </p>
      {blockedReason && (
        <Alert variant="destructive" className="mt-3">
          <AlertTitle>Message blocked</AlertTitle>
          <AlertDescription>
            Looks like this contains {blockedReason}.{" "}
            {blockedReason === PII_SCREEN_REASON && input.trim().length > 0
              ? "This check can misfire on de-identified messages. If there's no patient name in this one, confirm below to send it."
              : BLOCKED_GUIDANCE}
          </AlertDescription>
          {blockedReason === PII_SCREEN_REASON && input.trim().length > 0 && (
            <button
              type="button"
              onClick={() => void submit({ override: true })}
              disabled={isStreaming || screening}
              className="mt-2 w-fit rounded-[6px] border border-destructive/40 px-2.5 py-1 text-[13px] font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
            >
              Confirm no PII included
            </button>
          )}
        </Alert>
      )}
    </div>
  );

  if (!hasConversation) {
    // Native scroll container on purpose: Radix ScrollArea's inner wrapper
    // doesn't propagate height, so min-h-full collapses and the content
    // pins to the top instead of centering vertically.
    return (
      <div className="relative min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex min-h-full w-full max-w-[640px] flex-col justify-center px-6 py-10">
          <p className="animate-in fade-in duration-300 mb-3 text-center text-[15px] text-muted-foreground">
            {greetingForHour(new Date().getHours())}
          </p>
          <h1 className="text-center font-serif text-[40px] leading-tight text-foreground">
            What's the situation?
          </h1>
          <div className="mt-12">{composer}</div>
        </div>
        <img
          src="/mindspan-wordmark.png"
          alt="Mindspan"
          className="pointer-events-none absolute bottom-6 left-1/2 h-3.5 w-auto -translate-x-1/2 opacity-30"
        />
      </div>
    );
  }

  return (
    <>
      <ScrollArea className="min-h-0 flex-1">
        <main className="mx-auto w-full max-w-[760px] px-6 py-8">
          <div className="flex flex-col gap-6">
            {visibleMessages.map((message) =>
              message.role === "user" ? (
                <UserBubble
                  key={message.id}
                  text={textOf(message)}
                  fresh={!initialIds.has(message.id)}
                />
              ) : (
                <AssistantMessage
                  key={message.id}
                  message={message}
                  streaming={isStreaming && message.id === last?.id}
                  fresh={!initialIds.has(message.id)}
                  pinnedKeys={pinnedKeys}
                  onTogglePin={onTogglePin}
                />
              )
            )}
            {firstAnswerHint && (
              <p className="animate-hint-fade text-[13px] text-muted-foreground">
                {HINT_FIRST_ANSWER}
              </p>
            )}
            {awaitingSops && <PendingSOPs />}
            <div ref={bottomRef} />
          </div>
        </main>
      </ScrollArea>
      <div className="shrink-0 p-6">
        <div className="mx-auto w-full max-w-[760px]">{composer}</div>
      </div>
    </>
  );
}

export default function App() {
  const [input, setInput] = useState("");
  const [blockedReason, setBlockedReason] = useState<string | null>(null);
  // One conversation room per situation. The Conversation subtree is keyed by
  // threadId, so switching threads remounts it: fresh socket, fresh initial
  // fetch, fresh chat state — no reliance on in-place room switching.
  const [threadId, setThreadId] = useState<string>(initialThreadId);
  // Bumped when the tab returns from a long sleep: the keyed Conversation
  // remounts and refetches its history instead of trusting a cache that may
  // predate the server-side purge.
  const [threadEpoch, setThreadEpoch] = useState(0);
  useEffect(() => {
    let hiddenAt: number | null = null;
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        hiddenAt = Date.now();
        return;
      }
      if (hiddenAt !== null && Date.now() - hiddenAt >= STALE_TAB_MS) {
        setThreadEpoch((n) => n + 1);
      }
      hiddenAt = null;
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);
  const [recents, setRecents] = useState<RecentSituation[]>(() =>
    loadRecents()
  );
  const [viewMode, setViewMode] = useState<"chat" | "library">("chat");
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(() =>
    typeof window === "undefined"
      ? true
      : window.matchMedia("(min-width: 900px)").matches
  );
  const [pins, setPins] = useState<PinnedSOP[]>(() => loadPins());
  // Key of the pin added in the last ~moment — only that sidebar row plays
  // the entrance, so sidebar remounts never re-perform the whole list.
  const [lastAddedPinKey, setLastAddedPinKey] = useState<string | null>(null);
  useEffect(() => {
    if (lastAddedPinKey === null) return;
    const t = setTimeout(() => setLastAddedPinKey(null), 500);
    return () => clearTimeout(t);
  }, [lastAddedPinKey]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [recentsQuery, setRecentsQuery] = useState("");
  const [library, setLibrary] = useState<LibrarySOP[] | null>(null);
  const [libraryError, setLibraryError] = useState(false);
  // Counts scenario inserts so the composer can acknowledge each one with the
  // same settle breath used on answer completion.
  const [insertPulse, setInsertPulse] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const recentsRef = useRef<HTMLDivElement>(null);

  // Dedicated connection for RPC that isn't tied to any one conversation.
  const rpcAgent = useAgent<ChatAgent>({ agent: "ChatAgent", name: "app-rpc" });

  const resizeComposer = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, []);

  const insertQuickStart = useCallback(
    (template: string) => {
      setInput(template);
      setBlockedReason(null);
      setInsertPulse((n) => n + 1);
      requestAnimationFrame(() => {
        resizeComposer();
        textareaRef.current?.focus();
      });
    },
    [resizeComposer]
  );

  const newSituation = useCallback(() => {
    setThreadId(crypto.randomUUID());
    setViewMode("chat");
    setInput("");
    setBlockedReason(null);
  }, []);

  const openRecent = useCallback((id: string) => {
    setThreadId(id);
    setViewMode("chat");
    setInput("");
    setBlockedReason(null);
  }, []);

  const recordRecent = useCallback((id: string, title: string) => {
    setRecents((prev) => {
      if (prev.some((r) => r.id === id)) return prev;
      const next = [{ id, title, ts: Date.now() }, ...prev].slice(0, 30);
      saveRecents(next);
      return next;
    });
  }, []);

  const openLibrary = useCallback(() => {
    setViewMode("library");
    setLibraryError(false);
    if (library === null) {
      rpcAgent.stub
        .listSOPs()
        .then((sops: unknown) => setLibrary(sops as LibrarySOP[]))
        .catch(() => setLibraryError(true));
    }
  }, [rpcAgent, library]);

  const togglePin = useCallback(
    (sop: PinnedSOP) => {
      const key = pinKey(sop);
      const removing = pins.some((p) => pinKey(p) === key);
      setLastAddedPinKey(removing ? null : key);
      const next = removing
        ? pins.filter((p) => pinKey(p) !== key)
        : [
            ...pins,
            { title: sop.title, source_url: sop.source_url, file: sop.file }
          ];
      savePins(next);
      setPins(next);
    },
    [pins]
  );

  // Memoized: a fresh Set every render would defeat the message memoization.
  const pinnedKeys = useMemo(() => new Set(pins.map(pinKey)), [pins]);
  const filteredRecents = recentsQuery.trim()
    ? recents.filter((r) =>
        r.title.toLowerCase().includes(recentsQuery.trim().toLowerCase())
      )
    : recents;

  return (
    <div className="flex h-full">
      {!sidebarOpen && (
        <button
          type="button"
          onClick={() => setSidebarOpen(true)}
          aria-label="Open sidebar"
          className="pressable fixed top-3 left-3 z-40 flex h-8 w-8 items-center justify-center rounded-[6px] border bg-sidebar text-muted-foreground hover:text-foreground"
        >
          <PanelIcon className="h-4 w-4" />
        </button>
      )}
      {sidebarOpen && (
        <button
          type="button"
          onClick={() => setSidebarOpen(false)}
          aria-label="Close sidebar"
          className="animate-in fade-in duration-300 fixed inset-0 z-30 hidden bg-black/50 max-[900px]:block"
        />
      )}
      {sidebarOpen && (
        <aside className="flex w-[284px] shrink-0 flex-col border-r bg-sidebar max-[900px]:fixed max-[900px]:inset-y-0 max-[900px]:left-0 max-[900px]:z-40 max-[900px]:shadow-2xl max-[900px]:animate-in max-[900px]:slide-in-from-left max-[900px]:fade-in-50 max-[900px]:duration-300 max-[900px]:ease-out-expo">
          <div className="flex items-center justify-between px-4 pt-4 pb-2">
            <button
              type="button"
              onClick={newSituation}
              aria-label="Cortex, go to main page"
              className="pressable flex items-center gap-2 rounded-[6px] hover:opacity-80"
            >
              <LogoMark className="h-6 w-6 text-foreground" />
              <span className="font-serif text-[22px] text-foreground">
                Cortex
              </span>
            </button>
            <span className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={newSituation}
                aria-label="New situation"
                className="pressable flex h-8 w-8 items-center justify-center rounded-[6px] border text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <PlusIcon className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={openLibrary}
                aria-label="SOP library"
                className="pressable flex h-8 w-8 items-center justify-center rounded-[6px] border text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <LibraryIcon className="h-4 w-4" />
              </button>
            </span>
          </div>

          <nav className="flex flex-col gap-0.5 px-2.5 py-2">
            <button
              type="button"
              onClick={newSituation}
              className="flex h-[34px] items-center gap-2.5 rounded-full bg-accent px-3 text-[15px] font-medium text-foreground"
            >
              <PlusIcon className="h-4 w-4 text-brand-orange" />
              New situation
            </button>
            <button
              type="button"
              onClick={openLibrary}
              className="flex h-[34px] items-center gap-2.5 rounded-[6px] px-3 text-[15px] text-foreground/85 hover:bg-accent"
            >
              <LibraryIcon className="h-4 w-4 text-muted-foreground" />
              SOP library
            </button>
            <button
              type="button"
              onClick={() =>
                recentsRef.current?.scrollIntoView({
                  behavior: window.matchMedia(
                    "(prefers-reduced-motion: reduce)"
                  ).matches
                    ? "auto"
                    : "smooth",
                  block: "start"
                })
              }
              className="flex h-[34px] items-center gap-2.5 rounded-[6px] px-3 text-[15px] text-foreground/85 hover:bg-accent"
            >
              <ClockIcon className="h-4 w-4 text-muted-foreground" />
              Recent
            </button>
          </nav>

          <ScrollArea className="min-h-0 flex-1 px-2.5">
            <div className="flex flex-col gap-2 pb-4">
              <div className="pt-2">
                <p className="px-2.5 pb-2 text-[13px] text-muted-foreground">
                  Scenarios
                </p>
                <div className="flex flex-col">
                  {QUICK_STARTS.map((qs) => (
                    <SidebarRow
                      key={qs.label}
                      label={qs.label}
                      onSelect={() => insertQuickStart(qs.template)}
                    />
                  ))}
                </div>
              </div>

              <div className="pt-2">
                <p className="px-2.5 pb-2 text-[13px] text-muted-foreground">
                  Pinned SOPs
                </p>
                {pins.length === 0 ? (
                  <div className="flex min-h-[34px] items-center gap-2.5 px-2.5 py-1.5 text-[13px] text-muted-foreground">
                    <PinIcon className="h-4 w-4 shrink-0" />
                    {EMPTY_PINS}
                  </div>
                ) : (
                  <div className="flex flex-col">
                    {pins.map((pin) => (
                      <div
                        key={pinKey(pin)}
                        className={cn(
                          "group flex h-[34px] items-center gap-2.5 rounded-[6px] px-2.5 hover:bg-accent",
                          pinKey(pin) === lastAddedPinKey &&
                            "animate-in fade-in slide-in-from-left-1 duration-200 ease-out-quart"
                        )}
                      >
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full border border-muted-foreground" />
                        {pin.source_url ? (
                          <a
                            href={pin.source_url}
                            target="_blank"
                            rel="noreferrer"
                            className="min-w-0 flex-1 truncate text-[15px] text-foreground/85"
                          >
                            {displayTitle(pin.title)}
                          </a>
                        ) : (
                          <span className="min-w-0 flex-1 truncate text-[15px] text-foreground/85">
                            {displayTitle(pin.title)}
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={() => togglePin(pin)}
                          aria-label="Unpin SOP"
                          className="text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100"
                        >
                          <PinIcon className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div ref={recentsRef} className="pt-2">
                <div className="flex items-center justify-between px-2.5 pb-2">
                  <p className="text-[13px] text-muted-foreground">
                    Recent situations
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      setSearchOpen((open) => !open);
                      setRecentsQuery("");
                    }}
                    aria-label="Search recent situations"
                    className={cn(
                      "pressable",
                      searchOpen
                        ? "text-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    <SearchIcon className="h-3.5 w-3.5" />
                  </button>
                </div>
                {searchOpen && (
                  <input
                    value={recentsQuery}
                    onChange={(e) => setRecentsQuery(e.target.value)}
                    aria-label="Search recent situations"
                    placeholder="Search situations"
                    className="mx-2.5 mb-2 h-8 w-[calc(100%-20px)] rounded-[6px] border bg-background px-2.5 text-[13px] text-foreground outline-none placeholder:text-muted-foreground/70 focus:border-muted-foreground/60"
                  />
                )}
                {recents.length === 0 ? (
                  <p className="px-2.5 text-[13px] text-muted-foreground/70">
                    {EMPTY_RECENTS}
                  </p>
                ) : filteredRecents.length === 0 ? (
                  <p className="px-2.5 text-[13px] text-muted-foreground/70">
                    {NO_SEARCH_MATCH}
                  </p>
                ) : (
                  <div className="flex flex-col">
                    {filteredRecents.map((r) => (
                      <SidebarRow
                        key={r.id}
                        label={r.title}
                        onSelect={() => openRecent(r.id)}
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>
          </ScrollArea>

          <div className="border-t px-4 py-3">
            <div className="flex items-center gap-2.5">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-teal-light text-xs font-medium text-white">
                M
              </span>
              <span className="min-w-0 flex-1 leading-tight">
                <span className="block truncate text-sm text-foreground">
                  Ops team
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  Mindspan operations
                </span>
              </span>
              <button
                type="button"
                onClick={() => setSidebarOpen(false)}
                aria-label="Collapse sidebar"
                className="pressable text-muted-foreground hover:text-foreground"
              >
                <PanelIcon className="h-4 w-4" />
              </button>
            </div>
          </div>
        </aside>
      )}

      <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center justify-end px-4 pt-3">
          <ReachOutMenu />
        </div>
        {viewMode === "library" ? (
          <ScrollArea className="min-h-0 flex-1">
            <div className="mx-auto w-full max-w-[760px] px-6 py-10">
              <h1 className="font-serif text-[28px] text-foreground">
                SOP library
              </h1>
              <p className="mt-1 text-[13px] text-muted-foreground">
                {library
                  ? `${library.length} SOPs, grouped by category. Rows open in Notion.`
                  : libraryError
                    ? LIBRARY_ERROR
                    : LIBRARY_LOADING}
              </p>
              {library &&
                [...new Set(library.map((s) => s.category))]
                  .sort((a, b) => a.localeCompare(b))
                  .map((category) => (
                    <div key={category} className="mt-7">
                      <p className="pb-2 text-[13px] text-muted-foreground">
                        {category}
                      </p>
                      <div className="flex flex-col gap-1.5">
                        {library
                          .filter((s) => s.category === category)
                          .map((sop) => (
                            <div
                              key={sop.file}
                              className="flex h-[40px] items-center justify-between gap-3 rounded-[8px] border bg-surface px-3.5"
                            >
                              {sop.source_url ? (
                                <a
                                  href={sop.source_url}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="min-w-0 flex-1 truncate text-sm text-foreground hover:text-brand-blue"
                                >
                                  {displayTitle(sop.title)}
                                </a>
                              ) : (
                                <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                                  {displayTitle(sop.title)}
                                </span>
                              )}
                              <PinButton
                                isPinned={pinnedKeys.has(pinKey(sop))}
                                onToggle={() => togglePin(sop)}
                              />
                            </div>
                          ))}
                      </div>
                    </div>
                  ))}
            </div>
          </ScrollArea>
        ) : (
          <Suspense
            fallback={
              <div className="flex min-h-0 flex-1 items-center justify-center">
                <LogoMark className="animate-thinking h-6 w-6 text-brand-orange" />
              </div>
            }
          >
            <Conversation
              key={`${threadId}:${threadEpoch}`}
              threadId={threadId}
              input={input}
              setInput={setInput}
              blockedReason={blockedReason}
              setBlockedReason={setBlockedReason}
              textareaRef={textareaRef}
              resizeComposer={resizeComposer}
              onFirstMessage={recordRecent}
              pinnedKeys={pinnedKeys}
              onTogglePin={togglePin}
              insertPulse={insertPulse}
            />
          </Suspense>
        )}
      </main>
    </div>
  );
}
