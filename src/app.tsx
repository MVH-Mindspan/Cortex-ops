import { useCallback, useEffect, useRef, useState } from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { Streamdown } from "streamdown";
import { checkPHI } from "@/lib/phi";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import type { ChatAgent, CortexMessage, SOPRef } from "./server";

// Quick starts mirror the ops team's highest-volume task types (operator's
// Month-2 mix). Every template is an invented, identifier-free scenario —
// they teach the input shape as much as they accelerate it.
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

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric"
  });
}

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

function SOPCards({ sops }: { sops: SOPRef[] }) {
  if (sops.length === 0) return null;
  return (
    <div>
      <p className="mb-2 text-xs font-medium text-muted-foreground">
        Relevant SOPs
      </p>
      <div className="flex flex-col gap-2">
        {sops.map((sop) => (
          <Card
            key={sop.title + String(sop.score)}
            className="flex-row items-center justify-between gap-3 px-4 py-3"
          >
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="truncate text-sm font-medium">
                  {sop.title}
                </span>
                {/* Orange appears only on white/cream surfaces — this badge
                    sits on a white card. */}
                <Badge className="border-brand-orange/30 bg-brand-orange/10 text-brand-orange">
                  {sop.category}
                </Badge>
              </div>
              {formatDate(sop.last_edited) && (
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Last edited {formatDate(sop.last_edited)}
                </p>
              )}
            </div>
            {sop.source_url && (
              <a
                href={sop.source_url}
                target="_blank"
                rel="noreferrer"
                className="shrink-0 text-sm font-medium text-brand-teal underline-offset-4 hover:underline"
              >
                Open in Notion
              </a>
            )}
          </Card>
        ))}
      </div>
    </div>
  );
}

function PendingSOPs() {
  return (
    <div>
      <p className="mb-2 text-xs font-medium text-muted-foreground">
        Relevant SOPs
      </p>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-14 w-full rounded-xl" />
        <Skeleton className="h-14 w-full rounded-xl" />
      </div>
    </div>
  );
}

export default function App() {
  const [input, setInput] = useState("");
  const [blockedReason, setBlockedReason] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const agent = useAgent<ChatAgent>({ agent: "ChatAgent" });

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
    setInput("");
    requestAnimationFrame(resizeComposer);
  }, [input, isStreaming, sendMessage, resizeComposer]);

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

  // One composer, two homes: centered on the empty screen (Claude-style),
  // docked at the bottom once the conversation starts. The PHI notice stays
  // directly above it in both, per spec — never dismissible.
  const composer = (
    <div>
      <Alert className="mb-3 border-brand-teal/25 bg-brand-cream">
        <AlertDescription className="text-foreground/80">
          Prototype. Do not paste patient names, dates of birth, MRNs, contact
          details, or anything identifying. Use invented scenarios.
        </AlertDescription>
      </Alert>
      <div className="rounded-2xl border bg-white shadow-sm transition-colors focus-within:border-brand-teal/40 focus-within:ring-2 focus-within:ring-brand-teal/10">
        <Textarea
          ref={textareaRef}
          rows={1}
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
          placeholder="Paste the situation. No patient identifiers."
          className="max-h-[200px] min-h-12 resize-none border-0 bg-transparent px-4 pt-3 shadow-none focus-visible:border-transparent focus-visible:ring-0"
        />
        <div className="flex items-center justify-between gap-2 px-3 pb-2.5">
          <span className="pl-1 text-xs text-muted-foreground">
            Enter to send · Shift+Enter for a new line
          </span>
          {isStreaming ? (
            <Button variant="outline" size="sm" onClick={() => void stop()}>
              Stop
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={submit}
              disabled={!input.trim()}
              className="bg-brand-teal text-white hover:bg-brand-orange"
            >
              Send
            </Button>
          )}
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
    <div className="flex h-full flex-col">
      <header className="h-14 shrink-0 border-b bg-white">
        <div className="mx-auto flex h-full w-full max-w-3xl items-center justify-between px-4">
          <div className="flex items-baseline gap-3">
            <span className="text-lg font-semibold text-brand-teal">
              Cortex
            </span>
            <span className="text-sm text-muted-foreground">
              Mindspan operations
            </span>
          </div>
          {hasConversation && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground"
                >
                  Clear conversation
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Clear this conversation?</AlertDialogTitle>
                  <AlertDialogDescription>
                    All messages in this conversation will be deleted for
                    everyone. This can't be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() => void agent.stub.clearConversation()}
                  >
                    Clear conversation
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      </header>

      {hasConversation ? (
        <>
          <ScrollArea className="min-h-0 flex-1">
            <main className="mx-auto w-full max-w-3xl px-4 py-6">
              <div className="flex flex-col gap-6">
                {visibleMessages.map((message) =>
                  message.role === "user" ? (
                    <div key={message.id} className="flex justify-end">
                      <Card className="max-w-[80%] bg-secondary px-4 py-3 text-[15px] whitespace-pre-wrap">
                        {textOf(message)}
                      </Card>
                    </div>
                  ) : (
                    <div key={message.id} className="flex flex-col gap-4">
                      {sopsOf(message) && <SOPCards sops={sopsOf(message)!} />}
                      {textOf(message).trim() && (
                        <div className="text-[15px] leading-relaxed">
                          <Streamdown>{textOf(message)}</Streamdown>
                        </div>
                      )}
                    </div>
                  )
                )}
                {awaitingSops && <PendingSOPs />}
                <div ref={bottomRef} />
              </div>
            </main>
          </ScrollArea>
          <div className="shrink-0 border-t bg-white">
            <div className="mx-auto w-full max-w-3xl px-4 py-3">{composer}</div>
          </div>
        </>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <main className="mx-auto flex min-h-full w-full max-w-2xl flex-col justify-center px-4 py-10">
            <h1 className="text-center text-3xl font-semibold tracking-tight text-brand-teal">
              What's the situation?
            </h1>
            <p className="mt-2 text-center text-sm text-muted-foreground">
              Paste it below — Cortex finds the relevant SOPs and walks you
              through the steps.
            </p>
            <div className="mt-8">{composer}</div>
            <div className="mt-5 flex flex-wrap justify-center gap-2">
              {QUICK_STARTS.map((qs) => (
                <Button
                  key={qs.label}
                  variant="outline"
                  size="sm"
                  className="rounded-full bg-white text-muted-foreground hover:text-foreground"
                  onClick={() => insertQuickStart(qs.template)}
                >
                  {qs.label}
                </Button>
              ))}
            </div>
            <p className="mt-8 text-center text-xs text-muted-foreground">
              A good paste covers: what happened, who's involved (by role only —
              "a caregiver", "the patient's son"), what's been tried, and how
              urgent it is.
            </p>
          </main>
        </ScrollArea>
      )}
    </div>
  );
}
