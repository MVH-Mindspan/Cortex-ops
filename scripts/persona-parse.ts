// Parses the two Notion sources of the team directory. Pure module (type-only
// imports) so it is unit-tested with node:test on fictional fixtures: the
// real directory never enters this public repo.
//
// personaFrom: one Team Directory (Cortex) row, its properties already read
// into a PersonaRow plus its page body as markdown (notion-to-md), into a
// Persona. The pages share one template: "## Route When" (free-text hint for
// when to route here), "## Core Responsibilities", "## Domain Expertise" (a
// "Systems:" line), "## Out of Scope (Do NOT route here)", "## Escalation Path"
// ("Backup:", "Escalates to:") and "## How to Reach" ("Slack:", "Dashboard:").
// A section the page lacks leaves its field empty; the Backup and Slack Channel
// properties fill in when the body has no line for them.
//
// routingDepartmentsFrom: the Department Routing Map page. Its
// "# Departments" part has one "## <Department>" section per department with
// an "Also called:" line and a "**Do not send them:**" list whose items end
// in the department the work belongs to, in parentheses. Those lists are what
// validate-routing checks each persona's Out of Scope against.
//
// Runs on Node 24 native type stripping: erasable TS syntax only.

import type {
  OutOfScope,
  Persona,
  PersonaPriority
} from "../src/lib/personas.ts";

/** The properties of one Team Directory row, as plain strings. */
export type PersonaRow = {
  name: string;
  title: string;
  department: string;
  routingDepartments: string[];
  /** The Priority select as Notion names it, e.g. "P0 — Launch". */
  priority: string;
  backup: string;
  slackChannel: string;
  routeWhen: string;
  /** The page body, rendered to markdown. */
  markdown: string;
};

export type RoutingExclusion = {
  readonly topic: string;
  /** The trailing parenthetical, e.g. "RCM" or "Care Coordination or
   * Member Experience"; empty when the item names no department. */
  readonly target: string;
};

export type RoutingDepartment = {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly exclusions: readonly RoutingExclusion[];
};

// Markdown emphasis and runs of whitespace out; the parsers compare text.
function clean(text: string): string {
  return text
    .replace(/\*\*|__/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const HEADING = /^#{1,6}\s+(.+?)\s*$/;
const BULLET = /^\s*[-*+]\s+(.+)$/;

// Section heading → its bullet texts. Keys are lowercased with a trailing
// parenthetical dropped: "Out of Scope (Do NOT route here)" → "out of scope".
export function sectionsOf(markdown: string): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of markdown.split(/\r?\n/)) {
    const heading = line.match(HEADING);
    if (heading) {
      const key = clean(heading[1])
        .replace(/\s*\([^)]*\)$/, "")
        .toLowerCase();
      current = [];
      sections.set(key, current);
      continue;
    }
    const bullet = line.match(BULLET);
    if (bullet && current) {
      const text = clean(bullet[1]);
      if (text) current.push(text);
    }
  }
  return sections;
}

// The full text under a heading, prose and bullets alike, collapsed to one
// line; "" when the heading is absent. Used for "## Route When", whose hint may
// be a paragraph rather than bullets, so sectionsOf (bullets only) misses it.
export function sectionText(markdown: string, key: string): string {
  const out: string[] = [];
  let capturing = false;
  for (const line of markdown.split(/\r?\n/)) {
    const heading = line.match(HEADING);
    if (heading) {
      capturing =
        clean(heading[1])
          .replace(/\s*\([^)]*\)$/, "")
          .toLowerCase() === key;
      continue;
    }
    if (!capturing) continue;
    const bullet = line.match(BULLET);
    const text = clean(bullet ? bullet[1] : line);
    if (text) out.push(text);
  }
  return out.join(" ");
}

// The value of a "Label: value" bullet, or "" when the section has none.
export function labelled(
  bullets: readonly string[] | undefined,
  label: string
): string {
  for (const bullet of bullets ?? []) {
    const match = bullet.match(/^([^:]{1,40}):\s*(.*)$/);
    if (match && match[1].trim().toLowerCase() === label) {
      return match[2].trim();
    }
  }
  return "";
}

