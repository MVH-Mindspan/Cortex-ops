import { test } from "node:test";
import assert from "node:assert/strict";
import {
  labelled,
  outOfScopeFrom,
  personaFrom,
  routingDepartmentsFrom,
  sectionsOf,
  type PersonaRow
} from "./persona-parse.ts";

// Fictional people only: this repository is public.
const BODY = `## Core Responsibilities
- Own **new referrals**
- Route intake questions

## Domain Expertise
- **Clinical/Operational Domains:** Intake
- **Systems:** Salesforce, Athena

## Out of Scope (Do NOT route here)
- Clinical questions (route to Blake Rowe — this was a known misroute)
- Copay or billing questions (route to Casey / Billing Team)
- IT help desk (→ Drew)
- Day-to-day routing (use the specific person above)

## Escalation Path
- **Backup:** Blake Rowe (clinical questions only)
- **Escalates to:** Morgan (Operations Management)

## How to Reach
- **Slack:** #fictional-intake (unverified)
- **Dashboard:** Escalate → Member Experience
`;

function row(overrides: Partial<PersonaRow> = {}): PersonaRow {
  return {
    name: "Avery Quinn",
    title: "Intake Lead",
    department: "Operations",
    routingDepartments: ["Enrollment"],
    priority: "P0 — Launch",
    backup: "Blake Rowe",
    slackChannel: "#fictional-intake",
    routeWhen: "Referral intake;  new leads\nfrom the website",
    markdown: BODY,
    ...overrides
  };
}

test("sectionsOf keys headings without their parenthetical and strips emphasis", () => {
  const sections = sectionsOf(BODY);
  assert.deepEqual(sections.get("core responsibilities"), [
    "Own new referrals",
    "Route intake questions"
  ]);
  assert.equal(sections.get("out of scope")?.length, 4);
  assert.equal(
    labelled(sections.get("domain expertise"), "systems"),
    "Salesforce, Athena"
  );
  assert.equal(labelled(sections.get("domain expertise"), "backup"), "");
  assert.equal(labelled(undefined, "systems"), "");
});

test("outOfScopeFrom reads both route forms, slashes, and drops commentary", () => {
  assert.deepEqual(
    outOfScopeFrom(
      "Clinical questions (route to Blake Rowe — this was a known misroute)"
    ),
    { topic: "Clinical questions", targets: ["Blake Rowe"] }
  );
  assert.deepEqual(
    outOfScopeFrom(
      "Copay or billing questions (route to Casey / Billing Team)"
    ),
    { topic: "Copay or billing questions", targets: ["Casey", "Billing Team"] }
  );
  assert.deepEqual(outOfScopeFrom("IT help desk (→ Drew)"), {
    topic: "IT help desk",
    targets: ["Drew"]
  });
  assert.deepEqual(outOfScopeFrom("Scheduling (route to Emery or Finley)"), {
    topic: "Scheduling",
    targets: ["Emery", "Finley"]
  });
  assert.deepEqual(
    outOfScopeFrom("Day-to-day routing (use the specific person above)"),
    { topic: "Day-to-day routing (use the specific person above)", targets: [] }
  );
});

test("personaFrom reads the page template", () => {
  assert.deepEqual(personaFrom(row()), {
    name: "Avery Quinn",
    title: "Intake Lead",
    department: "Operations",
    routingDepartments: ["Enrollment"],
    priority: "P0",
    owns: ["Own new referrals", "Route intake questions"],
    systems: ["Salesforce", "Athena"],
    outOfScope: [
      { topic: "Clinical questions", targets: ["Blake Rowe"] },
      {
        topic: "Copay or billing questions",
        targets: ["Casey", "Billing Team"]
      },
      { topic: "IT help desk", targets: ["Drew"] },
      {
        topic: "Day-to-day routing (use the specific person above)",
        targets: []
      }
    ],
    backup: "Blake Rowe (clinical questions only)",
    escalatesTo: "Morgan (Operations Management)",
    reach: {
      slack: "#fictional-intake (unverified)",
      dashboard: "Escalate → Member Experience"
    },
    routeWhen: "Referral intake; new leads from the website"
  });
});

test("personaFrom falls back to the properties when the body has no line", () => {
  const persona = personaFrom(
    row({
      markdown: "## Core Responsibilities\n- Medication protocol updates\n",
      priority: "",
      backup: "Casey Lin",
      slackChannel: "Dashboard Escalate → Clinical"
    })
  );
  assert.equal(persona.priority, "P2");
  assert.equal(persona.backup, "Casey Lin");
  assert.deepEqual(persona.reach, {
    slack: "",
    dashboard: "Escalate → Clinical"
  });
  assert.deepEqual(persona.systems, []);
  assert.deepEqual(persona.outOfScope, []);
  assert.equal(
    personaFrom(row({ markdown: "", slackChannel: "Direct message" })).reach
      .slack,
    "Direct message"
  );
});

const MAP = `## Departments at a glance
- Alpha Team
**Do not send them:**
- Ignored before the Departments heading (Beta Desk)

# Departments

## Alpha Team

Also called: AT, alpha crew · Dashboard bucket: Escalate → Operations

Handles alpha work for scheduled members: readiness sweeps and chart checks.

**Send them:**

- Things alpha does (Alpha Team)

**Do not send them:**

- Insurance eligibility questions (Beta Desk)
- Operational chasing (order placement) that Alpha Team owns

**How to reach:**

- slack: #alpha

## Beta Desk (BD)

**Do not send them:**
- Clinical questions (Alpha Team or Beta Desk)
`;

test("routingDepartmentsFrom reads only the Departments part and only the exclusion lists", () => {
  assert.deepEqual(routingDepartmentsFrom(MAP), [
    {
      name: "Alpha Team",
      aliases: ["AT", "alpha crew"],
      exclusions: [
        { topic: "Insurance eligibility questions", target: "Beta Desk" },
        {
          topic: "Operational chasing (order placement) that Alpha Team owns",
          target: ""
        }
      ]
    },
    {
      name: "Beta Desk (BD)",
      aliases: [],
      exclusions: [
        { topic: "Clinical questions", target: "Alpha Team or Beta Desk" }
      ]
    }
  ]);
  assert.deepEqual(routingDepartmentsFrom("## No departments here\n- x"), []);
});
