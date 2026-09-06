// Deterministic extractor for the rules stated in retrieved SOP passages.
//
// Purpose: a tester watched Cortex quote an SOP's prohibition and then write a
// step that contradicts it. The rule "the prescriber selects the clinically
// correct one (ops never adds or changes codes; route to the provider ...)"
// lives in a parenthetical inside a checklist bullet, and the model compressed
// it away in six runs out of seven, while the same prohibition written as the
// main clause of a step survived every time. So we lift each rule-bearing
// sentence or list item out of the passages onto its own line, and the Worker
// appends the resulting block to the model's request. Placement is the fix:
// the model keeps what it sees as a standalone instruction.
//
// Purity: no imports, no I/O, no clock, no randomness. Same passages in, same
// block out, and the inputs are never mutated. Everything here is string work
// so the Worker can run it on the hot path.
//
// Precision over recall: an SOP rule we miss costs one line of context; a
// false positive is noise the model may quote back at an operator. A survey
// question ("Can you dress yourself on your own?") and a fact about automation
// ("the task closes on its own") both read like autonomy rules to a lexicon
// that is too eager, so the lexicon below is narrow on purpose and the drop
// list is aggressive. Every pattern is a regex literal, never assembled from a
// string at runtime, with the role alternation pasted in, so the cost of each
// term is visible at the call site.

export const RULES_HEADING = "Rules stated in these passages";
export const RULES_BLOCK_MAX_CHARS = 1_500;
export const RULES_MAX_LINES = 12;
export const RULE_MAX_CHARS = 400;
export const RULE_MIN_CHARS = 25;

export type PassageInput = {
  label: number;
  text: string;
  kind: "full" | "chunk";
};

export type Rule = {
  label: number;
  text: string;
  tier: "A" | "B";
  kind: "item" | "checkbox" | "sentence";
  hits: string[];
};

// --- Normalisation ---------------------------------------------------------

const LIST_MARKER = /^\s*(?:[-*+]|\d+[.)])\s+/;
const CHECKBOX_MARKER = /^\[[ xX]\]\s*/;
const MD_LINK = /\[([^[\]\n]{0,200})\]\([^\n)]*\)/g;
const MD_EMPHASIS = /\*\*|__/g;
// An alternation, not a character class: `\p{Extended_Pictographic}` is a
// property escape and cannot be nested inside `[...]`. The three tail
// codepoints are the variation selector, the zero-width joiner and the
// combining enclosing keycap, written as escapes so they stay visible here.
const EMOJI = /\p{Extended_Pictographic}|\uFE0F|\u200D|\u20E3/gu;
const NBSP = /\u00A0/g;
const WHITESPACE = /\s+/g;
// Stripping an emoji out of "(🧭 Misrouted & Missing Orders)" leaves "( M...".
const OPEN_PAREN_GAP = /\(\s+/g;
const CLOSE_PAREN_GAP = /\s+\)/g;

/**
 * Reduce one raw line (or sentence) to the text a reader would see: no list
 * marker, no checkbox, no link targets, no emphasis, no emoji. Em dashes and
 * curly quotes stay — they carry the SOP's voice and cost nothing.
 */
export function normalizeUnit(raw: string): string {
  return raw
    .replace(LIST_MARKER, "")
    .replace(CHECKBOX_MARKER, "")
    .replace(MD_LINK, "$1")
    .replace(MD_EMPHASIS, "")
    .replace(EMOJI, "")
    .replace(NBSP, " ")
    .replace(WHITESPACE, " ")
    .trim()
    .replace(OPEN_PAREN_GAP, "(")
    .replace(CLOSE_PAREN_GAP, ")")
    .trim();
}

// --- Sentences -------------------------------------------------------------

