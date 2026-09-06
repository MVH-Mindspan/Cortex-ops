// Decides whether a row of the Notion "Ops Document Hub" database should be
// exported to R2 as an indexed SOP. Imports only the UNTITLED sentinel from
// ./notion-props.ts, so the untitled-stub check below can never drift from
// titleOf's own fallback; otherwise pure, so it can be unit-tested with
// node:test.
//
// The export skips two things outright:
//   - Untitled rows: these are Notion template stubs left behind by copying
//     the SOP template. They carry almost no body text, so AI Search ranks
//     them above real SOPs on nearly every query, and they must never be
//     exported. A page whose stored title is literally "Untitled" is
//     treated the same way and skipped as a stub; that is intended, not a
//     false positive to guard against.
//   - The twelve pages listed in EXCLUDED_PAGES, by page id: real, titled
//     pages that are not procedures at all (design docs, trackers, planning
//     lists, a template, a persona reference, a training note, a meeting
//     pre-read). Reference-tagged pages such as Care Navigation Tools,
//     Mindspan Patient Portal, Prior Authorizations, Active Numbers in
//     Regal, Incident Report Template and Where to Log It are deliberately
//     NOT excluded: answers legitimately need to cite them even though they
//     are not SOPs themselves.
//
// A missing "SOP"/"Reference" category only adds a warning; it never drops
// the page. Category data in Notion is unreliable enough that filtering on
// it would fail closed on real SOPs, silently hiding them from search.

import { UNTITLED } from "./notion-props.ts";

export type ExportDecision =
  | { export: true; warning?: string }
  | { export: false; reason: string };

// Keys are dashed lowercase Notion page ids, exactly as the API returns
// them. Notion's "Copy link" instead gives the 32 hex characters undashed;
// insert dashes as 8-4-4-4-12 before pasting one in here (a test checks the
// shape). Entries are grouped by kind and order does not matter, so a new
// page can go anywhere. Title of the excluded page trails each entry as a
// comment.
export const EXCLUDED_PAGES: Readonly<Record<string, string>> = {
  "2e6b5943-d52d-8338-9476-0130cf6a9995":
    "design doc: the team structure is a steer, not an SOP (hard rule 12)", // Operations Teams Structure Overview (Aug 2026 copy, the source of src/lib/teams.ts)
  "335b5943-d52d-801b-b9fd-f7ef047c2c05":
    "design doc: earlier copy of the team structure overview", // Operations Teams Structure Overview (Apr 2026 copy)
  "3ceb5943-d52d-815f-b551-e43a73530969":
    "design doc with unverified channels and names", // Department Routing Map (Cortex) v0.1
  "336b5943-d52d-8077-a784-f028872f2fb9":
    "names people; rule 12 forbids people as handlers", // Current Ops Team
  "336b5943-d52d-8188-abab-dbd9a1d22746": "template, not a procedure", // SOP Template
  "335b5943-d52d-803c-9d8b-f7220ac3ae4d": "planning list, not a procedure", // SOPs TO WRITE
  "3b3b5943-d52d-817a-9781-d0f06edebafa": "planning list, not a procedure", // Punch List
  "372b5943-d52d-81cf-aba3-cc563f632e39": "tracker, not a procedure", // Provider Asks Tracker
  "33bb5943-d52d-803a-9236-cbc65402f6f3": "dashboard, not a procedure", // Ops Metrics Dashboard
  "335b5943-d52d-813b-83c9-d4b637c5aeef": "reference persona, not a procedure", // Mindspan Persona Reference
  "335b5943-d52d-8027-acaf-fb1d685f802a": "training note, not a procedure", // Using AI for Dummies
  "342b5943-d52d-806d-9ecf-d9155fa56212": "meeting pre-read, not a procedure" // Patient Experience Onsite (Kickoff Pre-read)
};

export function exportDecision(page: {
  id: string;
  title: string;
  categories: string[];
}): ExportDecision {
  if (page.title === UNTITLED) {
    return { export: false, reason: "untitled template stub" };
  }
  if (Object.hasOwn(EXCLUDED_PAGES, page.id)) {
    return { export: false, reason: EXCLUDED_PAGES[page.id] };
  }
  const tagged =
    page.categories.includes("SOP") || page.categories.includes("Reference");
  return tagged
    ? { export: true }
    : { export: true, warning: "no SOP/Reference tag" };
}
