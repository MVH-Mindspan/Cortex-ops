// Every user-facing string lives here so one person can review every word in
// one file — client copy and the lines the Worker streams alike. Voice rules:
// calm tool, never chatty companion; no emoji, no exclamation marks;
// wait-strings must be true of the actual pipeline; errors name who to contact.

import type { PipelineErrorKind } from "./pipeline";
import type { ReadingPreferences } from "./reading-preferences";
import type { GuideExample } from "./guide";

// Answer-style menu in the composer toolbar. `menuLabel` names the control
// for assistive tech; the option labels double as the trigger text.
export const READING_PREFERENCES_COPY = {
  menuLabel: "Answer style",
  length: {
    label: "Answer length",
    options: [
      { value: "concise", label: "Concise" },
      { value: "detailed", label: "Detailed" }
    ]
  },
  familiarity: {
    label: "Mindspan familiarity",
    options: [
      { value: "new", label: "New to Mindspan" },
      { value: "experienced", label: "Experienced" }
    ]
  },
  hint: "Applies to your next answer. Remembered in this browser."
} as const;

function optionLabel(
  options: readonly { value: string; label: string }[],
  value: string
): string {
  return options.find((option) => option.value === value)?.label ?? value;
}

// Trigger text for the answer-style menu: the current choice, so the values
// that shape the next answer are visible without opening it.
export function readingPreferencesSummary(value: ReadingPreferences): string {
  const { length, familiarity } = READING_PREFERENCES_COPY;
  return `${optionLabel(length.options, value.length)} · ${optionLabel(familiarity.options, value.familiarity)}`;
}

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
  "Steps come from the SOPs — the links open the source in Notion. Team names are a steer from the team structure, not an SOP instruction.";

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

// Heading above the SOP result cards under an answer.
export const SOP_CARDS_HEADING = "Relevant SOPs";

// Chip on an SOP whose frontmatter status is "draft" (cards, library rows,
// pinned rows). The tooltip states a fact and stops there: whether staff
// should follow a draft is an open policy question, not ours to answer.
export const DRAFT_BADGE = "Draft";
export const DRAFT_BADGE_TITLE = "Not yet reviewed.";

// Chip on a card whose SOP the answer actually cited, set by the citation
// repair. States what happened, not how well it went.
export const SOP_CITED_BADGE = "Cited";

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

// Shown in place of a citation quote the model did not reproduce word for
// word. The SOP is real and linked; only the wording is unverified, so the
// line sends the reader to the source rather than claiming an error.
export const CITATION_UNMATCHED_NOTE =
  "Not found word for word in this SOP. Open it to check the wording:";

// Shown when a citation names an SOP that was not among the ones retrieved
// for this answer, so there was nothing to check it against.
export const CITATION_UNKNOWN_SOP_NOTE =
  "Not one of the SOPs found for this answer, so it could not be checked.";

// Three garbled generations in a row (the fp8 collapse guard gave up).
export const DEGENERATE_GIVE_UP_LINE =
  "The answer came back garbled three times in a row. Send the message again.";

// Appended when the model hit its output limit. It no longer names the
// citations as the place the cut fell: the Worker rebuilds that section from
// retrieval, so a truncated answer can now end with the citations intact.
export const ANSWER_CUT_SHORT_LINE =
  "This answer ran long and was cut short. Ask about one part of the situation at a time to get the rest.";

// Message length cap (shared by the composer counter and the server refusal).
export function messageTooLongLine(max: number): string {
  return `Cortex reads up to ${max.toLocaleString("en-US")} characters per message. Trim this one to the details that matter, then send it again.`;
}
export function composerCounter(count: number, max: number): string {
  return `${count.toLocaleString("en-US")} / ${max.toLocaleString("en-US")}`;
}

// Sidebar label for a recent situation: the first non-empty line, so a
// message that leads with a headline (deep links do) is titled by it. Typed
// messages get the same rule; entries already stored keep their old title.
export function recentTitle(text: string, max = 48): string {
  const line = text.split(/\r?\n/).find((l) => l.trim().length > 0);
  return (line ?? text).trim().slice(0, max);
}

// --- Composer and sidebar copy ---

export const PHI_FOOTER =
  "Do not paste patient names, dates of birth, or contact details. Patient numbers, chart numbers, and MRNs are fine.";
export const PHI_WARNING = `Prototype. ${PHI_FOOTER}`;
export const COMPOSER_PLACEHOLDER =
  "Paste the situation. No names or contact info.";
