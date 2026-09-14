// Picks who to contact from the team directory, in code, before the model
// answers. Live eval (14 Sep 2026) showed the model naming whoever sat on the
// team it had just named (a copay question went to an enrollment lead) and
// naming someone when no one owned the work, so the pick is no longer left to
// it.
//
// Each Live entry is scored by the words its Owns lines, title and Route When
// hint share with the message. Rare words count more than common ones ("copay"
// above "clinical"), and product names from the Systems lines count little:
// naming a system does not make someone its owner. Out of scope lines count both
// ways: the entry a line points to gains, the entry that holds it loses. The
// top one or two entries above a threshold go into the request as a short
// block that the prompt treats as the answer to "who" (hard rule 17); with
// none, the block says to name no one.
//
// Pure module: no side effects. Names reach the model only, never logs: the
// Worker logs the match count and the top score.

import { PRIORITIES, reachOf } from "./personas.ts";
import type { Directory, Persona } from "./personas.ts";

// Ceiling for the block; pipeline.ts reserves it in the window arithmetic
// (prompt.test.ts asserts the worst case still fits).
export const CONTACT_BLOCK_MAX_CHARS = 800;
const HEADING = "Team directory match for this message";
export const NO_CONTACT_LINE = `${HEADING}: no entry's Owns line names this work. Name no person.`;

// Word weights are normalised so a word only one entry owns weighs 1.0 at any
// directory size. Tuned on the live directory (docs/personas.md): one
// distinctive word, or a common word plus an Out of scope redirect, clears
// MIN_SCORE; a common word or a product name alone does not. A redirect
// counts in full: ops wrote it as an explicit routing rule.
const MIN_SCORE = 0.8;
const SECOND_RATIO = 0.6;
const REDIRECT_WEIGHT = 1;
const SYSTEM_WEIGHT = 0.3;
const MAX_MATCHES = 2;
const REASON_MAX_CHARS = 110;
// A follow-up this short ("who owns it?") is matched with the turn before it.
const FOLLOW_UP_MIN_WORDS = 4;

const STOPWORDS = new Set(
  (
    "about after again all also and any anything are ask asked asking back " +
    "because been being but call called calling can come could day did does " +
    "doing done each even every for from get gets getting got had has have " +
    "having help her here him his how into its just know last like make many " +
    "may more most much need needs never new next not now off once one only " +
    "other our out over own owns please really said says see seem seems send " +
    "sent she should since some someone something still such sure than that " +
    "the their them then there these they thing this those through today " +
    "told tomorrow too two under until very want wants was way week well " +
    "were what when where whether which while who whom whose why will with " +
    "would yesterday you your morning afternoon evening tonight monday " +
    "tuesday wednesday thursday friday saturday sunday patient member family " +
    "visit question team handle handles handling message contact issue work " +
    // "ins" is left over from "check-ins"; "task" is every orchestration item.
    "person ins task"
  ).split(" ")
);

