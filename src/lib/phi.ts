// Shared PHI tripwire — imported by both the Worker agent and the client
// composer. Pure module: no imports, no side effects.
//
// Medical record, chart, and patient numbers are allowed to stay in messages
// (operator decision 2026-09-01), so there is no MRN block. A bare digit run
// next to an MRN/chart keyword is exempt from the phone rule, so a 10-digit
// MRN is not mistaken for a contact number — but a separator-formatted number
// still blocks as a phone. First match wins and names what tripped.

export type PHICheckResult = { blocked: boolean; reason: string | null };

// Shared so the client button gate, the client screen block, and the server
// refusal all key off one string — the block an operator can break glass past.
export const PII_SCREEN_REASON = "a possible patient name";

const SSN = /(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)/;
const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
// "/" is deliberately not a phone separator so dates like 04/12/1941 never
// read as phone numbers. Digit lookarounds stop matches inside longer runs.
// Global so phoneNotMRN can enumerate every candidate span.
const PHONE =
  /(?<!\d)(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)/g;

const DOB_KEYWORD = /\b(?:d\.?\s?o\.?\s?b|date\s+of\s+birth|born)\b/gi;
const DATE =
  /\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b|\b\d{4}-\d{2}-\d{2}\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}\b/gi;

// "record #" is a separate alternative: \b fails between "#" and whitespace.
// Kept only to exempt MRN-adjacent digit runs from the phone rule.
const MRN_KEYWORD = /\b(?:mrn|chart|record\s+number)\b|\brecord\s*#/gi;

type Span = { start: number; end: number };

function spans(text: string, pattern: RegExp): Span[] {
  const out: Span[] = [];
  for (const m of text.matchAll(pattern)) {
    out.push({ start: m.index, end: m.index + m[0].length });
  }
  return out;
}

// True when any keyword match sits within maxGap characters of any target
// match, in either direction (overlapping counts as a gap of zero).
function near(
  text: string,
  keyword: RegExp,
  target: RegExp,
  maxGap: number
): boolean {
  const keywords = spans(text, keyword);
  if (keywords.length === 0) return false;
  const targets = spans(text, target);
  if (targets.length === 0) return false;
  for (const k of keywords) {
    for (const t of targets) {
      const gap = Math.max(k.start - t.end, t.start - k.end, 0);
      if (gap <= maxGap) return true;
    }
  }
  return false;
}

// Softer "possible PII" heuristics for the live pre-send warning. These are
// deliberately warn-only: they cannot tell a patient name from a staff name
// ("Dr. Musto", "Taiye"), so they advise instead of blocking. The five hard
// identifier patterns above remain the blocking layer.
const NAMED_PHRASE =
  /\b(?:patient(?:'s)?\s+name\s+is|patient\s+(?:named|called))\s+\S+/i;
// Case-sensitive on purpose; excludes Dr (staff are routinely named).
const HONORIFIC_NAME = /\b(?:Mr|Mrs|Ms|Miss)\.?\s+[A-Z][a-z]+/;
// Capitalized street-name words on purpose: keeps "PET CT" and similar
// clinical abbreviations from reading as "<number> ... Ct".
const STREET_ADDRESS =
  /\b\d{1,6}\s+(?:[A-Z][a-z]{1,15}\s){1,3}(?:[Ss]treet|[Ss]t|[Aa]venue|[Aa]ve|[Rr]oad|[Rr]d|[Bb]oulevard|[Bb]lvd|[Ll]ane|[Ll]n|[Dd]rive|[Dd]r|[Cc]ourt|[Cc]t|[Pp]lace|[Pp]l|[Ww]ay)\b/;
const MEMBER_ID =
  /\b(?:member|policy|subscriber|insurance)\s*(?:id|#|number)?\s*[:#]?\s*(?=[A-Za-z0-9-]*\d)[A-Za-z0-9-]{6,}/i;

// A relation word (patient, wife, son...) followed closely by a capitalized
// full name — catches "My patient, Michael Van Havill". Matches whose gap
// contains a preposition ("patient in Valley Radiology") are discarded in
// relationNameHit below.
const RELATION_NAME =
  /\b(?:patient|caregiver|wife|husband|spouse|son|daughter|mother|father|mom|dad)\b([^.!?\n]{0,20}?)\s(?:[A-Z][a-z]+(?:\s+(?:[A-Z][a-z]+|Van|De|La|Da|Le|Mac|Mc))+)\b/g;

function relationNameHit(text: string): boolean {
  for (const match of text.matchAll(RELATION_NAME)) {
    if (
      !/\b(?:in|at|from|to|for|with|the|a|an|of|by|near|on)\b/i.test(match[1])
    ) {
      return true;
    }
  }
  return false;
}
// "<First> <Last>'s chart/visit/..." possessives.
const POSSESSIVE_NAME =
  /\b[A-Z][a-z]+(?:\s+(?:[A-Z][a-z]+|Van|De|La|Da|Le))+['']s\s+(?:chart|visit|appointment|record|file|order|results?)\b/;

export function checkPossiblePII(text: string): string | null {
  if (
    NAMED_PHRASE.test(text) ||
    HONORIFIC_NAME.test(text) ||
    relationNameHit(text) ||
    POSSESSIVE_NAME.test(text)
  ) {
    return PII_SCREEN_REASON;
  }
  if (STREET_ADDRESS.test(text)) return "a possible street address";
  if (MEMBER_ID.test(text)) return "a possible insurance or member ID";
  return null;
}

// Phone numbers stay blocked as contact details. The one exemption: a *bare*
// run of digits (no separators) sitting within 12 characters of an MRN/chart
// keyword is a medical record number the team is allowed to include. A number
// written with separators — 415-555-1234, (415) 555-1234 — is always a contact
// phone, never an MRN, so it blocks even next to the word "chart".
function phoneNotMRN(text: string): boolean {
  const phones = spans(text, PHONE);
  if (phones.length === 0) return false;
  const keywords = spans(text, MRN_KEYWORD);
  return phones.some((p) => {
    if (!/^\d+$/.test(text.slice(p.start, p.end))) return true;
    return !keywords.some(
      (k) => Math.max(k.start - p.end, p.start - k.end, 0) <= 12
    );
  });
}

export function checkPHI(text: string): PHICheckResult {
  if (SSN.test(text)) {
    return { blocked: true, reason: "a Social Security number" };
  }
  if (EMAIL.test(text)) {
    return { blocked: true, reason: "an email address" };
  }
  if (near(text, DOB_KEYWORD, DATE, 20)) {
    return { blocked: true, reason: "a date of birth" };
  }
  if (phoneNotMRN(text)) {
    return { blocked: true, reason: "a phone number" };
  }
  return { blocked: false, reason: null };
}