const SENTENCE_BREAK = /(?<=[.!?])\s+(?=[A-Z"(“])/;
const ABBREVIATION_TAIL = /\b(?:e\.g|i\.e|Dr|vs|etc|Mr|Mrs|Ms|No|St|approx)\.$/;
const OPEN_PARENS = /\(/g;
const CLOSE_PARENS = /\)/g;
const STRAIGHT_QUOTES = /"/g;
const OPEN_CURLY_QUOTES = /“/g;
const CLOSE_CURLY_QUOTES = /”/g;

function count(text: string, pattern: RegExp): number {
  return (text.match(pattern) ?? []).length;
}

// A break inside a parenthetical or a quotation is not a sentence end.
function stillOpen(text: string): boolean {
  if (count(text, OPEN_PARENS) > count(text, CLOSE_PARENS)) return true;
  if (count(text, STRAIGHT_QUOTES) % 2 === 1) return true;
  return count(text, OPEN_CURLY_QUOTES) > count(text, CLOSE_CURLY_QUOTES);
}

/**
 * Split a paragraph into sentences, rejoining across a break that lands inside
 * an unbalanced parenthetical or quotation, or straight after an abbreviation.
 */
export function splitSentences(text: string): string[] {
  const sentences: string[] = [];
  let pending = "";
  for (const piece of text.split(SENTENCE_BREAK)) {
    pending = pending === "" ? piece : `${pending} ${piece}`;
    if (stillOpen(pending) || ABBREVIATION_TAIL.test(pending)) continue;
    sentences.push(pending);
    pending = "";
  }
  if (pending !== "") sentences.push(pending);
  return sentences.filter((sentence) => sentence !== "");
}

// --- Units -----------------------------------------------------------------

const HEADING_LINE = /^#{1,6}\s/;
const TABLE_ROW = /^\|/;
const HTML_BLOCK_LINE = /^<\/?(?:details|summary)\b/i;
const BLOCKQUOTE = /^>\s?/;
// Only the draft banner is dropped. Any other callout is prose worth scanning.
const DRAFT_CALLOUT = /DRAFT|needs review/i;
const CHECKBOX_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+\[[ xX]\]/;
const TERMINATED = /[.!?)"”:;]$/;
const STARTS_LOWERCASE = /^[a-z]/;
// "This SOP covers ..." and "It defines ..." describe the document, not the work.
const DESCRIBES_DOCUMENT =
  /^(?:This SOP|It (?:starts|defines|begins|covers|describes))\b/;
const PLACEHOLDER_ONLY = /^\[.*\]$/;

function isListUnit(kind: Rule["kind"]): boolean {
  return kind === "item" || kind === "checkbox";
}

function keepUnit(text: string): boolean {
  if (text.length < RULE_MIN_CHARS) return false;
  if (text.endsWith(":")) return false;
  // A question is never a rule — the intake survey is full of "on your own".
  if (text.endsWith("?")) return false;
  if (PLACEHOLDER_ONLY.test(text)) return false;
  return !DESCRIBES_DOCUMENT.test(text);
}

/**
 * Keep source units whole. Conditions stay attached across sibling list items;
 * nested lead-ins apply only to their own children. Wrapped lines and exception
 * sentences remain part of the same unit. Oversized units are omitted from the
 * repeated block, never shortened into a different rule.
 */
export function passageUnits(
  text: string,
  kind: "full" | "chunk"
): { text: string; kind: Rule["kind"] }[] {
  const units: { text: string; kind: Rule["kind"] }[] = [];
  const contexts: { indent: number; text: string }[] = [];
  let current: { text: string; kind: Rule["kind"]; indent: number } | null =
    null;
  let fenced = false;
  const flush = () => {
    if (!current) return;
    const unit = current;
    current = null;
    if (unit.text.endsWith(":")) {
      contexts.push({
        indent: unit.kind === "sentence" ? -1 : unit.indent,
        text: unit.text
      });
      return;
    }
    units.push({
      text: [...contexts.map((context) => context.text), unit.text].join(" "),
      kind: unit.kind
    });
  };
  for (const rawLine of text.split("\n")) {
    let line = rawLine.trim();
    if (/^(?:```|~~~)/.test(line)) {
      flush();
      contexts.length = 0;
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    if (!line) {
      if (current?.kind === "sentence") flush();
      continue;
    }
    if (
      HEADING_LINE.test(line) ||
      TABLE_ROW.test(line) ||
      HTML_BLOCK_LINE.test(line)
    ) {
      flush();
      contexts.length = 0;
      continue;
    }
    if (BLOCKQUOTE.test(line)) {
      if (DRAFT_CALLOUT.test(line)) {
        flush();
        contexts.length = 0;
        continue;
      }
      line = line.replace(BLOCKQUOTE, "");
    }
    const indent = rawLine.length - rawLine.trimStart().length;
    if (LIST_MARKER.test(line)) {
      flush();
      while (contexts.length && contexts[contexts.length - 1].indent >= indent)
        contexts.pop();
      current = {
        text: normalizeUnit(line),
        kind: CHECKBOX_ITEM.test(line) ? "checkbox" : "item",
        indent
      };
    } else if (
      current &&
      (current.kind === "sentence" || indent > current.indent)
    ) {
      current.text += " " + normalizeUnit(line);
    } else {
      flush();
      contexts.length = 0;
      current = { text: normalizeUnit(line), kind: "sentence", indent };
    }
  }
  flush();
  if (kind === "chunk") {
    const first = units[0];
    if (first && !isListUnit(first.kind) && STARTS_LOWERCASE.test(first.text))
      units.shift();
    const last = units[units.length - 1];
    if (last && !isListUnit(last.kind) && !TERMINATED.test(last.text))
      units.pop();
  }
  return units.filter(
    (unit) => keepUnit(unit.text) && unit.text.length <= RULE_MAX_CHARS
  );
}

// --- Lexicon ---------------------------------------------------------------

// Roles that can own a clinical or billing decision. Pasted into each pattern
// below rather than assembled, because these are regex literals by policy.
const NEVER = /\bnever\b/i;
// "almost never", "was never placed": frequency and history, not prohibition.
const NEVER_AS_FACT =
  /\b(?:almost|often|rarely|was|were|has|have|had|calls?)\s+never\b|\bnever\s+(?:placed|arrived|get|gets|got|used)\b/i;

// must-not, not-allowed and must-come-from fire zero times on today's corpus;
// they are kept because the SOPs still being drafted are written in that voice.
const TIER_A_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: "must-not", pattern: /\bmust(?:\s+not|n['’]t|\s+never)\b/i },
  {
    name: "not-allowed",
    pattern: /\bnot\s+(?:allowed|permitted)\b|\bprohibited\b|\bforbidden\b/i
  },
  // Only the "their" variant. "The task closes on its own" is a fact and "Can
  // you dress yourself on your own?" is a survey question; both are dropped.
  {
    name: "on-their-own",
    pattern:
      /\b(?:never|not|no)\b[^.?]*\bon their own\b|\b(?:ops|staff)\b[^.?]*\bon their own\b/i
  },
  {
    name: "only-role",
    pattern:
      /\bonly\s+(?:the\s+|a\s+|an\s+)?(?:prescriber|prescribing provider|provider|clinician|physician|care navigator|care team|nurse|pharmacist|billing owner|billing|RCM|team lead|compliance|NP|PA|MA|MD)s?\b/i
  },
  {
    name: "role-decides",
    pattern:
      /\b(?:prescriber|prescribing provider|provider|clinician|physician|care navigator|care team|nurse|pharmacist|billing owner|billing|RCM|team lead|compliance|NP|PA|MA|MD)s?\s+(?:selects?|decides?|chooses?|determines?|makes?\s+(?:that|the)\s+call|signs?|approves?|authori[sz]es?)\b/i
  },
  // `by` is optional for a spelled-out role ("chosen prescriber" is still
  // attribution) but required for the initialisms, or "signed PA" — a signed
  // prior authorisation — reads as a rule about a physician assistant.
  {
    name: "by-role",
    pattern:
      /\b(?:chosen|selected|decided|determined|approved|signed|ordered|prescribed)\s+(?:(?:by\s+)?(?:the\s+|a\s+)?(?:prescriber|prescribing provider|provider|clinician|physician|care navigator|care team|nurse|pharmacist|billing owner|billing|RCM|team lead|compliance)s?|by\s+(?:the\s+|a\s+)?(?:NP|PA|MA|MD)s?)\b/i
  },
  // "premeds via prescriber" is how a checklist writes "the prescriber owns
  // this". Narrow: the role has to follow `via` directly.
  {
    name: "via-role",
    pattern:
      /\bvia\s+(?:the\s+|a\s+)?(?:prescriber|prescribing provider|provider|clinician|physician|care navigator|care team|nurse|pharmacist|billing owner|billing|RCM|team lead|compliance|NP|PA|MA|MD)s?\b/i
  },
  {
    name: "route-to-role",
    pattern:
      /\broute[ds]?\s+(?:\w+\s+){0,4}?(?:to|through)\s+(?:the\s+|a\s+|your\s+)?(?:prescriber|prescribing provider|provider|clinician|physician|care navigator|care team|nurse|pharmacist|billing owner|billing|RCM|team lead|compliance|NP|PA|MA|MD)s?\b/i
  },
  // The target of a routing instruction is as often a process as a person:
  // "route through the Patient Records Requests SOP" is the same kind of rule.
  // Three words of slack: that phrase needs all three and "ROI process" needs
  // one, while a fourth would swallow "begin the intake process".
  {
    name: "route-to-process",
    pattern:
      /\broute[ds]?\s+(?:\w+\s+){0,4}?(?:to|through)\s+(?:the\s+)?(?:[\w&-]+\s+){0,3}?(?:SOP|process|policy|protocol)\b/i
  },
  {
    name: "must-come-from",
    pattern:
      /\bmust\s+come\s+from\s+(?:the\s+|a\s+)?(?:prescriber|prescribing provider|provider|clinician|physician|care navigator|care team|nurse|pharmacist|billing owner|billing|RCM|team lead|compliance|NP|PA|MA|MD)/i
  },
  {
    name: "no-by-ops",
    pattern: /\bno\s+[\w/ -]{0,30}\s+by\s+(?:ops|staff)\b/i
  },
  // No `you`: its only firing on the real corpus was "you cannot wait, select
  // Add Primary Insurance", which is an instruction about a form.
  {
    name: "ops-may-not",
    pattern:
      /\b(?:ops|staff|coordinators?)\s+(?:may|can)(?:not|\s+not|['’]t)\b/i
  }
];

// Weaker than tier A: an instruction, not a boundary. "Do not need", "don't
// worry" and friends are ordinary prose, so they are excluded by lookahead.
const DO_NOT =
  /\b(?:do not|don['’]t)\b(?!\s+(?:need|require|have to|worry|hesitate|yet|automatically|currently|always|come to))/i;

/**
 * Decide whether a unit states a rule, and say which terms fired. Hits come
 * back in lexicon order, tier A before the tier B term.
 */
export function matchRule(text: string): {
  tier: "A" | "B" | null;
  hits: string[];
} {
  const hits: string[] = [];
  if (NEVER.test(text) && !NEVER_AS_FACT.test(text)) hits.push("never");
  for (const { name, pattern } of TIER_A_PATTERNS) {
    if (pattern.test(text)) hits.push(name);
  }
  const saysDoNot = DO_NOT.test(text);
  const tier = hits.length > 0 ? "A" : saysDoNot ? "B" : null;
  if (saysDoNot) hits.push("do-not");
  return { tier, hits };
}

// --- Extraction and selection ---------------------------------------------

/** Every rule-bearing unit of one passage, in document order. */
export function extractRules(passage: PassageInput): Rule[] {
  const rules: Rule[] = [];
  for (const unit of passageUnits(passage.text, passage.kind)) {
    const { tier, hits } = matchRule(unit.text);
    if (tier === null) continue;
    rules.push({
      label: passage.label,
      text: unit.text,
      tier,
      kind: unit.kind,
      hits
    });
  }
  return rules;
}

function tierRank(rule: Rule): number {
  return rule.tier === "A" ? 0 : 1;
}

// A checklist line is a reminder of a rule stated in full somewhere above it,
// so it goes last within its passage.
function kindRank(rule: Rule): number {
  return rule.kind === "checkbox" ? 1 : 0;
}

function rankWithinPassage(rules: Rule[]): Rule[] {
  return rules
    .map((rule, index) => ({ rule, index }))
    .sort(
      (a, b) =>
        tierRank(a.rule) - tierRank(b.rule) ||
        kindRank(a.rule) - kindRank(b.rule) ||
        a.index - b.index
    )
    .map((entry) => entry.rule);
}

// `- [12] ` — the two brackets, the dash, and the two spaces.
const LINE_OVERHEAD = 5;

/**
 * Pick the lines for the block: strongest rule from each passage first, then
 * the next from each, so no single SOP crowds the others out. A rule that will
 * not fit the character budget is skipped rather than truncated; the line
 * budget stops the walk outright.
 */
export function selectRules(
  passages: PassageInput[],
  opts?: { maxLines?: number; maxChars?: number }
): Rule[] {
  const maxLines = opts?.maxLines ?? RULES_MAX_LINES;
  const maxChars = opts?.maxChars ?? RULES_BLOCK_MAX_CHARS;
  const groups = [...passages]
    .sort((a, b) => a.label - b.label)
    .map((passage) => rankWithinPassage(extractRules(passage)));

  const chosen: Rule[] = [];
  const seen = new Set<string>();
  let blockChars = RULES_HEADING.length;
  const deepest = Math.max(0, ...groups.map((group) => group.length));

  for (let depth = 0; depth < deepest; depth++) {
    for (const group of groups) {
      const rule = group[depth];
      if (!rule) continue;
      const key = rule.text.toLowerCase();
      if (seen.has(key)) continue;
      if (chosen.length + 1 > maxLines) return chosen;
      const lineChars =
        1 + LINE_OVERHEAD + String(rule.label).length + rule.text.length;
      // Skip, don't stop: one long rule must not suppress every passage after
      // it, and a later short rule may still fit the remaining budget.
      if (blockChars + lineChars > maxChars) continue;
      blockChars += lineChars;
      seen.add(key);
      chosen.push(rule);
    }
  }
  return chosen;
}

/** Render the block the Worker appends, or "" when nothing was extracted. */
export function renderRulesBlock(rules: Rule[]): string {
  if (rules.length === 0) return "";
  const lines = rules.map((rule) => `- [${rule.label}] ${rule.text}`);
  return [RULES_HEADING, ...lines].join("\n");
}
