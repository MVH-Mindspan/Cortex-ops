import { useCallback, useEffect, useRef, useState } from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { Streamdown } from "streamdown";
import { checkPHI } from "@/lib/phi";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  ArrowUpIcon,
  ClockIcon,
  LibraryIcon,
  PanelIcon,
  PinIcon,
  PlusIcon,
  SearchIcon,
  ShieldIcon,
  SparkleIcon,
  StopIcon
} from "@/components/icons";
import type { ChatAgent, CortexMessage, SOPRef } from "./server";

const PHI_WARNING =
  "Prototype. Do not paste patient names, dates of birth, MRNs, contact details, or anything identifying. Use invented scenarios.";
const MODEL_LABEL = "llama-3.3-70b";

// Scenario templates mirror the ops team's highest-volume task types
// (operator's Month-2 mix). Every template is an invented, identifier-free
// scenario — they teach the input shape as much as they accelerate it.
const QUICK_STARTS: { label: string; template: string }[] = [
  {
    label: "Follow-up scheduling",
    template:
      "A patient's daughter called asking to move next week's follow-up to a different day. The patient gets confused in the mornings and transport needs rebooking. What's the right process?"
  },
  {
    label: "Missing or misrouted order",
    template:
      "A LabCorp order we sent last week isn't showing on the patient's chart and the lab says they never received it. How do I track down and re-route the order?"
  },
  {
    label: "Pre-visit prep chase",
    template:
      "An initial visit is in three days and the intake survey and MoCA are still missing. The caregiver isn't answering calls. What are the steps?"
  },
  {
    label: "Family complaint or concern",
    template:
      "A spouse called upset that they weren't told about a medication change and wants to speak to someone today. How should I handle and route this?"
  },
  {
    label: "Clinical escalation",
    template:
      "A caregiver reports the patient became agitated and more confused after starting a new medication this morning. What's the escalation path?"
  },
  {
    label: "External records request",
    template:
      "An outside neurology office is asking us to re-fax records with a corrected code so they can process a referral. What's the procedure?"
  },
  {
    label: "Patient tech failure",
    template:
      "A patient can't access the portal — the screening code opens a blank page on their tablet. How do I troubleshoot and who do I loop in?"
  },
  {
    label: "Results and next steps",
    template:
      "A caregiver is asking whether imaging results are back and what happens next in the workup. What can I share and what's the process?"
  },
  {
    label: "Billing question",
    template:
      "An insurer sent a claim back with a coding question on a cognitive assessment visit. What's the correction process?"
  }
];

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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Turn SOP title mentions in the streamed answer into Notion links, using the
// retrieved list as the source of truth. Leading emoji in titles are ignored
// for matching; longer titles are replaced first so a title that contains
// another doesn't produce nested links.
function linkifySOPs(text: string, sops: SOPRef[] | null): string {
  if (!sops || sops.length === 0) return text;
  let out = text;
  const linkable = sops
    .filter((sop) => sop.source_url)
    .flatMap((sop) => {
      const url = sop.source_url as string;
      const title = sop.title.replace(/^[^\p{L}\p{N}]+/u, "").trim();
      const candidates: { url: string; clean: string; label?: string }[] = [];
      if (title.length >= 4) candidates.push({ url, clean: title });
      if (sop.file && sop.file.length >= 4) {
        candidates.push({ url, clean: sop.file, label: title || sop.file });
      }
      return candidates;
    })
    .sort((a, b) => b.clean.length - a.clean.length);
  for (const sop of linkable) {
    out = out.replace(
      new RegExp(`\\*{0,2}${escapeRegExp(sop.clean)}\\*{0,2}`, "gi"),
      (match, offset: number, full: string) => {
        const prevOpen = full.lastIndexOf("[", offset);
        const prevClose = full.lastIndexOf("]", offset);
        if (prevOpen > prevClose) return match; // already inside a link
        const text = sop.label ?? match.replace(/\*/g, "");
        return `[${text}](${sop.url})`;
      }
    );
  }
  return out;
}

// Strip a leading emoji from Notion titles for display (no emojis in the UI).
function displayTitle(title: string): string {
  return title.replace(/^[^\p{L}\p{N}]+/u, "").trim() || title;
}

