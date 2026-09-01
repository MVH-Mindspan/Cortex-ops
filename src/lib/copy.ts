// Every user-facing string lives here so one person can review every word in
// one file — client copy and the lines the Worker streams alike. Voice rules:
// calm tool, never chatty companion; no emoji, no exclamation marks;
// wait-strings must be true of the actual pipeline; errors name who to contact.

import type { PipelineErrorKind } from "./pipeline";

// Time-of-day greeting shown above the empty-state headline. One fixed string
// per band — quiet is what survives the 100th viewing. "Working late." is an
// observation, not a pep talk.
export function greetingForHour(hour: number): string {
  if (hour >= 5 && hour < 12) return "Good morning.";
  if (hour >= 12 && hour < 17) return "Good afternoon.";
  if (hour >= 17 && hour < 21) return "Good evening.";
  return "Working late.";
}

// Retrieval-wait lines, shown sequentially (~2.5s each, hold on the last —
// never loop). Each describes what the Worker is actually doing in the window
// before SOP cards arrive: search, rerank, frontmatter fetch, full-doc read.
export const RETRIEVAL_LINES = [
  "Searching the SOP library",
  "Ranking the closest matches",
  "Pulling titles and Notion links",
  "Reading the top SOPs in full"
] as const;

// Swapped in after ~10s — true: AI Search rate-limit retries back off up to
// ~4.5s before the error line.
export const RETRIEVAL_LONG_WAIT =
  "Still searching — this sometimes takes a few extra seconds";

// Shown while the pre-send name-screen round-trips. That is literally all the
// screen model checks. (It is a server call — never claim "before anything
// leaves your device".)
export const SCREENING_LINE = "Checking for patient names";

// Copy-answer action states.
export const COPY_ANSWER = "Copy answer";
export const COPY_DONE = "Copied";
export const COPY_FAILED = "Couldn't copy — select the text instead";

// Pre-send warnings. Warmer by being more useful: the allowed identifiers
// (patient/chart/MRN numbers) are the policy's own escape hatch.
export function hardBlockWarning(reason: string): string {
  return `This includes ${reason} and will be blocked at send. Identify the patient by chart or patient number instead.`;
}
export function softPIIWarning(reason: string): string {
  return `This might include ${reason}. Worth a second look before sending.`;
}

// Blocked-alert guidance (non-break-glass path). "Nothing has gone into the
// conversation" is true on both paths: client blocks never send; server
// refusals delete the row.
export const BLOCKED_GUIDANCE =
  "Nothing has gone into the conversation. Remove the identifier — patient, chart, and MRN numbers are fine — then send again.";

// One-time hints (localStorage boolean flags — never counters).
export const HINT_FIRST_PIN =
  "Pinned — it'll stay in your sidebar on this device.";
export const HINT_FIRST_ANSWER =
  "Every step above comes from the SOPs — the links open the source in Notion.";

// Gratitude intercept: a bare "thanks" would otherwise burn a full pipeline
// run and come back with the no-match line.
export const THANKS_RE =
  /^(thanks|thank you|thanks so much|ty|thx|cheers)[.! ]*$/i;
export const THANKS_LINE = "Anytime. That one's not in the SOPs.";

// Sidebar / library states.
export const EMPTY_PINS =
  "Pin an SOP from an answer or the library — it stays here";
// "This list" — the recents index (titles) is localStorage-only, but the
// conversations themselves live server-side in the DO, so the claim must be
// scoped to the list.
export const EMPTY_RECENTS =
  "Your situations will show up here. This list stays on this device.";
export const NO_SEARCH_MATCH = "Nothing matches that search";
export const LIBRARY_LOADING = "Fetching the full SOP list";
export const LIBRARY_ERROR =
  "Couldn't load the SOP index. Open the library again to retry — if it keeps failing, tell the Cortex admin.";

// Reach-out starter messages, copied to the clipboard on selection because
// Slack deep links can't pre-fill DM text. Keyed by reason label; reasons
// without a starter leave the clipboard alone.
export const REACH_OUT_STARTERS: Record<string, string> = {
  "Request a new SOP":
    "SOP request from Cortex — the situation (no patient details): [describe it]. Cortex said no SOP covers it.",
  "Report an issue":
    "Cortex issue: [what happened]. Expected: [what should have happened]."
};
export const REACH_OUT_FOOTER = "Opens a Slack DM.";
export const REACH_OUT_FOOTER_COPIED =
  "Starter message copied — paste it into the DM.";

// --- Pipeline lines (streamed by the Worker as assistant text) ---

// Monthly message-count breaker tripped (UsageBudget Durable Object).
export const BUDGET_PAUSED_LINE =
  "Cortex has reached its monthly usage budget, so answers are paused to cap spend. Tell the Cortex admin to raise the budget.";

// Retrieval found nothing — fixed line, the model is not called.
export const NO_MATCH_LINE =
  "No SOP covers this yet. Ask your team lead, then paste their answer here so it can become one.";

// One line per error kind classified by classifyPipelineError. Each names
// what happened, what to do, and who to tell — never a raw provider error.
export const PIPELINE_ERROR_LINES = {
  allocation:
    "The Cloudflare AI daily free allocation is used up, so Cortex can't answer until it resets or the account is upgraded to Workers Paid. Tell the Cortex admin.",
  "spend-limit":
    "Cortex has hit its monthly AI cost cap, so answers are paused. Tell the Cortex admin to raise the AI Gateway spend limit.",
  "context-overflow":
    "This situation has grown too long for Cortex to read in one go. Start a new situation and paste the details that still matter.",
  "rate-limit":
    "Cortex is briefly rate limited. Wait a few seconds, then send the message again.",
  retrieval:
    "Something went wrong while searching the SOPs. Send the message again; if it keeps failing, tell the Cortex admin to check that the AI Search index has finished syncing.",
  generation:
    "The SOPs were found but the answer could not be written. Send the message again; if it keeps failing, tell the Cortex admin."
} as const satisfies Record<PipelineErrorKind, string>;

// Three garbled generations in a row (the fp8 collapse guard gave up).
export const DEGENERATE_GIVE_UP_LINE =
  "The answer came back garbled three times in a row. Send the message again.";

// Appended when the model hit its output limit before the citation sections.
export const ANSWER_CUT_SHORT_LINE =
  "This answer ran long and was cut short before the SOP citations. Ask about one part of the situation at a time to get the rest.";

// Message length cap (shared by the composer counter and the server refusal).
export function messageTooLongLine(max: number): string {
  return `Cortex reads up to ${max.toLocaleString("en-US")} characters per message. Trim this one to the details that matter, then send it again.`;
}
export function composerCounter(count: number, max: number): string {
  return `${count.toLocaleString("en-US")} / ${max.toLocaleString("en-US")}`;
}
