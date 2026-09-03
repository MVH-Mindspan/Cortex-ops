// Parse the YAML frontmatter of a SOP markdown object out of R2 into FileMeta.
// This is the ONLY place SOP frontmatter is parsed and the ONLY place a status
// label is normalised, so the SOP cards, the library rows and the passages
// block all compare against the same four values ("draft" | "review" |
// "approved" | null) rather than against whatever prose Notion held.
//
// AI Search indexes the frontmatter verbatim and the exporter's header has
// already changed shape once (five keys; now also status, use_when and a
// categories list), so this parser must tolerate any shape: unknown keys are
// ignored, wrong types fall back, and YAML that will not parse degrades to
// fallbackMeta. It never throws.
//
// The parser itself is pure — the caller hands in the raw object text. The one
// exception is loadSopMeta at the foot of the file, which reads a set of keys
// out of a bucket and parses each one: the Worker and the eval harness must
// resolve SOP metadata identically or the harness stops measuring the Worker,
// so that read lives here rather than being written out twice.

import matter from "gray-matter";
// Value import between src/lib modules, so the .ts extension (see prompt.ts).
import { DRAFT_TITLE_RE } from "./pipeline.ts";
import type { FileMeta, SopStatus } from "./pipeline";

// Notion writes non-breaking spaces into page titles. They look like spaces
// but break title matching in the client, so normalise them on the way in.
const NBSP_RE = /\u00a0/g;

// The one status normaliser. The frontmatter label wins; the title suffix
// (DRAFT_TITLE_RE in pipeline.ts, which the client also strips for display)
// is the fallback that gives the 22 already-exported files a badge before
// the next export writes a status key.
//
// The order is deliberate. Draft is tested first so an ambiguous label
// ("Draft — Needs Review") is never upgraded to something safer-sounding;
// then review (any "review", not just "In Review", so "Needs Review" lands
// there), then approved, then the title rule.
export function statusKind(
  raw: string | null | undefined,
  title: string
): SopStatus | null {
  const label = raw ?? "";
  if (/draft/i.test(label)) return "draft";
  if (/review/i.test(label)) return "review";
  if (/approved/i.test(label)) return "approved";
  return DRAFT_TITLE_RE.test(title) ? "draft" : null;
}

// What a caller gets when the object is missing, unreadable or unparsable:
// the key stands in for the title so a card still renders and still links.
export function fallbackMeta(key: string): FileMeta {
  return {
    title: key,
    category: "uncategorized",
    last_edited: null,
    source_url: null,
    status: null,
    use_when: null,
    text: ""
  };
}

// gray-matter throws on YAML it cannot parse (an unclosed flow collection, a
// bad escape). One mangled file must not fail the whole answer, so isolate the
// only call that can throw.
function safeMatter(
  raw: string
): { data: Record<string, unknown>; content: string } | null {
  try {
    // The empty options object is deliberate: gray-matter only reads and
    // writes its module-global, never-evicted cache when called without one.
    const parsed = matter(raw, {});
    return {
      data: (parsed.data ?? {}) as Record<string, unknown>,
      content: parsed.content
    };
  } catch {
    return null;
  }
}

// A Notion property can reach the frontmatter as a scalar or, when it is a
// multi-select, as a list. Take the first usable string either way; anything
// else (a number, an empty list, a map) is no value at all.
function firstString(value: unknown): string | null {
  if (typeof value === "string") return value || null;
  if (Array.isArray(value)) {
    for (const item of value as unknown[]) {
      if (typeof item === "string" && item) return item;
    }
  }
  return null;
}

export function parseSopFile(key: string, raw: string): FileMeta {
  const parsed = safeMatter(raw);
  if (!parsed) return fallbackMeta(key);
  const fm = parsed.data;
  const title =
    typeof fm.title === "string" && fm.title
      ? fm.title.replace(NBSP_RE, " ")
      : key;
  // An unquoted YAML timestamp parses to a Date, a quoted one stays a string.
  const edited: unknown = fm.last_edited;
  return {
    title,
    // The export writes one category; a multi-select list keeps its first.
    category: firstString(fm.category) ?? "uncategorized",
    last_edited:
      typeof edited === "string"
        ? edited
        : edited instanceof Date
          ? edited.toISOString()
          : null,
    source_url: typeof fm.source_url === "string" ? fm.source_url : null,
    status: statusKind(firstString(fm.status), title),
    use_when: firstString(fm.use_when),
    text: parsed.content.trim()
  };
}

// Read frontmatter for a set of R2 keys, in parallel. A missing object, an
// unreadable one, or a bucket that throws degrades to fallbackMeta for that
// key alone: one bad object must never fail a whole answer. The bucket is
// typed structurally by the one method used, so a test can pass a fake.
export async function loadSopMeta(
  bucket: { get(key: string): Promise<{ text(): Promise<string> } | null> },
  keys: string[]
): Promise<Map<string, FileMeta>> {
  const entries = await Promise.all(
    keys.map(async (key): Promise<[string, FileMeta]> => {
      try {
        const object = await bucket.get(key);
        return [
          key,
          object ? parseSopFile(key, await object.text()) : fallbackMeta(key)
        ];
      } catch {
        return [key, fallbackMeta(key)];
      }
    })
  );
  return new Map(entries);
}
