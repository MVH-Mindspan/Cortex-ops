// A hand-maintained crosswalk from the words operators paste to the words the
// SOPs are written in, applied to the search query only. Orchestration Manager
// tasks arrive in tracker vocabulary — "partner referral", "pre-visit prep",
// codes like CENP-022 — none of which appear in the SOP prose, so a task can
// retrieve nothing while a referral or pre-visit SOP sits right there. Each
// hint appends the SOP-side terms for a concept it detects.
//
// A steer, not a schema (like teams.ts): tune the list as new task shapes miss.
// Additive only — expandSearchQuery never removes the operator's own words, so
// a wrong hint can nudge ranking but can never hide a real match. It shapes the
// text handed to AI Search for retrieval; the generation model always receives
// the untouched message (server.ts passes the original `latest.content`).

export type QueryHint = { match: RegExp; add: string };

export const QUERY_HINTS: readonly QueryHint[] = [
  // Partner/inbound referrals -> the SOPs call this referral acceptance and
  // records handling; "partner referral" and CENP codes appear in no SOP.
  {
    match: /\breferrals?\b/i,
    add: "referral acceptance criteria inbound referral records request"
  },
  // "pre visit" / "pre-visit prep" -> the pre-visit checklist SOPs.
  {
    match: /\bpre[-\s]?visit\b/i,
    add: "pre-visit checklist chart prep before visit"
  }
];

// Append the SOP-side terms for every hint the text triggers. Returns the text
// unchanged when nothing matches, so a query that already speaks SOP is left
// alone. The additions go after a blank line so they read as a separate hint
// block rather than mangling the operator's sentence.
export function expandSearchQuery(
  text: string,
  hints: readonly QueryHint[] = QUERY_HINTS
): string {
  const additions = hints
    .filter((hint) => hint.match.test(text))
    .map((hint) => hint.add);
  return additions.length === 0 ? text : `${text}\n\n${additions.join(" ")}`;
}
