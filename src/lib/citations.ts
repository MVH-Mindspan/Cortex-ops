// Rebuild the "What the SOPs say" block from the SOP text that was actually
// retrieved, instead of trusting what the model retyped. The tester found the
// model recites citations from memory: 3 of 12 links 404, section labels drift
// ("Step2"), a code loses a digit ("G30" for "G30.0") and a quote stops just
// before the sentence's prohibition ("ops never adds or changes codes..."). So
// the model's item is read only as a pointer — which SOP, roughly which
// sentence — and everything rendered (link, section, quote) comes from the
// file the passage was built from. Pure module: no bindings, no I/O, and no
// dynamic regex (every pattern is a literal, so there is no ReDoS surface).
//
// The rules, in the order they run:
// 1. Parse — the held tail becomes a heading, a preamble and numbered items;
//    a heading half-eaten by the stream leaves an orphan "**" that is dropped.
// 2. Resolve — label and title say which file, but a quote found word for word
//    outranks both, and fuzzy matching only runs inside an already-known file.
// 3. Expand — a hit gives up its whole source line, or the sentences it covers
//    when that line is a banner, a table row or longer than QUOTE_MAX_CHARS.
// 4. Render — link, section and quote come from the file; the model's own
//    words appear only as unverified prose, never inside quotation marks.
// 5. Invariants — no URL the model typed survives anywhere, the gaps section
//    always does, and a repair that would lose it hands back the raw tail with
//    nothing cited and the stats zeroed.

import type { FileMeta, SOPRef } from "./pipeline";
import { CITATION_UNKNOWN_SOP_NOTE, CITATION_UNMATCHED_NOTE } from "./copy.ts";
import { displayTitle } from "./linkify.ts";

/** A passage label the prompt handed the model ("[1]") and the file it came
 * from. A label with no file is a label the Worker could not attribute. */
export type CitationLabel = { label: number; file: string | null };

export type CitationContext = {
  labels: CitationLabel[];
  sops: SOPRef[];
  meta: Map<string, FileMeta>;
};

/** One rendered citation, after resolution. `verified` means the quote was
 * found in the file's own text; an unverified source is a real SOP whose
 * wording the model did not reproduce. */
export type CitedSource = {
  file: string;
  section: string | null;
  quote: string | null;
  verified: boolean;
};

export type RepairResult = {
  text: string;
  cited: CitedSource[];
  droppedQuestion: boolean;
  stats: { items: number; matched: number; unmatched: number; unknown: number };
};

// A quote longer than this is cut: card one-liners and the answer body both
// stop being readable past a paragraph.
export const QUOTE_MAX_CHARS = 420;
// Fuzzy acceptance floor. Below this the "quote" is a paraphrase, and a
// paraphrase must never be shown in quotation marks.
export const QUOTE_MATCH_THRESHOLD = 0.75;
// A short string ("TBD — assign at review") matches boilerplate in half the
// corpus, so fuzzy matching needs at least this many tokens to be evidence.
export const QUOTE_MIN_TOKENS = 8;
// Indexing is lazy and capped: a repair reads at most this many files.
export const MAX_INDEXED_FILES = 8;

// --- Normalisation -------------------------------------------------------