export const COMPOSER_PLACEHOLDER_FOLLOW_UP =
  "Add detail or paste another situation";

// "Reach out" menu reasons. All three open the same Slack DM; the reasons
// are guidance for the person reaching out (see REACH_OUT_STARTERS).
export const REACH_OUT_REASONS: { label: string; hint: string }[] = [
  { label: "Request a new SOP", hint: "No SOP covers your situation" },
  { label: "Report an issue", hint: "Something's broken or wrong" },
  { label: "Ask a question", hint: "Anything else" }
];

// Scenario templates mirror the ops team's highest-volume task types
// (operator's Month-2 mix). Every template is an invented, identifier-free
// scenario — they teach the input shape as much as they accelerate it.
export const QUICK_STARTS: { label: string; template: string }[] = [
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

// Coverage is a model judgment; these lines do not claim semantic validation.
export const COVERAGE_PARTIAL_LINE =
  "The SOPs cover part of this request. See Not covered by the SOPs.";
// No SOP covers the request, but retrieval still found related ones (this
// line only fires when cards were retrieved and shown). Point the reader at
// them rather than dead-ending: "the closest SOPs are below" pairs with the
// SOP_CARDS_HEADING_RELATED heading the client uses on a blocked answer.
export const COVERAGE_NONE_LINE =
  "No SOP directly covers this. The closest SOPs are below — check those, then ask your team lead if they do not answer it.";
export const COVERAGE_UNCONFIRMED_LINE =
  "Cortex could not confirm SOP coverage for this request. The closest SOPs are below; ask your team lead if they do not answer it.";
// Heading above the cards on a blocked-coverage answer (none or unconfirmed):
// they were retrieved but not cited, so they are offered as related, not as
// the source of steps.
export const SOP_CARDS_HEADING_RELATED = "Related SOPs";

// --- How to use Cortex (the onboarding flow) ---

// One label for one intent: the sidebar row and the empty-state link.
export const GUIDE_LINK = "How to use Cortex";

// Shown in the composer toolbar next to Send, and in the onboarding replica.
export const MODEL_LABEL = "llama-3.3-70b";

// Five screens, one idea each: a headline, one or two sentences, and a live
// visual built from the real components. The words stay short because the
// visual does the explaining. Every claim here must stay true of the
// pipeline it describes.
export const ONBOARDING_COPY = {
  skip: "Skip",
  next: "Next",
  back: "Back",
  screens: {
    paste: {
      title: "Paste the situation. Get the procedure.",
      body: "For Mindspan operations staff: caregiver calls, insurer emails, missing orders. Leave out names, dates of birth, and contact details. Patient, chart, and MRN numbers are fine."
    },
    shape: {
      title: "Every answer has the same shape.",
      body: "Tap a part to see what it is for."
    },
    source: {
      title: "Every step points back to its SOP.",
      body: "The cards under an answer open the page in Notion.",
      notes: [
        {
          term: "Cited",
          meaning: "The answer quoted this SOP, word for word."
        },
        { term: "Draft", meaning: "Not yet reviewed." },
        {
          term: "Pin",
          meaning: "Keeps the SOP in your sidebar on this device. Try it."
        }
      ]
    },
    followUp: {
      title: "Ask again. It keeps the situation in view.",
      body: "A follow-up is grounded again, so it can surface a different SOP. Start a new situation when the topic changes.",
      shortened: "Shortened here. A real answer has every section.",
      styleNote:
        "Answer style, next to Send: Concise or Detailed, New to Mindspan or Experienced."
    },
    tryOne: {
      title: "Try one now.",
      body: "Tap a situation to drop it into the box."
    }
  },
  // What each answer heading is for, keyed by the heading exactly as the
  // answer prints it. Shown under the chips on the "same shape" screen.
  sections: [
    {
      heading: "Situation",
      meaning: "One line, so a colleague can pick it up."
    },
    {
      heading: "Urgency",
      meaning: "Now, Today, or This week, and why."
    },
    {
      heading: "Who handles this",
      meaning:
        "The team and function that likely owns the work. A steer from the team structure, not an SOP instruction."
    },
    {
      heading: "Answer",
      meaning: "For a question about a rule or a term: the rule, from the SOP."
    },
    {
      heading: "Do now",
      meaning:
        "The steps that stop the problem getting worse. If someone is waiting, contacting them is here."
    },
    {
      heading: "Then",
      meaning: "The investigation and the fix, in the order the SOP gives."
    },
    {
      heading: "Tell the patient",
      meaning: "A script that says only what the SOP allows."
    },
    {
      heading: "Stop and escalate",
      meaning: "When to stop, and who to hand to."
    },
    { heading: "Done when", meaning: "The end state that means you can stop." },
    {
      heading: "What the SOPs say",
      meaning:
        "The sentence each step rests on, quoted word for word, with a link to the SOP."
    },
    {
      heading: "Not covered by the SOPs",
      meaning: "Any gap, and who to ask about it."
    },
    {
      heading: "One question",
      meaning:
        "Asked only when the right path depends on something you did not say."
    }
  ]
};

// Real conversations, captured from the pipeline and trimmed for length:
// every heading kept, long step lists cut, quotes left word for word. The
// SOP cards are the ones the Worker emitted. Prompts are the eval fixtures
// (scripts/eval/questions.json), already identifier-free.
// Captured 14 Sep 2026 through the eval Worker (scripts/eval) with keyword
// mode "or", the only mode returning chunks that day. Trims: "Before you
// start" dropped, Then cut to one step, one or two quotes kept, cards cut to
// the top three (the cited card always among them). Quotes are verbatim.
export const GUIDE_EXAMPLES: GuideExample[] = [
  {
    id: "follow-up",
    label: "A follow-up that changes the answer",
    turns: [
      {
        role: "user",
        text: "Which ICD-10 goes on an amyloid PET order?"
      },
      {
        role: "assistant",
        text: 'Who handles this: Likely the Care Support team, Provider & Clinic Support function, because the team structure gives it the day-to-day needs of active clinics and clinic operations questions.\n\nAnswer: The ICD-10 code for an amyloid PET order is chosen by the prescriber from the list of Medicare-covered codes: G31.84, R41.3, G30.0, G30.1, G30.9.\n\nWhat the SOPs say\n\n1. [Imaging Order Requirements — Amyloid PET & MRI Checklist (DRAFT — Needs Review)](https://app.notion.com/p/Imaging-Order-Requirements-Amyloid-PET-MRI-Checklist-DRAFT-Needs-Review-3cdb5943d52d81a19494e5a6545f2a20), Amyloid PET orders — required before sending\n   "Medicare-covered ICD-10 on the order. Codes VRI has accepted: G31.84, R41.3, G30.0, G30.1, G30.9 — the prescriber selects the clinically correct one (ops never adds or changes codes; route to the provider per External Facility & Provider Calls)."\n\nNot covered by the SOPs\nNothing',
        sops: [
          {
            title:
              "🧠 Imaging Order Requirements — Amyloid PET & MRI Checklist (DRAFT — Needs Review)",
            category: "SOP",
            last_edited: "2026-08-31T23:18:00.000Z",
            source_url:
              "https://app.notion.com/p/Imaging-Order-Requirements-Amyloid-PET-MRI-Checklist-DRAFT-Needs-Review-3cdb5943d52d81a19494e5a6545f2a20",
            score: 0.8812477588653564,
            file: "imaging-order-requirements-amyloid-pet-mri-checklist-draft-needs-review.md",
            status: "draft",
            cited: true,
            quote:
              "Medicare-covered ICD-10 on the order. Codes VRI has accepted: G31.84, R41.3, G30.0, G30.1, G30.9 — the prescriber selects the clinically correct one (ops never adds or changes codes; route to the provider per External Facility & Provider Calls)."
          },
          {
            title:
              "🛡️ Insurance Verification & Prior Authorization (DRAFT — Needs Review)",
            category: "SOP",
            last_edited: "2026-08-31T23:17:00.000Z",
            source_url:
              "https://app.notion.com/p/Insurance-Verification-Prior-Authorization-DRAFT-Needs-Review-3cdb5943d52d81d48ecbe16b2000c326",
            score: 0.1759306788444519,
            file: "insurance-verification-prior-authorization-draft-needs-review.md",
            status: "draft"
          },
          {
            title: "📋 Chart Prep — Initial & Follow-Up Visits",
            category: "SOP",
            last_edited: "2026-08-31T22:58:00.000Z",
            source_url:
              "https://app.notion.com/p/Chart-Prep-Initial-Follow-Up-Visits-344b5943d52d8157bc76d44367c1b9ba",
            score: 0.0224993284791708,
            file: "chart-prep-initial-follow-up-visits.md"
          }
        ]
      },
      {
        role: "user",
        text: "And if the prescriber is unreachable today?"
      },
      {
        role: "assistant",
        text: 'Situation: The prescriber is unreachable to select the clinically correct Medicare-covered ICD-10 code for an amyloid PET order.\n\nUrgency: Today, because the order needs to be sent to the facility.\n\nWho handles this: Likely the Care Support team, Provider & Clinic Support function, because the team structure gives it the day-to-day needs of active clinics and clinic operations questions.\n\nDo now\n1. Try to reach the prescriber through other channels, such as a message or a call to their office. Expect to see a response or a return call. If not, go to Stop and escalate.\n\nThen\n2. If the prescriber is still unreachable, route the issue to the provider per External Facility & Provider Calls, as the SOP says the prescriber selects the code. Expect to see the issue assigned to the provider.\n3. Wait for the provider\'s response with the selected code. Expect to see the code and the order updated.\n\nTell the patient\n"We are waiting to hear back from your prescriber to complete your amyloid PET order. We will let you know as soon as it is ready."\n\nStop and escalate\n- If the prescriber is unreachable and the order cannot be completed: The SOPs name no one for this. Ask your team lead. This likely sits with the Care Support team, Provider & Clinic Support function.\n\nDone when\nThe prescriber has selected the clinically correct Medicare-covered ICD-10 code and the order is updated.\n\nWhat the SOPs say\n\n1. [Imaging Order Requirements — Amyloid PET & MRI Checklist (DRAFT — Needs Review)](https://app.notion.com/p/Imaging-Order-Requirements-Amyloid-PET-MRI-Checklist-DRAFT-Needs-Review-3cdb5943d52d81a19494e5a6545f2a20), Amyloid PET orders — required before sending\n   "Medicare-covered ICD-10 on the order. Codes VRI has accepted: G31.84, R41.3, G30.0, G30.1, G30.9 — the prescriber selects the clinically correct one (ops never adds or changes codes; route to the provider per External Facility & Provider Calls)."\n\nNot covered by the SOPs\n- What to do when the prescriber is unreachable and the order is urgent. The SOPs do not say. Ask the Care Support team, Provider & Clinic Support function, or your team lead.\n\nOne question\nIs there another prescriber available to select the ICD-10 code today?',
        sops: [
          {
            title:
              "🧠 Imaging Order Requirements — Amyloid PET & MRI Checklist (DRAFT — Needs Review)",
            category: "SOP",
            last_edited: "2026-08-31T23:18:00.000Z",
            source_url:
              "https://app.notion.com/p/Imaging-Order-Requirements-Amyloid-PET-MRI-Checklist-DRAFT-Needs-Review-3cdb5943d52d81a19494e5a6545f2a20",
            score: 0.8215833306312561,
            file: "imaging-order-requirements-amyloid-pet-mri-checklist-draft-needs-review.md",
            status: "draft",
            cited: true,
            quote:
              "Medicare-covered ICD-10 on the order. Codes VRI has accepted: G31.84, R41.3, G30.0, G30.1, G30.9 — the prescriber selects the clinically correct one (ops never adds or changes codes; route to the provider per External Facility & Provider Calls)."
          },
          {
            title:
              "🛡️ Insurance Verification & Prior Authorization (DRAFT — Needs Review)",
            category: "SOP",
            last_edited: "2026-08-31T23:17:00.000Z",
            source_url:
              "https://app.notion.com/p/Insurance-Verification-Prior-Authorization-DRAFT-Needs-Review-3cdb5943d52d81d48ecbe16b2000c326",
            score: 0.017474491149187088,
            file: "insurance-verification-prior-authorization-draft-needs-review.md",
            status: "draft"
          },
          {
            title: "📋 Chart Prep — Initial & Follow-Up Visits",
            category: "SOP",
            last_edited: "2026-08-31T22:58:00.000Z",
            source_url:
              "https://app.notion.com/p/Chart-Prep-Initial-Follow-Up-Visits-344b5943d52d8157bc76d44367c1b9ba",
            score: 0.006896953098475933,
            file: "chart-prep-initial-follow-up-visits.md"
          }
        ]
      }
    ]
  },
  {
    id: "on-the-phone",
    label: "A patient on the phone",
    turns: [
      {
        role: "user",
        text: "A patient wants their imaging results explained. They're asking me directly on the phone. What do I tell them?"
      },
      {
        role: "assistant",
        text: 'Situation: A patient is asking for an explanation of their imaging results over the phone. The patient needs to be told what operations staff may share and what must come from a clinician.\n\nUrgency: Now. The patient is on the phone and waiting for a response.\n\nWho handles this: Likely the Care Support team, Patient Support function, because the team structure gives it the patient lifecycle and care coordinators sit here.\n\nDo now\n1. Tell the patient that you can share the status and logistics of their imaging results, but not the interpretation of the results themselves. Expect to see the patient understand that you cannot provide a diagnosis or explanation of the results.\n2. Offer to point the patient to the portal copy of their results or send them via the records process, but only if the results have been reviewed and released by the provider. Expect to see the patient acknowledge your offer.\n\nThen\n3. Flag the provider in Athena that the patient is asking about their results, so the provider can review and discuss the results with the patient. Expect to see the flag in Athena.\n\nTell the patient\n"I can tell you that your imaging results are in and have been reviewed by the provider. However, I\'m not able to interpret the results or provide a diagnosis. The provider will be in touch with you to discuss the results and answer any questions you may have. Would you like me to point you to the portal copy of your results or send them to you via our records process?"\n\nStop and escalate\n- If the patient is anxious or confused about their results: The SOPs name the care team for clinical questions. Route the patient to the care team as a routine clinical message.\n\nDone when\nThe patient has been told what operations staff may share and what must come from a clinician, and the provider has been flagged to discuss the results with the patient.\n\nWhat the SOPs say\n\n1. [Results & Next-Steps Requests (DRAFT — Needs Review)](https://app.notion.com/p/Results-Next-Steps-Requests-DRAFT-Needs-Review-3cdb5943d52d8189bde6c232816f049f), Step 2. What ops may share\n   "Never: interpretation of an unreviewed result, reading values or impressions from a report the provider hasn\'t released, or reassurance/concern about what a result means."\n2. [Results & Next-Steps Requests (DRAFT — Needs Review)](https://app.notion.com/p/Results-Next-Steps-Requests-DRAFT-Needs-Review-3cdb5943d52d8189bde6c232816f049f), Quick-Reference Checklist\n   "Only status/logistics shared for unreviewed results; no interpretation by ops"\n\nNot covered by the SOPs\n- Nothing.',
        sops: [
          {
            title: "Post-Visit Checklist SOP",
            category: "SOP",
            last_edited: "2026-09-01T17:56:00.000Z",
            source_url:
              "https://app.notion.com/p/Post-Visit-Checklist-SOP-3c1b5943d52d80a0b30ddfe9f2e75bed",
            score: 0.2364109605550766,
            file: "post-visit-checklist-sop.md"
          },
          {
            title: "📋 Managing the Clinical Inbox",
            category: "SOP",
            last_edited: "2026-09-01T20:09:00.000Z",
            source_url:
              "https://app.notion.com/p/Managing-the-Clinical-Inbox-3acb5943d52d81e3b911d16e0c32aad9",
            score: 0.22495654225349426,
            file: "managing-the-clinical-inbox.md"
          },
          {
            title: "📊 Results & Next-Steps Requests (DRAFT — Needs Review)",
            category: "SOP",
            last_edited: "2026-08-31T23:17:00.000Z",
            source_url:
              "https://app.notion.com/p/Results-Next-Steps-Requests-DRAFT-Needs-Review-3cdb5943d52d8189bde6c232816f049f",
            score: 0.19908550381660461,
            file: "results-next-steps-requests-draft-needs-review.md",
            status: "draft",
            cited: true,
            quote:
              "Never: interpretation of an unreviewed result, reading values or impressions from a report the provider hasn't released, or reassurance/concern about what a result means."
          }
        ]
      },
      {
        role: "user",
        text: "What if it has not been reviewed yet?"
      },
      {
        role: "assistant",
        text: 'Situation: A patient is asking about their imaging results, but they have not been reviewed by the provider yet. The patient needs to be told that the results have arrived, but the provider must review them before they can be shared.\n\nUrgency: Now. The patient is asking about their results and needs a response.\n\nWho handles this: Likely the Care Support team, Patient Support function, because the team structure gives it the patient lifecycle and care coordinators sit here.\n\nDo now\n1. Tell the patient that the imaging results have arrived, but the provider must review them before they can be shared. Expect to see the patient understand that the results are not yet available for discussion.\n2. Flag the provider in Athena that the patient is asking about their results, so the provider can review and discuss the results with the patient. Expect to see the flag in Athena.\n\nThen\n3. Give the patient a specific expectation for when they will hear from the provider, such as "you\'ll hear from us by [day]". Expect to see the patient acknowledge the expectation.\n\nTell the patient\n"Your imaging results have arrived, but the provider needs to review them before we can discuss them with you. The provider will review the results and will be in touch with you by [day] to discuss them. If there\'s anything that needs to be discussed sooner, the clinician will reach out to you."\n\nStop and escalate\n- If the patient is anxious or confused about their results: The SOPs name the care team for clinical questions. Route the patient to the care team as a routine clinical message.\n\nDone when\nThe patient has been told that the results have arrived, but the provider must review them before they can be shared, and the provider has been flagged to review and discuss the results with the patient.\n\nWhat the SOPs say\n\n1. [Results & Next-Steps Requests (DRAFT — Needs Review)](https://app.notion.com/p/Results-Next-Steps-Requests-DRAFT-Needs-Review-3cdb5943d52d8189bde6c232816f049f), Step 3. Resulted but not reviewed\n   "Tell the patient the result has arrived and the provider will review it; give a specific expectation (e.g., \'you\'ll hear from us by [day]\')."\n\nNot covered by the SOPs\n- Nothing.',
        sops: [
          {
            title: "📊 Results & Next-Steps Requests (DRAFT — Needs Review)",
            category: "SOP",
            last_edited: "2026-08-31T23:17:00.000Z",
            source_url:
              "https://app.notion.com/p/Results-Next-Steps-Requests-DRAFT-Needs-Review-3cdb5943d52d8189bde6c232816f049f",
            score: 0.965302586555481,
            file: "results-next-steps-requests-draft-needs-review.md",
            status: "draft",
            cited: true,
            quote:
              "If the provider's review surfaces something needing discussion, the clinician makes that call — ops schedules it."
          },
          {
            title: "Post-Visit Checklist SOP",
            category: "SOP",
            last_edited: "2026-09-01T17:56:00.000Z",
            source_url:
              "https://app.notion.com/p/Post-Visit-Checklist-SOP-3c1b5943d52d80a0b30ddfe9f2e75bed",
            score: 0.4797479510307312,
            file: "post-visit-checklist-sop.md"
          },
          {
            title:
              "🧭 Misrouted & Missing Orders — Cross-System Reconciliation (DRAFT — Needs Review)",
            category: "SOP",
            last_edited: "2026-08-31T23:16:00.000Z",
            source_url:
              "https://app.notion.com/p/Misrouted-Missing-Orders-Cross-System-Reconciliation-DRAFT-Needs-Review-3cdb5943d52d81afadb3fc3c6448a68a",
            score: 0.366950660943985,
            file: "misrouted-missing-orders-cross-system-reconciliation-draft-needs-review.md",
            status: "draft"
          }
        ]
      }
    ]
  },
  {
    id: "not-covered",
    label: "Nothing covers it",
    turns: [
      {
        role: "user",
        text: "A caregiver is asking whether we validate parking at the clinic. What do I tell them?"
      },
      {
        role: "assistant",
        text: COVERAGE_NONE_LINE,
        sops: [
          {
            title: "🎓 Dementia & Memory Loss Communication Training",
            category: "SOP",
            last_edited: "2026-08-31T22:59:00.000Z",
            source_url:
              "https://app.notion.com/p/Dementia-Memory-Loss-Communication-Training-3adb5943d52d819e9065c620bf662eb3",
            score: 0.09638752788305283,
            file: "dementia-memory-loss-communication-training.md"
          },
          {
            title: "📝 New Clinic Setup (Embed)",
            category: "SOP",
            last_edited: "2026-08-31T22:59:00.000Z",
            source_url:
              "https://app.notion.com/p/New-Clinic-Setup-Embed-335b5943d52d80f2b61becb64c47d0f8",
            score: 0.016270682215690613,
            file: "new-clinic-setup-embed.md"
          },
          {
            title: "📝 Transition to Care Support",
            category: "SOP",
            last_edited: "2026-08-31T22:59:00.000Z",
            source_url:
              "https://app.notion.com/p/Transition-to-Care-Support-335b5943d52d8045b7d3dc166f6f96fe",
            score: 0.016270682215690613,
            file: "transition-to-care-support.md"
          }
        ],
        coverageBlocked: "none"
      }
    ]
  }
];
