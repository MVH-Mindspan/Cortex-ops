// Checks the team directory before it goes live: each persona's own fields,
// its references to other people, and its Out of Scope lines against the
// Department Routing Map's "Do not send them" lists, in both directions.
// Shared by export-personas.ts (before every upload) and the
// validate-routing CLI. Pure module so it is unit-tested with node:test on
// fictional fixtures.
//
// Levels:
//   error      the row is left out of the directory (missing title,
//              department or responsibilities). Two rows may share a Name
//              (operator decision, 14 Sep 2026): answers tell them apart by
//              title, and a reference to the name matches both.
//   reference  a Backup, an Out of Scope target, or a Routing Department that
//              resolves to nothing, or a redirect back to the same person
//   conflict   a persona owns work its routing department excludes, or sends
//              a topic to someone whose department excludes that topic (the
//              "copay questions went to accounting" failure)
//   gap        a routing department excludes work, and the persona's Out of
//              Scope never sends that work anywhere
//   note       informational (no routing department, so no cross-check)
// Only errors, and a directory too large for the prompt, fail the export.
// Topic matching is word overlap, so conflicts and gaps are prompts for a
// human to read the row, not verdicts.
//
// Every message names a row by "<Title> (<Department>)" and has the
// directory's own names replaced: the workflow that prints them is public. A
// Backup or target that resolves to no one is never quoted, since it may name
// someone outside the directory.

import {
  DIRECTORY_VERSION,
  PERSONAS_MAX_CHARS,
  renderDirectory,
  staffNames
} from "../src/lib/personas.ts";
import type { Persona } from "../src/lib/personas.ts";
import type { RoutingDepartment, RoutingExclusion } from "./persona-parse.ts";

export type IssueLevel = "error" | "reference" | "conflict" | "gap" | "note";

export type Issue = {
  readonly level: IssueLevel;
  /** "<Title> (<Department>)": a role, never a name. */
  readonly row: string;
  readonly message: string;
};

export type CheckResult = {
  readonly issues: Issue[];
  /** The personas that pass, in input order: what gets uploaded. */
  readonly valid: Persona[];
  /** Rendered size of `valid` with no ceiling applied. */
  readonly renderedChars: number;
  /** Why nothing may be uploaded, or null when the upload may go ahead. */
  readonly blocked: string | null;
};

const STOPWORDS = new Set([
  "about",
  "after",
  "all",
  "and",
  "any",
  "anything",
  "for",
  "from",
  "into",
  "issue",
  "issues",
  "once",
  "own",
  "question",
  "questions",
  "that",
  "the",
  "their",
  "this",
  "when",
  "with"
]);

// Lowercased words of three or more letters, hyphenated compounds kept whole
// so "non-clinical" never matches "clinical", with a plural "s" dropped.
export function topicWords(text: string): Set<string> {
  const words = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9-]+/)) {
    const word = raw.replace(/^-+|-+$/g, "");
    if (word.length < 3 || STOPWORDS.has(word)) continue;
    words.add(word.length > 4 && word.endsWith("s") ? word.slice(0, -1) : word);
  }
  return words;
}

// Two topics are about the same work when they share two words, or share one
// when either topic is only one or two words long ("Clinical questions" and
// "Clinical questions (Clinical or Provider)").
export function topicsOverlap(a: string, b: string): boolean {
  const wa = topicWords(a);
  const wb = topicWords(b);
  let shared = 0;
  for (const word of wa) if (wb.has(word)) shared += 1;
  return shared >= 2 || (shared >= 1 && Math.min(wa.size, wb.size) <= 2);
}

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

// Whole-phrase containment on word tokens (no RegExp built from data).
function containsPhrase(haystack: string[], phrase: string[]): boolean {
  if (phrase.length === 0 || phrase.length > haystack.length) return false;
  for (let i = 0; i + phrase.length <= haystack.length; i++) {
    if (phrase.every((word, j) => haystack[i + j] === word)) return true;
  }
  return false;
}

// Departments a piece of text names: by full name, by the name without its
// parenthetical ("Member Experience"), or by an "Also called" alias.
export function departmentsNamedIn(
  text: string,
  departments: readonly RoutingDepartment[]
): string[] {
  const words = tokens(text);
  const found: string[] = [];
  for (const dept of departments) {
    const phrases = [
      dept.name,
      dept.name.replace(/\s*\([^)]*\)\s*$/, ""),
      ...dept.aliases
    ];
    if (phrases.some((phrase) => containsPhrase(words, tokens(phrase)))) {
      found.push(dept.name);
    }
  }
  return found;
}

