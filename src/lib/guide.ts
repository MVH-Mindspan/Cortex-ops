// The how-to guide's pure parts: the transcript shape the examples are
// written in, the conversion to the message type the real answer components
// render, and the one-time "seen" flag that opens the guide on first visit.

import type { SOPRef } from "./pipeline";
import type { CortexMessage } from "../server";

export type GuideTurn =
  | { role: "user"; text: string }
  | {
      role: "assistant";
      text: string;
      // The SOP cards under the answer, exactly as the Worker emitted them.
      sops?: SOPRef[];
      // Set on a no-coverage answer so the cards render as "Related SOPs".
      coverageBlocked?: "none" | "unconfirmed";
    };

export type GuideExample = {
  id: string;
  label: string;
  turns: GuideTurn[];
};

// The prompt an example drops into the composer: the first user turn.
export function guidePrompt(example: GuideExample): string {
  const first = example.turns.find((turn) => turn.role === "user");
  return first ? first.text : "";
}

// Deterministic ids so a replayed transcript never re-keys between renders.
export function toGuideMessages(example: GuideExample): CortexMessage[] {
  return example.turns.map((turn, index) => {
    const id = `guide-${example.id}-${index}`;
    if (turn.role === "user") {
      return { id, role: "user", parts: [{ type: "text", text: turn.text }] };
    }
    const parts: CortexMessage["parts"] = [];
    if (turn.sops) parts.push({ type: "data-sops", data: turn.sops });
    parts.push({ type: "text", text: turn.text });
    return {
      id,
      role: "assistant",
      parts,
      metadata: turn.coverageBlocked
        ? { coverage: "none", coverageBlocked: turn.coverageBlocked }
        : undefined
    };
  });
}

// A boolean flag, never a counter, like the other one-time hints. Storage
// failures read as "seen" so a locked-down browser never loops on the guide.
const GUIDE_SEEN_KEY = "cortex-guide-seen";

export function guideSeen(): boolean {
  try {
    return localStorage.getItem(GUIDE_SEEN_KEY) !== null;
  } catch {
    return true;
  }
}

export function markGuideSeen(): void {
  try {
    localStorage.setItem(GUIDE_SEEN_KEY, "1");
  } catch {
    // storage unavailable — the guide stays reachable from the sidebar
  }
}

// The headings an answer prints, in the incident and question formats
// (src/lib/prompt.ts). "Situation:", "Urgency:", "Who handles this:" and
// "Answer:" run inline with their text; the rest sit on their own line above
// a block.
export const ANSWER_HEADINGS = [
  "Situation",
  "Urgency",
  "Who handles this",
  "Answer",
  "Before you start",
  "Do now",
  "Then",
  "Tell the patient",
  "Stop and escalate",
  "Done when",
  "What the SOPs say",
  "Not covered by the SOPs",
  "One question"
] as const;

export type AnswerSection = { heading: string; body: string };

// Splits an answer into its sections so the onboarding can light them up
// one at a time. Text before the first heading is dropped; a heading with
// nothing under it is kept with an empty body.
export function splitAnswerSections(text: string): AnswerSection[] {
  const sections: AnswerSection[] = [];
  let current: AnswerSection | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const heading = ANSWER_HEADINGS.find(
      (h) => line === h || line.startsWith(`${h}:`)
    );
    if (heading) {
      current = {
        heading,
        body: line.slice(heading.length).replace(/^:\s*/, "")
      };
      sections.push(current);
      continue;
    }
    if (!current) continue;
    current.body = current.body ? `${current.body}\n${raw}` : raw;
  }
  return sections.map((s) => ({ ...s, body: s.body.trim() }));
}