// Lowercased content words. "non-clinical" stays one word so it never
// matches "clinical"; other hyphenated words split ("copay-process" gives
// "copay"); an all-caps acronym of two letters or more ("IT", "MX") is kept
// although lowercase two-letter words are not; a plural "s" is dropped.
export function contactWords(text: string): string[] {
  const out: string[] = [];
  const joined = text.replace(/\b(non|pre|co)-(?=[A-Za-z])/gi, "$1");
  for (const raw of joined.split(/[^A-Za-z0-9]+/)) {
    if (!raw) continue;
    const acronym =
      raw.length >= 2 && /^[A-Z0-9]+$/.test(raw) && /[A-Z]/.test(raw);
    const lower = raw.toLowerCase();
    if (!acronym && lower.length < 3) continue;
    const word =
      !acronym &&
      lower.length > 4 &&
      lower.endsWith("s") &&
      !lower.endsWith("ss")
        ? lower.slice(0, -1)
        : lower;
    if (STOPWORDS.has(lower) || STOPWORDS.has(word)) continue;
    out.push(word);
  }
  return out;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function clip(text: string): string {
  const line = oneLine(text);
  return line.length <= REASON_MAX_CHARS
    ? line
    : `${line.slice(0, REASON_MAX_CHARS - 1).trimEnd()}…`;
}

type Entry = {
  persona: Persona;
  owns: { line: string; words: Set<string> }[];
  ownsWords: Set<string>;
  title: Set<string>;
  routeWhen: Set<string>;
};

// Inverse document frequency over the entries' Owns, title and Route When
// words, with product names (capitalised words on Systems lines) weighted down.
function weightsFor(entries: Entry[]): (word: string) => number {
  const df = new Map<string, number>();
  for (const entry of entries) {
    for (const word of new Set([
      ...entry.ownsWords,
      ...entry.title,
      ...entry.routeWhen
    ])) {
      df.set(word, (df.get(word) ?? 0) + 1);
    }
  }
  const systems = new Set<string>();
  for (const entry of entries) {
    for (const system of entry.persona.systems) {
      for (const token of system.split(/\s+/)) {
        if (/^[A-Z]/.test(token)) {
          for (const word of contactWords(token)) systems.add(word);
        }
      }
    }
  }
  const n = entries.length;
  // Divided by the weight of a word exactly one entry owns, so thresholds do
  // not drift as the directory grows.
  const unit = Math.log(1 + n / 2);
  return (word) =>
    (Math.log(1 + n / ((df.get(word) ?? 0) + 1)) / unit) *
    (systems.has(word) ? SYSTEM_WEIGHT : 1);
}

function scoreOf(
  words: Iterable<string>,
  message: ReadonlySet<string>,
  weight: (word: string) => number
): number {
  let score = 0;
  for (const word of new Set(words))
    if (message.has(word)) score += weight(word);
  return score;
}

function normalized(text: string): string {
  return text
    .replace(/\([^)]*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/^dr\.\s*/, "dr ");
}

// An Out of scope target names a person ("Casey", "Dr. Lin") or a routing
// department ("RCM", "Member Experience"); both resolve to entries.
function resolverFor(personas: readonly Persona[]) {
  const index = new Map<string, Persona[]>();
  const add = (key: string, persona: Persona) => {
    if (!key) return;
    const list = index.get(key) ?? [];
    if (!list.includes(persona)) list.push(persona);
    index.set(key, list);
  };
  for (const persona of personas) {
    const full = normalized(persona.name);
    add(full, persona);
    const words = full.split(" ");
    if (words.length > 1 && words[0] !== "dr") add(words[0], persona);
  }
  for (const persona of personas) {
    for (const dept of persona.routingDepartments) {
      const lower = dept.toLowerCase().trim();
      const inner = lower.match(/\(([^)]*)\)\s*$/)?.[1]?.trim();
      for (const key of [lower, normalized(dept), inner ?? ""]) {
        if (!index.has(key) || index.get(key)?.includes(persona)) {
          add(key, persona);
        }
      }
    }
  }
  return (target: string): Persona[] => index.get(normalized(target)) ?? [];
}

export type ContactMatch = {
  readonly persona: Persona;
  readonly score: number;
  /** The Owns line that matched best, or null. */
  readonly owns: string | null;
  /** The Route When hint, when it shares a word with the message, or null. */
  readonly routeWhen: string | null;
  /** The Out of scope topic on another entry that points here, or null. */
  readonly redirect: string | null;
};

