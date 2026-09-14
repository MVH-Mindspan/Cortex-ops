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

// The prompt "Try this" drops into the composer: the first user turn.
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