function withoutParenthetical(text: string): string {
  return text
    .replace(/\([^)]*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// Every key a reference could use for a person: the full name, the first
// name of a multi-word name, and "dr x" for "Dr. X".
function personKeys(persona: Persona): string[] {
  const full = withoutParenthetical(persona.name);
  const keys = [full, full.replace(/^dr\.\s*/, "dr ")];
  const words = full.split(" ");
  if (words.length > 1 && !/^dr\.?$/.test(words[0])) keys.push(words[0]);
  return [...new Set(keys)];
}

type Resolver = {
  person(text: string): Persona[];
  departments(text: string): string[];
};

function resolver(
  personas: readonly Persona[],
  departments: readonly RoutingDepartment[]
): Resolver {
  const index = new Map<string, Persona[]>();
  for (const persona of personas) {
    for (const key of personKeys(persona)) {
      index.set(key, [...(index.get(key) ?? []), persona]);
    }
  }
  return {
    person(text) {
      const key = withoutParenthetical(text).replace(/^dr\.\s*/, "dr ");
      return index.get(key) ?? [];
    },
    departments(text) {
      return departmentsNamedIn(text, departments);
    }
  };
}

function rowOf(persona: Persona): string {
  return `${persona.title.trim() || "untitled row"} (${persona.department.trim() || "no department"})`;
}

// The departments an exclusion hands work to, minus the persona's own (an
// RCM item that reads "RCM escalates missing info to MX" points at MX).
function exclusionTargets(
  exclusion: RoutingExclusion,
  own: readonly string[],
  resolve: Resolver
): string[] {
  const text = exclusion.target || exclusion.topic;
  return resolve.departments(text).filter((dept) => !own.includes(dept));
}

// Where a persona's Out of Scope line sends work, as routing departments:
// named departments directly, named people through their own departments.
function redirectDepartments(targets: readonly string[], resolve: Resolver) {
  const out = new Set<string>();
  for (const target of targets) {
    for (const dept of resolve.departments(target)) out.add(dept);
    for (const person of resolve.person(target)) {
      for (const dept of person.routingDepartments) out.add(dept);
    }
  }
  return out;
}

// Replaces every directory name in a message, longest first so a full name
// goes before its first name. Case-sensitive: names are capitalised in text.
export function redactNames(text: string, names: readonly string[]): string {
  let out = text;
  for (const name of [...names].sort((a, b) => b.length - a.length)) {
    if (name) out = out.split(name).join("<person>");
  }
  return out;
}

export function checkDirectory(
  personas: readonly Persona[],
  departments: readonly RoutingDepartment[],
  maxChars = PERSONAS_MAX_CHARS
): CheckResult {
  const names = staffNames({
    version: DIRECTORY_VERSION,
    generated_at: "",
    personas
  });
  const issues: Issue[] = [];
  const add = (level: IssueLevel, persona: Persona, message: string) =>
    issues.push({
      level,
      row: rowOf(persona),
      message: redactNames(message, names)
    });
  const resolve = resolver(personas, departments);
  const knownDepartments = new Set(departments.map((dept) => dept.name));
  const excluded = new Set<Persona>();

  for (const persona of personas) {
    // Errors: the row cannot be used as it stands.
    const missing = [
      persona.title.trim() ? null : "Title",
      persona.department.trim() ? null : "Department",
      persona.owns.length > 0 ? null : "Core Responsibilities"
    ].filter((field): field is string => field !== null);
    if (missing.length > 0) {
      add("error", persona, `left out: no ${missing.join(", ")}`);
      excluded.add(persona);
    }
    // References: names and departments that point at nothing.
    const backup = persona.backup.trim();
    if (backup) {
      const people = resolve.person(backup);
      if (people.includes(persona)) {
        add("reference", persona, "Backup is the person themself");
      } else if (
        people.length === 0 &&
        resolve.departments(backup).length === 0
      ) {
        // The value is not quoted: it may name someone outside the
        // directory, whom redactNames cannot know to hide.
        add(
          "reference",
          persona,
          "Backup matches no one in the directory and no department"
        );
      }
    }
    for (const entry of persona.outOfScope) {
      if (entry.targets.length === 0) continue;
      const people = entry.targets.flatMap((t) => resolve.person(t));
      if (people.includes(persona)) {
        add(
          "reference",
          persona,
          `Out of Scope "${entry.topic}" routes back to the same person`
        );
      }
      const resolved = entry.targets.some(
        (t) => resolve.person(t).length > 0 || resolve.departments(t).length > 0
      );
      if (!resolved) {
        add(
          "reference",
          persona,
          `Out of Scope "${entry.topic}" routes to no one in the directory and no department`
        );
      }
    }
    if (knownDepartments.size > 0) {
      for (const dept of persona.routingDepartments) {
        if (!knownDepartments.has(dept)) {
          add(
            "reference",
            persona,
            `Routing Department "${dept}" is not a department on the routing map`
          );
        }
      }
    }

    if (persona.routingDepartments.length === 0) {
      add(
        "note",
        persona,
        "no Routing Department, so the routing-map cross-check is skipped"
      );
      continue;
    }
    if (departments.length === 0) continue;
    const own = persona.routingDepartments;
    const ownDepartments = departments.filter((dept) =>
      own.includes(dept.name)
    );

    // Conflicts, direction 1: owning work the persona's department excludes.
    for (const dept of ownDepartments) {
      for (const exclusion of dept.exclusions) {
        for (const line of persona.owns) {
          if (topicsOverlap(line, exclusion.topic)) {
            add(
              "conflict",
              persona,
              `owns "${line}", but ${dept.name} excludes "${exclusion.topic}"${exclusion.target ? ` (${exclusion.target})` : ""}`
            );
          }
        }
      }
    }

    // Conflicts, direction 2: redirecting a topic to someone whose department
    // excludes it.
    for (const entry of persona.outOfScope) {
      for (const target of entry.targets) {
        for (const person of resolve.person(target)) {
          for (const dept of departments) {
            if (!person.routingDepartments.includes(dept.name)) continue;
            for (const exclusion of dept.exclusions) {
              if (topicsOverlap(entry.topic, exclusion.topic)) {
                add(
                  "conflict",
                  persona,
                  `sends "${entry.topic}" to ${rowOf(person)}, but ${dept.name} excludes "${exclusion.topic}"${exclusion.target ? ` (${exclusion.target})` : ""}`
                );
              }
            }
          }
        }
      }
    }

    // Gaps: work the department excludes that the persona never sends on.
    for (const dept of ownDepartments) {
      for (const exclusion of dept.exclusions) {
        const targets = exclusionTargets(exclusion, own, resolve);
        if (targets.length === 0) continue;
        const covered = persona.outOfScope.some((entry) => {
          if (topicsOverlap(entry.topic, exclusion.topic)) return true;
          const sendsTo = redirectDepartments(entry.targets, resolve);
          return targets.some((dept) => sendsTo.has(dept));
        });
        if (!covered) {
          add(
            "gap",
            persona,
            `${dept.name} excludes "${exclusion.topic}" (${targets.join(" or ")}), but Out of Scope never sends it on`
          );
        }
      }
    }
  }

  const valid = personas.filter((persona) => !excluded.has(persona));
  const renderedChars = renderDirectory(
    { version: DIRECTORY_VERSION, generated_at: "", personas: valid },
    Number.POSITIVE_INFINITY
  ).length;
  let blocked: string | null = null;
  if (valid.length === 0) {
    blocked = "no usable Live rows";
  } else if (renderedChars > maxChars) {
    blocked = `the directory renders to ${renderedChars} characters, over the ${maxChars} ceiling; shorten Core Responsibilities or Out of Scope lines`;
  }
  return { issues, valid, renderedChars, blocked };
}

const LEVEL_ORDER: readonly IssueLevel[] = [
  "error",
  "reference",
  "conflict",
  "gap",
  "note"
];

// Plain-text report, most severe first: a counts line, then one line per
// issue.
export function formatIssues(result: CheckResult): string[] {
  const counts = LEVEL_ORDER.map(
    (level) =>
      `${result.issues.filter((issue) => issue.level === level).length} ${level}`
  ).join(", ");
  const lines = [
    `${result.valid.length} persona(s) usable, ${result.renderedChars} characters rendered; ${counts}.`
  ];
  for (const level of LEVEL_ORDER) {
    for (const issue of result.issues) {
      if (issue.level === level) {
        lines.push(`${level}: ${issue.row}: ${issue.message}`);
      }
    }
  }
  if (result.blocked) lines.push(`not uploaded: ${result.blocked}`);
  return lines;
}
