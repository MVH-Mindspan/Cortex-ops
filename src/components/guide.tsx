import { useMemo } from "react";
import { GUIDE_COPY, GUIDE_EXAMPLES, GUIDE_TRY } from "@/lib/copy";
import { guidePrompt, toGuideMessages, type GuideExample } from "@/lib/guide";
import {
  AssistantMessage,
  textOf,
  UserBubble,
  type PinnedSOP
} from "@/components/message";
import { PlusIcon } from "@/components/icons";

// The how-to page: who Cortex is for, how to use it, how a conversation
// works, and three example conversations replayed through the same message
// components a real answer uses. Same column as the SOP library. Nothing
// here animates: the page is a replay, not an arrival.
export function Guide({
  onTryExample,
  onNewSituation,
  pinnedKeys,
  onTogglePin
}: {
  onTryExample: (text: string) => void;
  onNewSituation: () => void;
  pinnedKeys: Set<string>;
  onTogglePin: (sop: PinnedSOP) => void;
}) {
  return (
    <div className="mx-auto w-full max-w-[760px] px-6 py-10">
      <h1 className="font-serif text-[28px] text-foreground">
        {GUIDE_COPY.title}
      </h1>
      <p className="mt-1 text-[13px] text-muted-foreground">
        {GUIDE_COPY.lede}
      </p>

      <Section title={GUIDE_COPY.who.title}>
        {GUIDE_COPY.who.paragraphs.map((paragraph) => (
          <Paragraph key={paragraph}>{paragraph}</Paragraph>
        ))}
      </Section>

      <Section title={GUIDE_COPY.how.title}>
        <ol className="flex flex-col gap-5">
          {GUIDE_COPY.how.steps.map((step, index) => (
            <li key={step.title} className="flex gap-3">
              <span className="mt-0.5 w-4 shrink-0 text-right text-[15px] text-muted-foreground">
                {index + 1}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[15px] font-medium text-foreground">
                  {step.title}
                </p>
                <Paragraph className="mt-1">{step.body}</Paragraph>
                {step.glossary && (
                  <dl className="mt-3 grid gap-x-6 gap-y-2.5 min-[640px]:grid-cols-2">
                    {step.glossary.map((entry) => (
                      <div key={entry.term}>
                        <dt className="text-[13px] font-medium text-foreground">
                          {entry.term}
                        </dt>
                        <dd className="text-[13px] leading-snug text-muted-foreground">
                          {entry.meaning}
                        </dd>
                      </div>
                    ))}
                  </dl>
                )}
              </div>
            </li>
          ))}
        </ol>
      </Section>

      <Section title={GUIDE_COPY.conversation.title}>
        {GUIDE_COPY.conversation.paragraphs.map((paragraph) => (
          <Paragraph key={paragraph}>{paragraph}</Paragraph>
        ))}
      </Section>

      <Section title={GUIDE_COPY.examples.title}>
        <Paragraph>{GUIDE_COPY.examples.intro}</Paragraph>
        <div className="mt-2 flex flex-col gap-5">
          {GUIDE_EXAMPLES.map((example) => (
            <Example
              key={example.id}
              example={example}
              onTry={() => onTryExample(guidePrompt(example))}
              pinnedKeys={pinnedKeys}
              onTogglePin={onTogglePin}
            />
          ))}
        </div>
      </Section>

      <button
        type="button"
        onClick={onNewSituation}
        className="mt-12 flex h-[34px] items-center gap-2.5 rounded-full bg-accent px-3 text-[15px] font-medium text-foreground"
      >
        <PlusIcon className="h-4 w-4 text-brand-orange" />
        {GUIDE_COPY.newSituation}
      </button>
    </div>
  );
}

function Section({
  title,
  children
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-10">
      <h2 className="font-serif text-[20px] text-foreground">{title}</h2>
      <div className="mt-3 flex flex-col gap-3">{children}</div>
    </section>
  );
}

function Paragraph({
  className,
  children
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <p
      className={`text-[15px] leading-relaxed text-foreground/85 ${className ?? ""}`}
    >
      {children}
    </p>
  );
}

// One replayed conversation. `fresh` is false throughout: history replays
// never perform an entrance, and this page is all history.
function Example({
  example,
  onTry,
  pinnedKeys,
  onTogglePin
}: {
  example: GuideExample;
  onTry: () => void;
  pinnedKeys: Set<string>;
  onTogglePin: (sop: PinnedSOP) => void;
}) {
  // Stable identities so the memoized answer blocks skip work on pin toggles.
  const messages = useMemo(() => toGuideMessages(example), [example]);
  return (
    <section aria-label={example.label} className="rounded-[12px] border p-5">
      <div className="mb-5 flex items-center justify-between gap-3">
        <p className="min-w-0 text-[13px] text-muted-foreground">
          <span className="text-foreground">{example.label}</span>
          {" · "}
          {GUIDE_COPY.examples.trimmed}
        </p>
        <button
          type="button"
          onClick={onTry}
          aria-label={`${GUIDE_TRY}: ${example.label}`}
          className="pressable flex h-7 shrink-0 items-center rounded-[6px] border px-2 text-[13px] whitespace-nowrap text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          {GUIDE_TRY}
        </button>
      </div>
      <div className="flex flex-col gap-6">
        {messages.map((message) =>
          message.role === "user" ? (
            <UserBubble key={message.id} text={textOf(message)} fresh={false} />
          ) : (
            <AssistantMessage
              key={message.id}
              message={message}
              streaming={false}
              fresh={false}
              pinnedKeys={pinnedKeys}
              onTogglePin={onTogglePin}
            />
          )
        )}
      </div>
    </section>
  );
}
