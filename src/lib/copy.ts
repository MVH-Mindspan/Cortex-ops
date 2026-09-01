// Every user-facing string added by the delight pass lives here so one person
// can review every word in one file. Voice rules: calm tool, never chatty
// companion; no emoji, no exclamation marks; wait-strings must be true of the
// actual pipeline; errors name who to contact.

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