export function matchContacts(
  directory: Directory | null,
  text: string
): ContactMatch[] {
  if (!directory || directory.personas.length === 0) return [];
  const message = new Set(contactWords(text));
  if (message.size === 0) return [];
  const personas = directory.personas;
  const entries: Entry[] = personas.map((persona) => {
    const owns = persona.owns.map((line) => ({
      line,
      words: new Set(contactWords(line))
    }));
    return {
      persona,
      owns,
      ownsWords: new Set(owns.flatMap((o) => [...o.words])),
      title: new Set(contactWords(persona.title)),
      routeWhen: new Set(contactWords(persona.routeWhen))
    };
  });
  const weight = weightsFor(entries);
  const resolve = resolverFor(personas);

  const inbound = new Map<Persona, { score: number; topic: string }>();
  const penalty = new Map<Persona, number>();
  for (const persona of personas) {
    for (const entry of persona.outOfScope) {
      const topic = new Set(contactWords(entry.topic));
      const score = scoreOf(topic, message, weight);
      if (score <= 0) continue;
      // The holder loses in proportion to how much of the line the message
      // covers: one shared word of four ("outreach for insurance details"
      // against an eligibility question) is a passing overlap, not a match.
      let covered = 0;
      for (const word of topic) if (message.has(word)) covered += 1;
      const cost = score * (covered / topic.size);
      penalty.set(persona, Math.max(penalty.get(persona) ?? 0, cost));
      for (const target of entry.targets) {
        for (const other of resolve(target)) {
          if (other === persona) continue;
          const previous = inbound.get(other);
          if (!previous || score > previous.score) {
            inbound.set(other, { score, topic: entry.topic });
          }
        }
      }
    }
  }

  const scored = entries
    .map((entry, index) => {
      let best: { line: string; score: number } | null = null;
      for (const own of entry.owns) {
        const score = scoreOf(own.words, message, weight);
        if (score > 0 && (!best || score > best.score)) {
          best = { line: own.line, score };
        }
      }
      const redirect = inbound.get(entry.persona);
      const routeWhenScore = scoreOf(entry.routeWhen, message, weight);
      const score =
        scoreOf(entry.ownsWords, message, weight) +
        scoreOf(entry.title, message, weight) +
        routeWhenScore +
        REDIRECT_WEIGHT * (redirect?.score ?? 0) -
        (penalty.get(entry.persona) ?? 0);
      const match: ContactMatch = {
        persona: entry.persona,
        score,
        owns: best?.line ?? null,
        routeWhen: routeWhenScore > 0 ? entry.persona.routeWhen : null,
        redirect: redirect?.topic ?? null
      };
      return { index, match };
    })
    .filter(({ match }) => match.score >= MIN_SCORE)
    .sort(
      (a, b) =>
        b.match.score - a.match.score ||
        PRIORITIES.indexOf(a.match.persona.priority) -
          PRIORITIES.indexOf(b.match.persona.priority) ||
        a.index - b.index
    );
  if (scored.length === 0) return [];
  const top = scored[0].match.score;
  return scored
    .filter(({ match }, i) => i === 0 || match.score >= top * SECOND_RATIO)
    .slice(0, MAX_MATCHES)
    .map(({ match }) => match);
}

// The block the request carries, between the rules and the message. Empty
// when there is no directory; the fixed NO_CONTACT_LINE when nothing matched.
export function renderContactBlock(
  directory: Directory | null,
  matches: readonly ContactMatch[]
): string {
  if (!directory || directory.personas.length === 0) return "";
  if (matches.length === 0) return NO_CONTACT_LINE;
  const lines = [
    `${HEADING} (computed from the team directory; see hard rule 17):`
  ];
  matches.forEach((match, i) => {
    const why = match.owns
      ? `Owns "${clip(match.owns)}".`
      : match.routeWhen
        ? `Route when "${clip(match.routeWhen)}".`
        : match.redirect
          ? `Another entry's Out of scope line sends "${clip(match.redirect)}" here.`
          : "Title matches.";
    // Reach and backup sit beside the name so the answer copies them: without
    // them here the model wrote "contact his Backup" (live eval, 14 Sep 2026).
    const reach = reachOf(match.persona);
    const backup = oneLine(match.persona.backup);
    lines.push(
      `${i + 1}. ${oneLine(match.persona.name)}, ${oneLine(match.persona.title)} (${oneLine(match.persona.department)}).${reach ? ` Reach: ${reach}.` : ""}${backup ? ` Backup: ${clip(backup)}.` : ""} ${why}`
    );
  });
  // Drop the second match rather than cut a line when over the ceiling.
  while (
    lines.length > 2 &&
    lines.join("\n").length > CONTACT_BLOCK_MAX_CHARS
  ) {
    lines.pop();
  }
  return lines.join("\n").slice(0, CONTACT_BLOCK_MAX_CHARS);
}

// The text to match: the latest team member message, with the one before it
// when the latest is too short to name the work on its own.
export function contactQuery(
  turns: ReadonlyArray<{ role: string; content: string }>
): string {
  const users = turns
    .filter((turn) => turn.role === "user")
    .map((turn) => turn.content);
  const latest = users.at(-1) ?? "";
  if (users.length > 1 && contactWords(latest).length < FOLLOW_UP_MIN_WORDS) {
    return `${users.at(-2)}\n${latest}`;
  }
  return latest;
}

// Everything the Worker and the eval harness need: the block, plus counts
// for telemetry (never names).
export function contactBlockFor(
  directory: Directory | null,
  turns: ReadonlyArray<{ role: string; content: string }>
): { block: string; matches: number; top: number } {
  const matches = matchContacts(directory, contactQuery(turns));
  return {
    block: renderContactBlock(directory, matches),
    matches: matches.length,
    top: Math.round((matches[0]?.score ?? 0) * 100) / 100
  };
}
