// Parses the "Coverage:" line a later prompt change requires as the literal
// first line of every answer (full | partial | none). The tester's flagged
// failure mode was an answer that wrote four steps for a screen no SOP
// mentions, then admitted "Not covered by the SOPs" only at the bottom, then
// asked the reader for the procedure it had just improvised around. The
// Coverage line lets the model say up front how much of the answer the SOPs
// actually back; the Worker strips the line from the stream before the
// reader sees it and forwards the value as message metadata, and the client
// shows a quiet line for "partial" or "none". This module is the pure
// parsing half: splitting the line off the head of the stream, and counting
// the numbered steps and gap lines an answer actually wrote (so a caller can,
// for example, sanity-check a "full" claim against zero steps). Pure module:
// no imports.
//
// Every regex here runs per line, never with the "m" flag over the whole
// text, and never stacks more than one unbounded quantifier back to back. A
// blank answer (or a garbled one that never closes a section) can be
// thousands of blank lines; matching "^\s*#{0,6}\s*\**\s*heading" with "m"
// over that whole string lets "^" retry at every line start while three
// adjacent "\s*"-shaped groups compete over the very same run of newlines,
// which is quadratic-to-exponential in the number of blank lines. Splitting
// first and testing one line at a time removes both the multi-line "^"
// retries and the adjacent-quantifier ambiguity, so matching stays linear.

export type Coverage = "full" | "partial" | "none";

export const COVERAGE_VALUES: readonly Coverage[] = ["full", "partial", "none"];

// Matched only against the first non-blank line (splitCoverageLine finds
// that line by index, not by letting a leading "\s*" absorb it), so this
// never needs to span more than one line. "(?:\*\*\s*)?" is one group, not
// the separate "(?:\*\*)?" plus a second adjacent "\s*": on an all-whitespace
// line the group deterministically fails closed (no "**" to find) instead of
// leaving a second free-floating "\s*" to compete with the first over the
// same run of spaces, which is what made the old prefix quadratic. The
// trailing "[.\s*]{0,4}" is bounded to punctuation, bold markers, and
// whitespace — never letters — so any other text sharing the line (the model
// sometimes writes "Coverage: partial. Situation: ..." on one line) is left
// for splitCoverageLine to recover as `rest`. The captured value is matched
// case-insensitively and lowercased by the caller.
const COVERAGE_ON_LINE =
  /^\s*(?:\*\*\s*)?coverage\s*[:\-–—]\s*(full|partial|none)\b[.\s*]{0,4}/i;

function isBlank(line: string): boolean {
  return line.trim().length === 0;
}

export function splitCoverageLine(head: string): {
  coverage: Coverage | null;
  rest: string;
} {
  const lines = head.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && isBlank(lines[i])) i++;
  if (i >= lines.length) return { coverage: null, rest: head };

  const match = lines[i].match(COVERAGE_ON_LINE);
  if (!match) return { coverage: null, rest: head };

  // If the match ran to the end of the line, swallow any further blank
  // lines too (so "Coverage: partial\n\nSituation: x" leaves `rest` starting
  // directly at "Situation: x"). If the model shared the line with more text
  // ("Coverage: partial. Situation: x"), that remainder starts `rest`
  // instead and no following lines are touched.
  const remainder = lines[i].slice(match[0].length);
  let restLines: string[];
  if (remainder.length > 0) {
    restLines = [remainder, ...lines.slice(i + 1)];
  } else {
    let j = i + 1;
    while (j < lines.length && isBlank(lines[j])) j++;
    restLines = lines.slice(j);
  }

  return {
    coverage: match[1].toLowerCase() as Coverage,
    rest: restLines.join("\n")
  };
}

// The answer prompt's own heading vocabulary (prompt.ts), matched the way
// the model actually writes a heading: plain text, an ATX heading (up to
// "######"), and/or wrapped in "**" bold markers — but as one combined
// character class with a single "*" quantifier, not several adjacent ones,
// and tested one already-split line at a time so "\s" can never reach across
// a line boundary. Both properties together are what keep this linear.
const WHAT_THE_SOPS_SAY = /^[\s#*]*what the sops say\b/i;
const NOT_COVERED_BY_THE_SOPS = /^[\s#*]*not covered by the sops\b/i;
const ONE_QUESTION = /^[\s#*]*one question\b/i;

// Only a "1." step marker or a "- " gap bullet is ever counted — the exact
// two list shapes the answer prompt's format specifies for steps and gaps.
// Each has one leading "\s*" and nothing after it competes for the same
// characters, so a line that is entirely blank or entirely whitespace fails
// in one linear pass rather than backtracking.
const NUMBERED_LINE = /^\s*\d+\.\s/;
const GAP_LINE = /^\s*-\s/;

// Index of the first line matching `re`, or -1. Shared by countSteps and
// countGaps so both walk the heading vocabulary the same way.
function headingIndex(lines: string[], re: RegExp): number {
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) return i;
  }
  return -1;
}

function countMatchingLines(lines: string[], line: RegExp): number {
  let count = 0;
  for (const l of lines) {
    if (line.test(l)) count += 1;
  }
  return count;
}

// Numbered lines before "What the SOPs say": the "Do now" and "Then" steps.
// The numbered citations under "What the SOPs say" itself ("1. [1] X") are
// not steps and must not count, so anything from that heading on is dropped
// first.
export function countSteps(text: string): number {
  const lines = text.split(/\r?\n/);
  const end = headingIndex(lines, WHAT_THE_SOPS_SAY);
  const scope = end === -1 ? lines : lines.slice(0, end);
  return countMatchingLines(scope, NUMBERED_LINE);
}

// "- " lines under "Not covered by the SOPs", up to "One question" or the
// end of the answer — prompt.ts fixes that heading order, so "One question"
// is the only possible next heading and, being the incident format's last
// section, there is nothing past it to accidentally include. The question
// format has no "One question" section, so its gaps run to the end of the
// answer, which the -1 case here covers. A gapless answer writes "Nothing"
// there, which matches no gap line, so it correctly counts as 0.
export function countGaps(text: string): number {
  const lines = text.split(/\r?\n/);
  const start = headingIndex(lines, NOT_COVERED_BY_THE_SOPS);
  if (start === -1) return 0;
  const afterHeading = lines.slice(start + 1);
  const end = headingIndex(afterHeading, ONE_QUESTION);
  const scope = end === -1 ? afterHeading : afterHeading.slice(0, end);
  return countMatchingLines(scope, GAP_LINE);
}