// One leading blockquote marker run, then one list/checkbox/number/heading
// marker. Kept separate so a plain blockquote line ("> 🚧 DRAFT") loses its
// marker too, not only "> 1. item".
const BLOCKQUOTE_MARKER = /^[ \t]*(?:>[ \t]*)+/;
const LINE_MARKER =
  /^\s*(?:>\s*)?(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+|#{1,6}\s+)/;
const TABLE_ROW = /^[ \t]*\|.*\|[ \t]*$/;
const TABLE_SEPARATOR_CELL = /^:?-+:?$/;
// The label class is bounded, newline-free and holds no "[" of its own: an
// unmatched bracket must not send the scan to the end of the string, which is
// what made a run of "[" quadratic. No real link label is 200 characters long,
// and a label containing "[" never matched here anyway — excluding it only
// lets the scan find the real link that follows.
const MD_LINK = /\[([^[\]\n]{0,200})\]\([^)\s]*\)/g;
const DETAILS_TAG = /<\/?(?:details|summary)>/g;
const BOLD = /\*\*|__/g;
// An alternation, never a character class: a class of astral emoji and the
// invisible joiners is a well-known way to build a regex that matches the
// wrong halves of a surrogate pair.
const EMOJI = /\p{Extended_Pictographic}|\uFE0F|\u200D|\u20E3/gu;
const NBSP = /\u00A0/g;
const SPACES = /[ \t]+/g;
const STRAIGHT_OR_CURLY_QUOTE = /[“”‘’"']/;
const ALPHANUMERIC = /[\p{L}\p{N}]/u;
const URL = /\(?https?:\/\/\S+\)?/g;

function tableCells(line: string): string[] | null {
  const cells = line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
  if (cells.every((cell) => TABLE_SEPARATOR_CELL.test(cell))) return null;
  return cells.filter((cell) => cell.length > 0);
}

/** One physical line as a reader sees it: markers, table pipes, markdown
 * links, emoji and bold gone. Never collapses newlines — callers pass a
 * single line, and a rendered quote is always one line. */
export function displayLine(raw: string): string {
  let line = raw.replace(BLOCKQUOTE_MARKER, "").replace(LINE_MARKER, "");
  if (TABLE_ROW.test(line)) {
    const cells = tableCells(line);
    if (cells === null) return "";
    line = cells.join("; ");
  }
  return line
    .replace(MD_LINK, "$1")
    .replace(DETAILS_TAG, "")
    .replace(BOLD, "")
    .replace(EMOJI, "")
    .replace(NBSP, " ")
    .replace(SPACES, " ")
    .trim();
}

/** The comparison form: lower case, quotation marks deleted (so "don't" and
 * "dont" agree), dashes folded, everything else a single space. "G30.0"
 * becomes "g30 0" and "G30" stays "g30", which is what lets a fuzzy match
 * notice the missing digit instead of silently accepting it. */
export function matchKey(s: string): string {
  return displayLine(s)
    .toLowerCase()
    .replace(/[“”‘’"']/g, "")
    .replace(/[–—]/g, "-")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

type KeyToken = { text: string; start: number; end: number };

// matchKey with offsets kept, so a matched token span can be mapped back to a
// slice of the display line for sentence expansion. Walks characters rather
// than re-running the regexes so it cannot drift from matchKey: deleting a
// quotation mark joins the token ("don't" -> "dont"), everything else
// non-alphanumeric breaks it.
function keyTokens(display: string): KeyToken[] {
  const out: KeyToken[] = [];
  let start = -1;
  let text = "";
  for (let i = 0; i < display.length; i++) {
    const char = display[i];
    if (STRAIGHT_OR_CURLY_QUOTE.test(char)) continue;
    if (ALPHANUMERIC.test(char)) {
      if (start === -1) start = i;
      text += char.toLowerCase();
      continue;
    }
    if (start !== -1) {
      out.push({ text, start, end: i });
      start = -1;
      text = "";
    }
  }
  if (start !== -1) out.push({ text, start, end: display.length });
  return out;
}

function tokensOf(s: string): string[] {
  return keyTokens(displayLine(s)).map((token) => token.text);
}

// Titles are compared loosely enough that "Prior Authorization" finds an SOP
// called "Prior Authorizations", but not so loosely that "in" and "is" merge.
function stem(token: string): string {
  return token.length >= 4 && token.endsWith("s") ? token.slice(0, -1) : token;
}

// --- Indexing ------------------------------------------------------------

export type IndexedLine = {
  index: number;
  raw: string;
  display: string;
  key: string;
  toks: string[];
  spans: KeyToken[];
  section: string | null;
  quoted: boolean;
  table: boolean;
};

const HEADING = /^[ \t]*#{1,6}[ \t]+\S/;
const FENCE = /^[ \t]*(?:```|~~~)/;
const TRAILING_COLON = /:[ \t]*$/;
const BLOCKQUOTE = /^[ \t]*>/;

function cleanHeading(raw: string): string {
  return displayLine(raw)
    .replace(TRAILING_COLON, "")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .trim();
}

// Every quotable line of a file, each carrying the nearest heading above it.
// Headings, blanks, fenced code and table separators are not quotable.
// Exported so tests can build the input findQuote takes.
export function indexFile(text: string): IndexedLine[] {
  const out: IndexedLine[] = [];
  const lines = text.split("\n");
  let section: string | null = null;
  let fenced = false;
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index];
    if (FENCE.test(raw)) {
      fenced = !fenced;
      continue;
    }
    if (fenced || !raw.trim()) continue;
    if (HEADING.test(raw)) {
      section = cleanHeading(raw) || null;
      continue;
    }
    const display = displayLine(raw);
    if (!display) continue;
    const spans = keyTokens(display);
    if (spans.length === 0) continue;
    out.push({
      index,
      raw,
      display,
      key: spans.map((token) => token.text).join(" "),
      toks: spans.map((token) => token.text),
      spans,
      section,
      quoted: BLOCKQUOTE.test(raw),
      table: TABLE_ROW.test(raw)
    });
  }
  return out;
}

type Indexer = (file: string) => IndexedLine[] | null;

function makeIndexer(meta: Map<string, FileMeta>): Indexer {
  const cache = new Map<string, IndexedLine[] | null>();
  return (file) => {
    const cached = cache.get(file);
    if (cached !== undefined) return cached;
    if (cache.size >= MAX_INDEXED_FILES) return null;
    const found = meta.get(file);
    const lines = found ? indexFile(found.text) : null;
    cache.set(file, lines);
    return lines;
  };
}

// --- Scoring -------------------------------------------------------------

type Quote = { text: string; key: string; toks: string[] };

function prepQuote(raw: string): Quote {
  const display = displayLine(raw.replace(URL, ""));
  const toks = keyTokens(display).map((token) => token.text);
  return { text: display, key: toks.join(" "), toks };
}

// A substring hit only counts on token boundaries: without this, the quote
// "30 0" would match inside "g30 0" and cite the wrong sentence.
function alignedIndexOf(key: string, sub: string): number {
  if (!sub) return -1;
  let at = key.indexOf(sub);
  while (at !== -1) {
    const openEnd = at + sub.length;
    const before = at === 0 || key[at - 1] === " ";
    const after = openEnd === key.length || key[openEnd] === " ";
    if (before && after) return at;
    at = key.indexOf(sub, at + 1);
  }
  return -1;
}

function tokenIndexAt(key: string, charIndex: number): number {
  let count = 0;
  for (let i = 0; i < charIndex; i++) if (key[i] === " ") count++;
  return count;
}

type Coverage = { covered: number; from: number; to: number };

// Greedy in-order coverage: how much of the quote appears in the line, in the
// quote's order. A quote token that is missing is skipped without giving up
// the tokens after it, so one wrong word costs one token, not the match.
function coverage(quote: string[], line: string[]): Coverage {
  let cursor = 0;
  let covered = 0;
  let from = -1;
  let to = -1;
  for (const token of quote) {
    let at = cursor;
    while (at < line.length && line[at] !== token) at++;
    if (at >= line.length) continue;
    if (from === -1) from = at;
    to = at;
    covered++;
    cursor = at + 1;
  }
  return { covered, from, to };
}

function bigrams(toks: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i + 1 < toks.length; i++)
    out.push(`${toks[i]} ${toks[i + 1]}`);
  return out;
}

function bigramOverlap(quote: string[], line: string[]): number {
  const wanted = bigrams(quote);
  if (wanted.length === 0) return 0;
  const found = new Set(bigrams(line));
  let hits = 0;
  for (const pair of wanted) if (found.has(pair)) hits++;
  return hits / wanted.length;
}

export type QuoteHit = {
  line: IndexedLine;
  from: number;
  to: number;
  exact: boolean;
  score: number;
};

// Coverage alone accepts a bag of words in any arrangement; bigrams alone
// punish one dropped word twice. Half of each is what separates the corrupted
// code list (0.97) from a fluent paraphrase of the same sentence (0.14).
function fuzzyScore(
  quote: Quote,
  line: IndexedLine
): Coverage & { value: number } {
  const cover = coverage(quote.toks, line.toks);
  const ratio = quote.toks.length === 0 ? 0 : cover.covered / quote.toks.length;
  const pairs =
    quote.toks.length < 2 ? ratio : bigramOverlap(quote.toks, line.toks);
  return { ...cover, value: 0.5 * ratio + 0.5 * pairs };
}

function exactHits(quote: Quote, lines: IndexedLine[]): QuoteHit[] {
  const out: QuoteHit[] = [];
  if (!quote.key) return out;
  for (const line of lines) {
    const at = alignedIndexOf(line.key, quote.key);
    if (at === -1) continue;
    const from = tokenIndexAt(line.key, at);
    out.push({
      line,
      from,
      to: from + quote.toks.length - 1,
      exact: true,
      score: 1
    });
  }
  return out;
}

function findFuzzy(quote: Quote, lines: IndexedLine[]): QuoteHit | null {
  if (quote.toks.length < QUOTE_MIN_TOKENS) return null;
  let best: QuoteHit | null = null;
  for (const line of lines) {
    const scored = fuzzyScore(quote, line);
    if (scored.from === -1) continue;
    // A quote scattered across a line twice its length is a coincidence, not
    // the sentence the model meant.
    if (scored.to - scored.from + 1 > 2 * quote.toks.length) continue;
    if (scored.value < QUOTE_MATCH_THRESHOLD) continue;
    if (!best || scored.value > best.score) {
      best = {
        line,
        from: scored.from,
        to: scored.to,
        exact: false,
        score: scored.value
      };
    }
  }
  return best;
}

function findPrepared(quote: Quote, lines: IndexedLine[]): QuoteHit | null {
  const exact = exactHits(quote, lines);
  // A quote too short to be evidence is only accepted when the file has
  // exactly one line it could mean.
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    return quote.toks.length >= QUOTE_MIN_TOKENS ? exact[0] : null;
  }
  return findFuzzy(quote, lines);
}

/** Locate one quote in one indexed file. Exported for tests. */
export function findQuote(
  quote: string,
  lines: IndexedLine[]
): QuoteHit | null {
  return findPrepared(prepQuote(quote), lines);
}

// --- Expansion -----------------------------------------------------------

const SENTENCE_SPLIT = /(?<=[.!?])\s+(?=[A-Z“"(])/g;

function sentenceRanges(s: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let start = 0;
  for (const match of s.matchAll(SENTENCE_SPLIT)) {
    out.push({ start, end: match.index });
    start = match.index + match[0].length;
  }
  out.push({ start, end: s.length });
  return out;
}

function sentenceRun(hit: QuoteHit): string {
  const { display, spans } = hit.line;
  const ranges = sentenceRanges(display);
  const startAt = spans[hit.from]?.start ?? 0;
  const endAt = Math.max(0, (spans[hit.to]?.end ?? display.length) - 1);
  const contains = (at: number) =>
    ranges.findIndex((range) => at >= range.start && at < range.end);
  const first = Math.max(0, contains(startAt));
  const last = contains(endAt);
  const to = last === -1 ? ranges.length - 1 : Math.max(first, last);
  return display.slice(ranges[first].start, ranges[to].end).trim();
}

function cap(s: string): string {
  if (s.length <= QUOTE_MAX_CHARS) return s;
  const cut = s.slice(0, QUOTE_MAX_CHARS - 1);
  const at = cut.lastIndexOf(" ");
  return `${(at > 0 ? cut.slice(0, at) : cut).trimEnd()}…`;
}

// The whole source line is the point — it carries the caveat the model cut.
// A blockquote banner or a table row is not a sentence a reader wants whole,
// so those give up only the sentences the quote actually covers.
function expandQuote(hit: QuoteHit): string {
  const whole = hit.line.display;
  const expanded =
    !hit.line.quoted && !hit.line.table && whole.length <= QUOTE_MAX_CHARS
      ? whole
      : sentenceRun(hit);
  return cap(expanded).replace(/["“”]/g, "'");
}

// --- Parsing the held tail -----------------------------------------------

const SOP_HEADING =
  /^[ \t]*(?:#{1,6}[ \t]+)?(?:\*\*|__)?[ \t]*What the SOPs say[ \t]*:?[ \t]*(?:\*\*|__)?[ \t]*(.*)$/i;
const SECTION_END =
  /^[ \t]*(?:#{1,6}[ \t]+)?(?:\*\*|__)?[ \t]*(?:Not covered by the SOPs|One question)\b/im;
const INLINE_SECTION_END =
  /\s(?=(?:\*\*|__)?(?:Not covered by the SOPs|One question)\b)/i;
// The streaming trigger ends the heading on the ":" of the question format
// ("**What the SOPs say:"), so the tail it hands over opens on the orphan half
// of the emphasis run: "** 1. [1] ...". Left in place that run defeats the
// item scan and the whole tail comes back unrepaired.
const ORPHAN_EMPHASIS = /^[ \t]*(?:\*\*|__)[ \t]*/;
const ITEM_START = /^\s*\d+[.)]\s+/;
const LEADING_ITEM_NUMBER = /^\s*\d{1,2}[.)]\s*/;
const FIRST_ITEM_NUMBER = /^[ \t]*(\d{1,2})[.)][ \t]+/;
const AFTER_ITEM_NUMBER = /^[.)]\s+[[\p{L}"“]/u;
const ITEM_NUMBER_PRECEDERS = '.!?"”)';
const LABEL = /\[(\d{1,2})\]/;
const LABELS = /\[\d{1,2}\]/g;
const QUOTE_SPAN = /"([^"]+)"|“([^”]+)”/g;
const TRAILING_JOINERS = /[\s,;:—–-]+$/;

type ParsedItem = {
  text: string;
  label: number | null;
  head: string;
  quotes: string[];
};

function cleanHead(raw: string): string {
  return raw
    .replace(LEADING_ITEM_NUMBER, "")
    .replace(MD_LINK, "$1")
    .replace(LABELS, "")
    .replace(URL, "")
    .replace(EMOJI, "")
    .replace(BOLD, "")
    .replace(SPACES, " ")
    .trim()
    .replace(TRAILING_JOINERS, "")
    .trim();
}

function parseItem(raw: string): ParsedItem {
  const text = raw.replace(/\s*\n\s*/g, " ").trim();
  const label = text.match(LABEL);
  const quotes: string[] = [];
  let firstQuoteAt = -1;
  for (const match of text.matchAll(QUOTE_SPAN)) {
    const quote = match[1] ?? match[2] ?? "";
    if (firstQuoteAt === -1) firstQuoteAt = match.index;
    if (quote.trim()) quotes.push(quote);
  }
  return {
    text,
    label: label ? Number(label[1]) : null,
    head: cleanHead(firstQuoteAt === -1 ? text : text.slice(0, firstQuoteAt)),
    quotes
  };
}

// A flattened tail is one line of prose with the items run together, so an
// item boundary has to be earned: the next number in sequence, after a
// sentence end (never after a comma — "G31.84, R41.3" is not item 3), and
// followed by a word or a quote.
function precededByBoundary(body: string, at: number): boolean {
  let i = at - 1;
  let spaced = false;
  while (i >= 0 && (body[i] === " " || body[i] === "\t")) {
    spaced = true;
    i--;
  }
  if (!spaced || i < 0) return false;
  return ITEM_NUMBER_PRECEDERS.includes(body[i]);
}

function findItemNumber(body: string, n: number, from: number): number {
  const needle = String(n);
  let at = body.indexOf(needle, from);
  while (at !== -1) {
    if (
      precededByBoundary(body, at) &&
      AFTER_ITEM_NUMBER.test(body.slice(at + needle.length))
    ) {
      return at;
    }
    at = body.indexOf(needle, at + 1);
  }
  return -1;
}

function splitInlineItems(body: string): string[] {
  const first = body.match(FIRST_ITEM_NUMBER);
  if (!first) return [];
  const starts = [0];
  let expected = Number(first[1]);
  let cursor = first[0].length;
  for (;;) {
    expected += 1;
    const at = findItemNumber(body, expected, cursor);
    if (at === -1) break;
    starts.push(at);
    cursor = at + String(expected).length;
  }
  return starts.map((start, i) =>
    body
      .slice(start, i + 1 < starts.length ? starts[i + 1] : body.length)
      .trim()
  );
}

// Whatever the model wrote above the first item is re-emitted as it stands,
// so it gets the same URL strip an item head gets: an invented link must not
// survive anywhere in the rebuilt block.
function cleanPreamble(raw: string): string {
  return raw
    .replace(URL, "")
    .replace(SPACES, " ")
    .replace(/[ \t]+$/gm, "")
    .trim();
}

function splitBlockItems(body: string): { preamble: string; items: string[] } {
  const preamble: string[] = [];
  const items: string[] = [];
  let current: string[] | null = null;
  for (const line of body.split("\n")) {
    if (ITEM_START.test(line)) {
      if (current) items.push(current.join("\n"));
      current = [line];
      continue;
    }
    if (!line.trim()) continue;
    if (current) current.push(line);
    else preamble.push(line);
  }
  if (current) items.push(current.join("\n"));
  return { preamble: cleanPreamble(preamble.join("\n")), items };
}

type SplitTail = {
  heading: string;
  preamble: string;
  items: ParsedItem[];
  rest: string;
};

function splitTail(tail: string): SplitTail {
  const trimmed = tail.trim();
  let heading = "";
  let body = trimmed;
  const firstBreak = body.indexOf("\n");
  const firstLine = firstBreak === -1 ? body : body.slice(0, firstBreak);
  const headingMatch = firstLine.match(SOP_HEADING);
  if (headingMatch) {
    const inline = headingMatch[1] ?? "";
    heading = firstLine.slice(0, firstLine.length - inline.length).trimEnd();
    body = firstBreak === -1 ? inline : inline + body.slice(firstBreak);
  }
  let rest = "";
  const end = body.match(SECTION_END);
  if (end?.index !== undefined) {
    rest = body.slice(end.index);
    body = body.slice(0, end.index);
  } else if (!body.trim().includes("\n")) {
    const inlineEnd = body.match(INLINE_SECTION_END);
    if (inlineEnd?.index !== undefined) {
      rest = body.slice(inlineEnd.index + 1);
      body = body.slice(0, inlineEnd.index);
    }
  }
  // Only ever the item region: a run that opens the next section
  // ("**Not covered by the SOPs:**") was claimed by the split above and is
  // sitting in `rest`, untouched. The caller keeps the original tail for the
  // "unchanged" fallbacks, so nothing here can eat text the reader saw.
  if (!headingMatch) body = body.replace(ORPHAN_EMPHASIS, "");
  const flat = body.trim();
  if (flat && !flat.includes("\n")) {
    return {
      heading,
      preamble: "",
      items: splitInlineItems(flat).map(parseItem),
      rest
    };
  }
  const block = splitBlockItems(body);
  return {
    heading,
    preamble: block.preamble,
    items: block.items.map(parseItem),
    rest
  };
}

// --- Resolution ----------------------------------------------------------

const DRAFT_PARENTHETICAL = /\s*\([^)]*\bdraft\b[^)]*\)\s*$/i;

function runIndex(haystack: string[], needle: string[]): number {
  if (needle.length === 0 || needle.length > haystack.length) return -1;
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }
  return -1;
}

function containsRun(haystack: string[], needle: string[]): boolean {
  return runIndex(haystack, needle) !== -1;
}

function titleTokens(title: string): string[] {
  return tokensOf(displayTitle(title).replace(DRAFT_PARENTHETICAL, "")).map(
    stem
  );
}

type TitleMatch = { file: string; length: number; rank: number };

// The model shortens titles ("Insurance Verification & PA") and lengthens them
// ("... (DRAFT)"), so a title matches on a contiguous run of its own leading
// words. Two words is the floor: one word would let "Patient Check-In" claim
// "Patient Check-Out".
function titleCandidates(head: string, sops: SOPRef[]): TitleMatch[] {
  const heads = tokensOf(head).map(stem);
  const out: TitleMatch[] = [];
  sops.forEach((sop, rank) => {
    if (!sop.file) return;
    const title = titleTokens(sop.title);
    if (title.length === 0) return;
    const floor = title.length === 1 ? 1 : 2;
    for (let length = title.length; length >= floor; length--) {
      if (containsRun(heads, title.slice(0, length))) {
        out.push({ file: sop.file, length, rank });
        break;
      }
    }
  });
  return out.sort((a, b) => b.length - a.length || a.rank - b.rank);
}

// An item with no quotation marks still points at a sentence: whatever is
// left once the SOP's own title and the section number are gone. The title is
// matched the same way it is resolved — on the longest leading run the model
// actually typed, since it abbreviates ("Imaging Order Requirements" for a
// title that runs on to "— Amyloid PET & MRI Checklist").
function headRemainder(head: string, title: string[]): string {
  let rest = head.replace(LEADING_ITEM_NUMBER, "");
  const spans = keyTokens(rest);
  const stems = spans.map((token) => stem(token.text));
  const floor = title.length === 1 ? 1 : 2;
  for (let length = title.length; length >= floor; length--) {
    const at = runIndex(stems, title.slice(0, length));
    if (at === -1) continue;
    rest = rest.slice(spans[at + length - 1].end);
    break;
  }
  return rest
    .replace(TRAILING_JOINERS, "")
    .replace(/^[\s,;:—–.-]+/, "")
    .replace(LEADING_ITEM_NUMBER, "")
    .trim();
}

function fileOrder(
  sops: SOPRef[],
  labelFile: string | null,
  titleFile: string | null
): string[] {
  const out: string[] = [];
  const push = (file: string | null | undefined) => {
    if (file && !out.includes(file)) out.push(file);
  };
  push(labelFile);
  push(titleFile);
  for (const sop of sops) push(sop.file);
  return out;
}

type Resolution = { file: string | null; hits: QuoteHit[] };

function dedupeByLine(hits: (QuoteHit | null)[]): QuoteHit[] {
  const seen = new Set<number>();
  const out: QuoteHit[] = [];
  for (const hit of hits) {
    if (!hit || seen.has(hit.line.index)) continue;
    seen.add(hit.line.index);
    out.push(hit);
  }
  return out;
}

// Evidence first: the label is the model's claim, the quote is the proof. A
// label pointing at the wrong SOP loses to a quote found word for word
// somewhere else, which is how "3 of 12 links 404" gets fixed.
function sweepExact(
  quotes: Quote[],
  ctx: CitationContext,
  index: Indexer,
  labelFile: string | null,
  titleFile: string | null
): Resolution | null {
  const files = fileOrder(ctx.sops, labelFile, titleFile);
  const byFile = new Map<string, Map<number, QuoteHit>>();
  const lineCount = new Map<number, number>();
  for (const file of files) {
    const lines = index(file);
    if (!lines) continue;
    quotes.forEach((quote, i) => {
      const hits = exactHits(quote, lines);
      if (hits.length === 0) return;
      lineCount.set(i, (lineCount.get(i) ?? 0) + hits.length);
      const found = byFile.get(file) ?? new Map<number, QuoteHit>();
      found.set(i, hits[0]);
      byFile.set(file, found);
    });
  }
  const accepted = (i: number) =>
    quotes[i].toks.length >= QUOTE_MIN_TOKENS || lineCount.get(i) === 1;
  for (const file of files) {
    const found = byFile.get(file);
    if (!found) continue;
    const hits = quotes
      .map((_, i) =>
        found.has(i) && accepted(i) ? (found.get(i) ?? null) : null
      )
      .filter((hit): hit is QuoteHit => hit !== null);
    if (hits.length > 0) return { file, hits: dedupeByLine(hits) };
  }
  return null;
}

function resolveItem(
  item: ParsedItem,
  ctx: CitationContext,
  index: Indexer
): Resolution {
  const labelFile =
    item.label === null
      ? null
      : (ctx.labels.find((entry) => entry.label === item.label)?.file ?? null);
  const titles = titleCandidates(item.head, ctx.sops);
  const titleFile = titles.length > 0 ? titles[0].file : null;
  const source = labelFile ?? titleFile;
  const meta = source ? ctx.meta.get(source) : undefined;
  const title = meta ? titleTokens(meta.title) : [];

  const attempt = (quotes: Quote[]): Resolution | null => {
    if (quotes.length === 0) return null;
    if (labelFile) {
      const lines = index(labelFile);
      if (lines) {
        const hits = dedupeByLine(
          quotes.map((quote) => findPrepared(quote, lines))
        );
        if (hits.length > 0) return { file: labelFile, hits };
      }
    }
    const swept = sweepExact(quotes, ctx, index, labelFile, titleFile);
    if (swept) return swept;
    // Fuzzy matching is only safe where the file is already known: inside the
    // label's file, or the one file whose title the model actually named.
    if (!labelFile && titleFile) {
      const lines = index(titleFile);
      if (lines) {
        const hits = dedupeByLine(
          quotes.map((quote) => findFuzzy(quote, lines))
        );
        if (hits.length > 0) return { file: titleFile, hits };
      }
    }
    return null;
  };

  const prepared = (raw: string[]) =>
    raw.map(prepQuote).filter((quote) => quote.key.length > 0);
  const spans = attempt(prepared(item.quotes));
  if (spans) return spans;
  // The model often breaks one sentence into several quoted fragments, each
  // too short to be evidence on its own ("PET CT amyloid brain scan", "PET
  // brain"). Read the whole item, minus the title it names, as one quote.
  const whole = attempt(prepared([headRemainder(cleanHead(item.text), title)]));
  if (whole) return whole;
  // Nothing matched: the model's own words survive, marked as unchecked. When
  // even the SOP is unknown, the quotation marks come off.
  if (source && ctx.meta.has(source)) {
    return { file: source, hits: [] };
  }
  return { file: null, hits: [] };
}

// --- Rendering -----------------------------------------------------------

function titleLink(meta: FileMeta): string {
  const title = displayTitle(meta.title);
  return meta.source_url ? `[${title}](${meta.source_url})` : title;
}

function renderItem(
  n: number,
  item: ParsedItem,
  resolution: Resolution,
  ctx: CitationContext
): {
  text: string;
  cited: CitedSource | null;
  kind: "matched" | "unmatched" | "unknown";
} {
  const meta = resolution.file ? ctx.meta.get(resolution.file) : undefined;
  if (!resolution.file || !meta) {
    // cleanHead, not a bare number strip: this line is the model's own words
    // and may carry the link it invented for an SOP nobody retrieved.
    const head = item.head || cleanHead(item.text);
    return {
      text: `${n}. ${head}`.trimEnd() + `\n   ${CITATION_UNKNOWN_SOP_NOTE}`,
      cited: null,
      kind: "unknown"
    };
  }
  if (resolution.hits.length === 0) {
    const said =
      item.quotes.length > 0
        ? displayLine(item.quotes[0].replace(URL, ""))
        : headRemainder(item.head, titleTokens(meta.title));
    return {
      text: `${n}. ${titleLink(meta)}\n   ${`${CITATION_UNMATCHED_NOTE} ${said}`.trimEnd()}`,
      cited: {
        file: resolution.file,
        section: null,
        quote: null,
        verified: false
      },
      kind: "unmatched"
    };
  }
  const section = resolution.hits[0].line.section;
  const quotes = resolution.hits.map(expandQuote);
  const lines = quotes.map((quote) => `   "${quote}"`).join("\n");
  return {
    text: `${n}. ${titleLink(meta)}${section ? `, ${section}` : ""}\n${lines}`,
    cited: {
      file: resolution.file,
      section,
      quote: quotes[0],
      verified: true
    },
    kind: "matched"
  };
}

/** Rebuild the citation items from the retrieved SOP text. `tail` is the held
 * text after the "What the SOPs say" heading (the heading itself may still be
 * the first line). The rendered text starts with a newline when the tail is
 * items only, so the caller can append it straight after the heading it
 * already streamed. */
export function repairCitations(
  tail: string,
  ctx: CitationContext
): RepairResult {
  const { heading, preamble, items, rest } = splitTail(tail);
  if (items.length === 0) {
    const question = dropIdentityQuestion(tail);
    return {
      text: question.text,
      cited: [],
      droppedQuestion: question.dropped,
      stats: { items: 0, matched: 0, unmatched: 0, unknown: 0 }
    };
  }
  const index = makeIndexer(ctx.meta);
  const cited: CitedSource[] = [];
  const stats = { items: items.length, matched: 0, unmatched: 0, unknown: 0 };
  const rendered = items.map((item, i) => {
    const one = renderItem(i + 1, item, resolveItem(item, ctx, index), ctx);
    if (one.cited) cited.push(one.cited);
    stats[one.kind] += 1;
    return one.text;
  });

  const opening = [heading, preamble].filter((part) => part.length > 0);
  const body =
    opening.length > 0
      ? `${opening.join("\n")}\n\n${rendered.join("\n")}`
      : `\n${rendered.join("\n")}`;
  const text = rest.trim() ? `${body}\n\n${rest.trim()}` : body;

  // Safety valves: a repair that loses the gaps section is worse than no
  // repair at all, so hand back the model's own tail instead — with nothing
  // cited and the stats zeroed, since none of that work is on the page the
  // reader gets. Stale counts here would tell telemetry a repair happened and
  // light up cards for citations nobody can see.
  if (
    /not covered by the sops/i.test(tail) &&
    !/not covered by the sops/i.test(text)
  ) {
    const question = dropIdentityQuestion(tail);
    return {
      text: question.text,
      cited: [],
      droppedQuestion: question.dropped,
      stats: { items: 0, matched: 0, unmatched: 0, unknown: 0 }
    };
  }
  const question = dropIdentityQuestion(text);
  return {
    text: question.text,
    cited,
    droppedQuestion: question.dropped,
    stats
  };
}

// --- The identity question -----------------------------------------------

const ONE_QUESTION_BLOCK =
  /^[ \t]*(?:#{1,6}[ \t]+)?(?:\*\*|__)?[ \t]*One question[ \t]*:?[ \t]*(?:\*\*|__)?[ \t]*(.*)$/im;
const ONE_QUESTION_INLINE =
  /(?:\*\*|__)?One question(?:\*\*|__)?[ \t]*:[ \t]*/i;
const HEADING_LIKE = /^[ \t]*(?:#{1,6}[ \t]+|(?:\*\*|__)\S)/;
// Rule 5 of the prompt: never ask for a name, date of birth, phone number,
// address or email. The model still does, so the question is dropped when it
// asks for an identifier — and only then: "Is her name listed on the signed
// ROI?" is a workflow question and stays.
const IDENTITY_QUESTION =
  /(?:what(?:'s| is)|provide|give|confirm|share)\b[^?]{0,60}\b(?:patient|caregiver|mother|father|spouse|family member)(?:'s)?\s+(?:full\s+|first\s+|last\s+)?(?:name|date of birth|dob|phone(?: number)?|e-?mail|address)|\b(?:date of birth|dob|full name|name of the patient)\b/i;

type QuestionRegion = { start: number; end: number; question: string };

function findOneQuestion(text: string): QuestionRegion | null {
  const block = text.match(ONE_QUESTION_BLOCK);
  if (block?.index !== undefined) {
    const lines = text.slice(block.index).split("\n");
    const body = [(block[1] ?? "").trim()];
    let end = block.index + lines[0].length;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (HEADING_LIKE.test(line)) break;
      if (!line.trim() && body.join(" ").trim()) break;
      end += 1 + line.length;
      if (line.trim()) body.push(line.trim());
    }
    return { start: block.index, end, question: body.join(" ").trim() };
  }
  const inline = text.match(ONE_QUESTION_INLINE);
  if (inline?.index !== undefined) {
    const breakAt = text.indexOf("\n", inline.index);
    const end = breakAt === -1 ? text.length : breakAt;
    return {
      start: inline.index,
      end,
      question: text.slice(inline.index + inline[0].length, end).trim()
    };
  }
  return null;
}

export function dropIdentityQuestion(text: string): {
  text: string;
  dropped: boolean;
} {
  const region = findOneQuestion(text);
  if (!region) return { text, dropped: false };
  const asked = region.question.replace(/[‘’]/g, "'");
  if (!IDENTITY_QUESTION.test(asked)) return { text, dropped: false };
  const head = text.slice(0, region.start).replace(/\s+$/, "");
  const tail = text.slice(region.end).replace(/^\s+/, "");
  return { text: tail ? `${head}\n\n${tail}` : head, dropped: true };
}

// --- Cards ---------------------------------------------------------------

/** SOPRef gains `cited` and `quote` when the answer is stored; until then the
 * shape is local to this module. */
export type CitedSOPRef = SOPRef & { cited: boolean; quote: string | null };

/** Mark which cards the answer actually cited, and give each one the first
 * verified quote for its one-line reason. Order and scores are untouched. */
export function markCited(
  ranked: SOPRef[],
  cited: CitedSource[]
): CitedSOPRef[] {
  return ranked.map((sop) => {
    const mine = sop.file
      ? cited.filter((source) => source.file === sop.file)
      : [];
    const verified = mine.find((source) => source.verified && source.quote);
    return { ...sop, cited: mine.length > 0, quote: verified?.quote ?? null };
  });
}