// "Copay or billing questions (route to Casey / Billing Team)" and
// "IT help desk (→ Drew)" alike (invented names: this repo is public).
// Commentary after a dash inside the parentheses ("Blake Rowe — this was a
// known misroute") is dropped:
// it explains the route, it is not a target. A line with no route keeps its
// whole text as the topic.
const ROUTE = /^(.*?)\s*\((?:route to|→|->)\s*([^)]*)\)\s*\.?$/i;
export function outOfScopeFrom(line: string): OutOfScope {
  const text = clean(line);
  const match = text.match(ROUTE);
  if (!match) return { topic: text, targets: [] };
  const target = match[2].split(/\s+[—–-]\s+/)[0];
  const targets = target
    .split(/\s*\/\s*|\s+or\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
  return { topic: match[1].trim(), targets };
}

function priorityOf(value: string): PersonaPriority {
  const match = value.trim().match(/^P([0-2])\b/i);
  return match ? (`P${match[1]}` as PersonaPriority) : "P2";
}

export function personaFrom(row: PersonaRow): Persona {
  const sections = sectionsOf(row.markdown);
  const expertise = sections.get("domain expertise");
  const escalation = sections.get("escalation path");
  const reach = sections.get("how to reach");
  const systems = labelled(expertise, "systems")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  // The Slack Channel property doubles as the reach field on pages whose
  // only route is the dashboard ("Dashboard Escalate → Clinical").
  const property = clean(row.slackChannel);
  const propertyIsDashboard = /^dashboard\b/i.test(property);
  return {
    name: clean(row.name),
    title: clean(row.title),
    department: clean(row.department),
    // The Route When property fills in when the body has no section, as
    // Backup and Slack Channel do; today the rows carry it as a property.
    routeWhen: sectionText(row.markdown, "route when") || clean(row.routeWhen),
    routingDepartments: row.routingDepartments.map(clean).filter(Boolean),
    priority: priorityOf(row.priority),
    owns: sections.get("core responsibilities") ?? [],
    systems,
    outOfScope: (sections.get("out of scope") ?? []).map(outOfScopeFrom),
    backup: labelled(escalation, "backup") || clean(row.backup),
    escalatesTo: labelled(escalation, "escalates to"),
    reach: {
      slack: labelled(reach, "slack") || (propertyIsDashboard ? "" : property),
      dashboard:
        labelled(reach, "dashboard") ||
        (propertyIsDashboard ? property.replace(/^dashboard\s*/i, "") : "")
    }
  };
}

function exclusionFrom(text: string): RoutingExclusion | null {
  const t = clean(text);
  if (!t) return null;
  const match = t.match(/^(.*?)\s*\(([^()]*)\)\s*\.?$/);
  return match
    ? { topic: match[1].trim(), target: match[2].trim() }
    : { topic: t, target: "" };
}

// Only the "# Departments" part of the page is read: the sections above it
// ("How to read", "Departments at a glance") use the same names in prose and
// tables. Inside a department, a "Label:" paragraph starts a new block, so the
// exclusion list runs from "Do not send them:" to the next label.
export function routingDepartmentsFrom(markdown: string): RoutingDepartment[] {
  const out: {
    name: string;
    aliases: string[];
    exclusions: RoutingExclusion[];
  }[] = [];
  let inDepartments = false;
  let current: (typeof out)[number] | null = null;
  let inExclusions = false;
  for (const line of markdown.split(/\r?\n/)) {
    const h1 = line.match(/^#\s+(.+?)\s*$/);
    if (h1) {
      inDepartments = clean(h1[1]).toLowerCase() === "departments";
      current = null;
      continue;
    }
    if (!inDepartments) continue;
    const h2 = line.match(/^##\s+(.+?)\s*$/);
    if (h2) {
      current = { name: clean(h2[1]), aliases: [], exclusions: [] };
      out.push(current);
      inExclusions = false;
      continue;
    }
    if (!current) continue;
    const bullet = line.match(BULLET);
    if (bullet) {
      if (inExclusions) {
        const exclusion = exclusionFrom(bullet[1]);
        if (exclusion) current.exclusions.push(exclusion);
      }
      continue;
    }
    const text = clean(line);
    const also = text.match(/^Also called:\s*(.+?)(?:\s+·|$)/i);
    if (also) {
      current.aliases = also[1]
        .split(",")
        .map((alias) => alias.trim())
        .filter(Boolean);
      continue;
    }
    if (/^[^:]{1,40}:/.test(text)) {
      inExclusions = /^do not send them:/i.test(text);
    }
  }
  return out;
}
