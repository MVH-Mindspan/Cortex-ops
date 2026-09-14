// The person-level team directory the answer prompt names contacts from.
// Canonical in the Notion database "Team Directory (Cortex)"; the nightly
// Sync SOPs workflow exports it (scripts/export-personas.ts) to the private
// R2 bucket cortex-directory as DIRECTORY_KEY, and the Worker reads it per
// answer (server.ts loadDirectory). This repo is public, so no person ever
// appears in this file or its tests: the data lives only in Notion and R2.
//
// Sits alongside the team structure (teams.ts, name-free): the team
// structure says which team likely owns the work, the directory says which
// person to contact. Pure module: no imports, no side effects.
// parseDirectory guards the R2 JSON; renderDirectory is the only thing the
// prompt consumes.

export const DIRECTORY_KEY = "team-directory.json";
export const DIRECTORY_VERSION = 1;

// Ceiling for the rendered block. prompt.ts adds it to the prompt ceiling and
// pipeline.ts shrinks the SOP passages by the directory's actual size, so
// every character here is one fewer character of SOP text in a worst-case
// request. The export refuses to upload a directory that renders over it.
export const PERSONAS_MAX_CHARS = 9_000;

// Rollout tiers from the Notion Priority select ("P0 — Launch", ...). Render
// order, and the order whole personas are dropped in when over the ceiling.
export const PRIORITIES = ["P0", "P1", "P2"] as const;
export type PersonaPriority = (typeof PRIORITIES)[number];

/** One "Out of Scope" line: the topic, and who it goes to instead (people or
 * departments, as the page names them; empty when the page names no one). */
export type OutOfScope = {
  readonly topic: string;
  readonly targets: readonly string[];
};

export type Persona = {
  readonly name: string;
  readonly title: string;
  /** The Notion Department select: Clinical, Operations, Technology, ... */
  readonly department: string;
  /** Free-text "route to me when ..." hint from the page's "## Route When"
   * section; a first-class matching signal in contacts.ts. "" when absent. */
  readonly routeWhen: string;
  /** Department Routing Map departments, for validate-routing only. */
  readonly routingDepartments: readonly string[];
  readonly priority: PersonaPriority;
  readonly owns: readonly string[];
  readonly systems: readonly string[];
  readonly outOfScope: readonly OutOfScope[];
  readonly backup: string;
  readonly escalatesTo: string;
  readonly reach: { readonly slack: string; readonly dashboard: string };
};

export type Directory = {
  readonly version: typeof DIRECTORY_VERSION;
  readonly generated_at: string;
  readonly personas: readonly Persona[];
};

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

function isOutOfScope(value: unknown): value is OutOfScope {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return isString(entry.topic) && isStringArray(entry.targets);
}

function isPersona(value: unknown): value is Persona {
  if (!value || typeof value !== "object") return false;
  const p = value as Record<string, unknown>;
  const reach = p.reach as Record<string, unknown> | null | undefined;
  return (
    isString(p.name) &&
    p.name.trim().length > 0 &&
    isString(p.title) &&
    isString(p.department) &&
    // Tolerated missing so a directory exported before this field existed still
    // parses; parseDirectory fills the absent value with "".
    (p.routeWhen === undefined || isString(p.routeWhen)) &&
    isStringArray(p.routingDepartments) &&
    PRIORITIES.includes(p.priority as PersonaPriority) &&
    isStringArray(p.owns) &&
    isStringArray(p.systems) &&
    Array.isArray(p.outOfScope) &&
    p.outOfScope.every(isOutOfScope) &&
    isString(p.backup) &&
    isString(p.escalatesTo) &&
    Boolean(reach) &&
    typeof reach === "object" &&
    isString(reach?.slack) &&
    isString(reach?.dashboard)
  );
}

