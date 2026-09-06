// Turn SOP mentions in a streamed answer into Notion links, using the
// retrieved SOP list as the source of truth, and pull each card's one-line
// reason out of the citation section. Pure module (types only from pipeline).

// Value import between src/lib modules, so the .ts extension (see prompt.ts).
import { DRAFT_TITLE_RE } from "./pipeline.ts";
import type { SOPRef } from "./pipeline";

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Strip a leading emoji from Notion titles for display (no emojis in the UI).
export function displayTitle(title: string): string {
  return title.replace(/^[^\p{L}\p{N}]+/u, "").trim() || title;
}

// Same as displayTitle, minus the draft suffix that statusKind reads as the
// status (DRAFT_TITLE_RE). Used only where a Draft chip is rendered, so the
// word appears once; linkifySOPs/compileLinkers/reasonFor keep matching on
// the raw title, which is what the model writes in the answer.
export function cardTitle(title: string): string {
  return displayTitle(title).replace(DRAFT_TITLE_RE, "").trim();
}

type Linker = { pattern: RegExp; url: string; label?: string; clean: string };

// Compiled once per SOP list: the list object is what changes between
// answers, so key the cache on it.
const linkerCache = new WeakMap<SOPRef[], Linker[]>();

export function compileLinkers(sops: SOPRef[]): Linker[] {
  const cached = linkerCache.get(sops);
  if (cached) return cached;
  const linkers = sops
    .filter((sop) => sop.source_url)
    .flatMap((sop) => {
      const url = sop.source_url as string;
      const title = sop.title.replace(/^[^\p{L}\p{N}]+/u, "").trim();
      const candidates: Omit<Linker, "pattern">[] = [];
      if (title.length >= 4) candidates.push({ url, clean: title });
      if (sop.file && sop.file.length >= 4) {
        candidates.push({ url, clean: sop.file, label: title || sop.file });
      }
      return candidates;
    })
    // Longer mentions first so a title that contains another title is linked
    // whole instead of producing nested links.
    .sort((a, b) => b.clean.length - a.clean.length)
    .map((candidate) => ({
      ...candidate,
      pattern: mentionPattern(candidate.clean)
    }));
  linkerCache.set(sops, linkers);
  return linkers;
}

// Unicode word boundaries: never link inside a longer word ("Referral" in
// "Referrals"). Optional bold markers are consumed so the link replaces them
// rather than nesting inside them. The only dynamic part is a regex-escaped
// SOP title or filename from trusted R2 frontmatter, so there is no ReDoS
// surface (hence the suppression).
function mentionPattern(mention: string): RegExp {
  const source = `(?<![\\p{L}\\p{N}])\\*{0,2}${escapeRegExp(mention)}\\*{0,2}(?![\\p{L}\\p{N}])`;
  return new RegExp(source, "giu"); // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
}

// A match inside an existing markdown link — either its [label] or its (url)
// — must be left alone or the link breaks.
function insideLink(full: string, offset: number): boolean {
  const labelOpen = full.lastIndexOf("[", offset);
  const labelClose = full.lastIndexOf("]", offset);
  if (labelOpen > labelClose) return true;
  const urlOpen = full.lastIndexOf("](", offset);
  const urlClose = full.lastIndexOf(")", offset);
  return urlOpen > urlClose;
}

export function linkifySOPs(text: string, sops: SOPRef[] | null): string {
  if (!sops || sops.length === 0) return text;
  let out = text;
  for (const linker of compileLinkers(sops)) {
    out = out.replace(
      linker.pattern,
      (match: string, offset: number, full: string) => {
        if (insideLink(full, offset)) return match;
        const label = linker.label ?? match.replace(/\*/g, "");
        return `[${label}](${linker.url})`;
      }
    );
  }
  return out;
}

// The model's own citation sentence for a SOP, used as the one-line reason
// on the result card. When the answer has a citation section, only a title
// mention inside it counts: the team steer near the top can name an SOP
// ("Enrollment") a few lines above the patient script, and that quote would
// otherwise be scraped onto the card. The whole answer is searched only when
// the section is missing (an answer cut short). Best effort: no quote near
// the title means no reason line.
export function reasonFor(answer: string, sop: SOPRef): string | null {
  const clean = displayTitle(sop.title).toLowerCase();
  if (clean.length < 4) return null;
  const lower = answer.toLowerCase();
  const citations = lower.indexOf("what the sops say");
  const idx =
    citations === -1 ? lower.indexOf(clean) : lower.indexOf(clean, citations);
  if (idx === -1) return null;
  const after = answer.slice(idx, idx + 600);
  const quote = after.match(/"([^"]{10,220})"/);
  return quote ? quote[1] : null;
}