// Pull the model's own citation sentence for a SOP out of the answer text —
// used as the one-line reason on the result card. Best effort: no quote near
// the title means no reason line.
function reasonFor(answer: string, sop: SOPRef): string | null {
  const clean = displayTitle(sop.title);
  if (clean.length < 4) return null;
  const idx = answer.toLowerCase().indexOf(clean.toLowerCase());
  if (idx === -1) return null;
  const after = answer.slice(idx, idx + 600);
  const quote = after.match(/"([^"]{10,220})"/);
  return quote ? quote[1] : null;
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
  if (sops.length === 0) return null;
  return (
    <div>
      <p className="mb-2 text-[13px] font-medium text-muted-foreground">
        Relevant SOPs
      </p>
      <div className="flex flex-col gap-2">
        {sops.map((sop, rank) => {
          const reason = reasonFor(answer, sop);
          return (
            <Card
              key={sop.title + String(sop.score)}
              className="flex-row items-center justify-between gap-3 rounded-[12px] px-4 py-3"
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
                    <Badge className="border-brand-orange/40 bg-brand-orange/15 text-brand-orange">
                      {sop.category}
                    </Badge>
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
                <button
                  type="button"
                  onClick={() =>
                    onTogglePin({
                      title: sop.title,
                      source_url: sop.source_url,
                      file: sop.file
                    })
                  }
                  aria-label={pinned.has(pinKey(sop)) ? "Unpin SOP" : "Pin SOP"}
                  className={
                    pinned.has(pinKey(sop))
                      ? "text-brand-orange"
                      : "text-muted-foreground hover:text-foreground"
                  }
                >
                  <PinIcon className="h-4 w-4" />
                </button>
              </div>
            </Card>
          );
        })}
      </div>
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

function PendingSOPs() {
  return (
    <div className="flex items-center gap-3 text-muted-foreground">
      <SparkleIcon className="h-5 w-5 animate-pulse text-brand-orange" />
      <span className="text-sm">Finding SOPs</span>
      <Skeleton className="h-4 w-24" />
    </div>
  );
}

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

export default function App() {
  const [input, setInput] = useState("");
  const [blockedReason, setBlockedReason] = useState<string | null>(null);
  // One conversation room per situation: "new situation" navigates to a fresh
  // room, recents reopen old ones, and the server's 7-day purge cleans up.
  const [threadId, setThreadId] = useState<string>(initialThreadId);
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
  const [searchOpen, setSearchOpen] = useState(false);
  const [recentsQuery, setRecentsQuery] = useState("");
  const [library, setLibrary] = useState<LibrarySOP[] | null>(null);
  const [libraryError, setLibraryError] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const agent = useAgent<ChatAgent>({ agent: "ChatAgent", name: threadId });

  const { messages, sendMessage, status, stop } = useAgentChat<
    unknown,
    CortexMessage
  >({
    agent,
    onData: useCallback((part: { type: string; data?: unknown }) => {
      if (part.type === "data-refusal") {
        setBlockedReason((part.data as { reason: string }).reason);
      }
    }, [])
  });

  const isStreaming = status === "streaming" || status === "submitted";
  const visibleMessages: CortexMessage[] = messages.filter(isRenderable);
  const last: CortexMessage | undefined = messages.at(-1);
  const awaitingSops =
    isStreaming && !(last?.role === "assistant" && sopsOf(last) !== null);
  const hasConversation = visibleMessages.length > 0 || isStreaming;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [visibleMessages.length, awaitingSops]);

  const resizeComposer = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, []);

  const submit = useCallback(() => {
    const text = input.trim();
    if (!text || isStreaming) return;
    const { blocked, reason } = checkPHI(text);
    if (blocked) {
      setBlockedReason(reason);
      return;
    }
    setBlockedReason(null);
    sendMessage({ role: "user", parts: [{ type: "text", text }] });
    setRecents((prev) => {
      if (prev.some((r) => r.id === threadId)) return prev;
      const next = [
        { id: threadId, title: text.slice(0, 48), ts: Date.now() },
        ...prev
      ].slice(0, 30);
      saveRecents(next);
      return next;
    });
    setInput("");
    requestAnimationFrame(resizeComposer);
  }, [input, isStreaming, sendMessage, resizeComposer, threadId]);

  const insertQuickStart = useCallback(
    (template: string) => {
      setInput(template);
      setBlockedReason(null);
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
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, []);

  const openRecent = useCallback((id: string) => {
    setThreadId(id);
    setViewMode("chat");
    setInput("");
    setBlockedReason(null);
  }, []);

  const openLibrary = useCallback(() => {
    setViewMode("library");
    setLibraryError(false);
    if (library === null) {
      agent.stub
        .listSOPs()
        .then((sops: unknown) => setLibrary(sops as LibrarySOP[]))
        .catch(() => setLibraryError(true));
    }
  }, [agent, library]);

  const togglePin = useCallback((sop: PinnedSOP) => {
    setPins((prev) => {
      const key = pinKey(sop);
      const next = prev.some((p) => pinKey(p) === key)
        ? prev.filter((p) => pinKey(p) !== key)
        : [
            ...prev,
            { title: sop.title, source_url: sop.source_url, file: sop.file }
          ];
      savePins(next);
      return next;
    });
  }, []);

  const pinnedKeys = new Set(pins.map(pinKey));
  const filteredRecents = recentsQuery.trim()
    ? recents.filter((r) =>
        r.title.toLowerCase().includes(recentsQuery.trim().toLowerCase())
      )
    : recents;

  const composer = (
    <div>
      <div className="rounded-[12px] border bg-surface transition-colors focus-within:border-muted-foreground/50">
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
              submit();
            }
          }}
          placeholder={
            hasConversation
              ? "Add detail or paste another situation"
              : "Paste the situation. No patient identifiers."
          }
          className="min-h-[70px] resize-none border-0 bg-transparent px-4 pt-3.5 text-[15px] shadow-none placeholder:text-[16px] placeholder:text-muted-foreground/70 focus-visible:border-transparent focus-visible:ring-0"
        />
        <div className="flex items-center justify-between gap-2 px-3.5 pb-3">
          <span
            title={PHI_WARNING}
            className="flex cursor-help items-center gap-1.5 text-[13px] text-muted-foreground"
          >
            <ShieldIcon className="h-3.5 w-3.5" />
            No patient identifiers
          </span>
          <span className="flex items-center gap-3">
            <span className="text-[13px] text-muted-foreground">
              {MODEL_LABEL}
            </span>
            {isStreaming ? (
              <button
                type="button"
                onClick={() => void stop()}
                aria-label="Stop"
                className="flex h-8 w-8 items-center justify-center rounded-full bg-muted text-foreground hover:bg-accent"
              >
                <StopIcon className="h-4 w-4" />
              </button>
            ) : (
              <button
                type="button"
                onClick={submit}
                disabled={!input.trim()}
                aria-label="Send"
                className={
                  input.trim()
                    ? "flex h-8 w-8 items-center justify-center rounded-full bg-brand-orange text-white"
                    : "flex h-8 w-8 items-center justify-center rounded-full bg-muted text-muted-foreground"
                }
              >
                <ArrowUpIcon className="h-4 w-4" />
              </button>
            )}
          </span>
        </div>
      </div>
      {blockedReason && (
        <Alert variant="destructive" className="mt-3">
          <AlertTitle>Message blocked</AlertTitle>
          <AlertDescription>
            Looks like this contains {blockedReason}. Remove identifiers before
            sending.
          </AlertDescription>
        </Alert>
      )}
    </div>
  );

  return (
    <div className="flex h-full">
      {!sidebarOpen && (
        <button
          type="button"
          onClick={() => setSidebarOpen(true)}
          aria-label="Open sidebar"
          className="fixed top-3 left-3 z-40 flex h-8 w-8 items-center justify-center rounded-[6px] border bg-sidebar text-muted-foreground hover:text-foreground"
        >
          <PanelIcon className="h-4 w-4" />
        </button>
      )}
      {sidebarOpen && (
        <button
          type="button"
          onClick={() => setSidebarOpen(false)}
          aria-label="Close sidebar"
          className="fixed inset-0 z-30 hidden bg-black/50 max-[900px]:block"
        />
      )}
      {sidebarOpen && (
        <aside className="flex w-[284px] shrink-0 flex-col border-r bg-sidebar max-[900px]:fixed max-[900px]:inset-y-0 max-[900px]:left-0 max-[900px]:z-40 max-[900px]:shadow-2xl">
          <div className="flex items-center justify-between px-4 pt-4 pb-2">
            <span className="font-serif text-[22px] text-foreground">
              Cortex
            </span>
            <span className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={newSituation}
                aria-label="New situation"
                className="flex h-8 w-8 items-center justify-center rounded-[6px] border text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <PlusIcon className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={openLibrary}
                aria-label="SOP library"
                className="flex h-8 w-8 items-center justify-center rounded-[6px] border text-muted-foreground hover:bg-accent hover:text-foreground"
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
                  <div className="flex h-[34px] items-center gap-2.5 px-2.5 text-[13px] text-muted-foreground">
                    <PinIcon className="h-4 w-4 shrink-0" />
                    Pin SOPs to keep them here
                  </div>
                ) : (
                  <div className="flex flex-col">
                    {pins.map((pin) => (
                      <div
                        key={pinKey(pin)}
                        className="group flex h-[34px] items-center gap-2.5 rounded-[6px] px-2.5 hover:bg-accent"
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
                          className="text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground"
                        >
                          <PinIcon className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="pt-2">
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
                    className={
                      searchOpen
                        ? "text-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    }
                  >
                    <SearchIcon className="h-3.5 w-3.5" />
                  </button>
                </div>
                {searchOpen && (
                  <input
                    value={recentsQuery}
                    onChange={(e) => setRecentsQuery(e.target.value)}
                    placeholder="Search situations"
                    className="mx-2.5 mb-2 h-8 w-[calc(100%-20px)] rounded-[6px] border bg-background px-2.5 text-[13px] text-foreground outline-none placeholder:text-muted-foreground/70 focus:border-muted-foreground/60"
                  />
                )}
                {recents.length === 0 ? (
                  <p className="px-2.5 text-[13px] text-muted-foreground/70">
                    Nothing yet
                  </p>
                ) : filteredRecents.length === 0 ? (
                  <p className="px-2.5 text-[13px] text-muted-foreground/70">
                    No matches
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
                className="text-muted-foreground hover:text-foreground"
              >
                <PanelIcon className="h-4 w-4" />
              </button>
            </div>
          </div>
        </aside>
      )}

      <main className="flex min-w-0 flex-1 flex-col">
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
                    ? "Couldn't load the SOP index. Open the library again to retry."
                    : "Loading the SOP index"}
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
                              <button
                                type="button"
                                onClick={() => togglePin(sop)}
                                aria-label={
                                  pinnedKeys.has(pinKey(sop))
                                    ? "Unpin SOP"
                                    : "Pin SOP"
                                }
                                className={
                                  pinnedKeys.has(pinKey(sop))
                                    ? "text-brand-orange"
                                    : "text-muted-foreground hover:text-foreground"
                                }
                              >
                                <PinIcon className="h-4 w-4" />
                              </button>
                            </div>
                          ))}
                      </div>
                    </div>
                  ))}
            </div>
          </ScrollArea>
        ) : hasConversation ? (
          <>
            <ScrollArea className="min-h-0 flex-1">
              <div className="mx-auto w-full max-w-[760px] px-6 py-8">
                <div className="flex flex-col gap-6">
                  {visibleMessages.map((message) =>
                    message.role === "user" ? (
                      <div key={message.id} className="flex justify-end">
                        <div className="max-w-[80%] rounded-[12px] bg-surface border px-4 py-3 text-[15px] whitespace-pre-wrap">
                          {textOf(message)}
                        </div>
                      </div>
                    ) : (
                      <div key={message.id} className="flex flex-col gap-4">
                        {textOf(message).trim() && (
                          <div className="text-[15px] leading-relaxed [&_a]:font-medium [&_a]:text-brand-blue [&_a]:underline [&_a]:underline-offset-4">
                            <Streamdown>
                              {linkifySOPs(textOf(message), sopsOf(message))}
                            </Streamdown>
                          </div>
                        )}
                        {sopsOf(message) && (
                          <SOPCards
                            sops={sopsOf(message)!}
                            answer={textOf(message)}
                            pinned={pinnedKeys}
                            onTogglePin={togglePin}
                          />
                        )}
                      </div>
                    )
                  )}
                  {awaitingSops && <PendingSOPs />}
                  <div ref={bottomRef} />
                </div>
              </div>
            </ScrollArea>
            <div className="shrink-0 p-6">
              <div className="mx-auto w-full max-w-[760px]">{composer}</div>
            </div>
          </>
        ) : (
          <ScrollArea className="min-h-0 flex-1">
            <div className="mx-auto flex min-h-full w-full max-w-[640px] flex-col justify-center px-6 py-10">
              <h1 className="flex items-center justify-center gap-3 text-center font-serif text-[40px] leading-tight text-foreground">
                <SparkleIcon className="h-8 w-8 shrink-0 text-brand-orange" />
                What's the situation?
              </h1>
              <div className="mt-12">{composer}</div>
              <p className="mt-4 text-center text-[13px] text-muted-foreground">
                A good paste covers what happened, who's involved by role,
                what's been tried, and how urgent it is.
              </p>
            </div>
          </ScrollArea>
        )}
      </main>
    </div>
  );
}