// The R2 object as the Worker reads it. Any shape mismatch (a half-written
// object, an export from a newer version) returns null so the answer goes out
// with the team structure alone rather than with a garbled directory.
export function parseDirectory(value: unknown): Directory | null {
  if (!value || typeof value !== "object") return null;
  const d = value as Record<string, unknown>;
  if (
    d.version !== DIRECTORY_VERSION ||
    !isString(d.generated_at) ||
    !Array.isArray(d.personas) ||
    !d.personas.every(isPersona)
  ) {
    return null;
  }
  return {
    version: DIRECTORY_VERSION,
    generated_at: d.generated_at,
    // Fill a routeWhen absent from an older exported object, so the rest of the
    // code reads a string, never undefined.
    personas: d.personas.map((p) => ({ ...p, routeWhen: p.routeWhen ?? "" }))
  };
}

// Notion text can carry line breaks; the block's layout is one line per
// field, so every value is collapsed to a single line.
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// How answers say to reach the person: Slack when the entry has a Slack route
// (operator decision, 14 Sep 2026: everything goes via Slack), else the
// dashboard. An "(unverified)" marker in Notion is for its editors and never
// reaches an answer.
export function reachOf(persona: Persona): string {
  const clean = (text: string) => oneLine(text.replace(/\(unverified\)/gi, ""));
  const slack = clean(persona.reach.slack);
  if (slack) {
    return /^direct message$/i.test(slack)
      ? "Slack direct message"
      : `Slack ${slack}`;
  }
  const dashboard = clean(persona.reach.dashboard);
  return dashboard ? `Dashboard ${dashboard}` : "";
}

// One persona in the spec's compact template: a header line, then one "- "
// line per non-empty field.
export function renderPersona(persona: Persona): string {
  const lines = [
    `${oneLine(persona.name)}: ${oneLine(persona.title)} (${oneLine(persona.department)})`
  ];
  if (persona.routeWhen.trim()) {
    lines.push(`- Route when: ${oneLine(persona.routeWhen)}`);
  }
  if (persona.owns.length > 0) {
    lines.push(`- Owns: ${persona.owns.map(oneLine).join("; ")}`);
  }
  if (persona.systems.length > 0) {
    lines.push(`- Systems: ${persona.systems.map(oneLine).join(", ")}`);
  }
  if (persona.outOfScope.length > 0) {
    const entries = persona.outOfScope.map((entry) =>
      entry.targets.length > 0
        ? `${oneLine(entry.topic)} → ${entry.targets.map(oneLine).join(" / ")}`
        : oneLine(entry.topic)
    );
    lines.push(`- Out of scope: ${entries.join("; ")}`);
  }
  if (persona.backup.trim()) lines.push(`- Backup: ${oneLine(persona.backup)}`);
  if (persona.escalatesTo.trim()) {
    lines.push(`- Escalates to: ${oneLine(persona.escalatesTo)}`);
  }
  const reach = reachOf(persona);
  if (reach) lines.push(`- Reach: ${reach}`);
  return lines.join("\n");
}

// Deterministic text block, P0 first, blank line between personas, no
// heading (prompt.ts owns the section title and intro). Over the ceiling,
// whole personas are dropped from the end (lowest tier first), never cut
// mid-way: a half persona could lose its Out of Scope line and route the very
// questions it exists to redirect.
export function renderDirectory(
  directory: Directory | null,
  maxChars = PERSONAS_MAX_CHARS
): string {
  if (!directory) return "";
  const ordered = [...directory.personas].sort(
    (a, b) => PRIORITIES.indexOf(a.priority) - PRIORITIES.indexOf(b.priority)
  );
  const blocks = ordered.map(renderPersona);
  while (blocks.length > 0 && blocks.join("\n\n").length > maxChars) {
    blocks.pop();
  }
  return blocks.join("\n\n");
}

// Names the patient-name screen treats as staff (lib/screen.ts): every full
// name, plus the first name of a multi-word name that is not a "Dr." name
// (the screen already exempts clinicians by title).
export function staffNames(directory: Directory | null): string[] {
  if (!directory) return [];
  const names = new Set<string>();
  for (const persona of directory.personas) {
    const name = oneLine(persona.name);
    if (!name) continue;
    names.add(name);
    const words = name.split(" ");
    if (words.length > 1 && !/^dr\.?$/i.test(words[0])) names.add(words[0]);
  }
  return [...names];
}
