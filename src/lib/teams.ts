// The Operations team structure the answer prompt steers with. Hand-derived
// on 2026-09-02 from the Notion page "Operations Teams Structure Overview"
// (teams, functions, handoffs) and, for the "Also called" vocabulary and the
// outside-Operations groups, from "Department Routing Map (Cortex) v0.1".
// Not synced from Notion: edit here when the page changes.
//
// Content rules, pinned by teams.test.ts: teams and functions only, never a
// person, a Slack channel, a link, an arrow, or an em dash; none of the page's
// open questions or design notes; a function line says what it covers, never
// how (no imperatives, no click paths). Teams render as "<name> team" so a
// bare team name never collides with an SOP title. Pure module: no imports.
// renderTeamStructure() is the only thing the prompt consumes.

export type TeamName =
  | "Expansion & Operational Growth"
  | "Care Support"
  | "Implementation"
  | "Operational Excellence";

export type TeamFunction = {
  readonly name: string;
  /** One clause of noun phrases: what the function covers, never how. */
  readonly covers: string;
  /** Names the SOPs use for this function. Unique across the directory. */
  readonly aliases?: readonly string[];
};

export type Team = {
  readonly name: TeamName;
  readonly purpose: string;
  /** How work reaches the team, when the page names an intake. */
  readonly route?: string;
  readonly functions: readonly TeamFunction[];
};

export type Handoff = {
  readonly from: TeamName;
  readonly to: TeamName;
  /** The criterion, never a timeline, that moves work across. */
  readonly when: string;
};

export type OutsideGroup = {
  readonly name: string;
  readonly covers: string;
  readonly aliases?: readonly string[];
  /** The Operations function that coordinates with this group. */
  readonly contact: { readonly team: TeamName; readonly fn: string };
};

// Ceiling for the rendered block. The window arithmetic in pipeline.ts and
// the prompt ceiling in prompt.ts assume it; trim a function line rather than
// raising it.
export const TEAM_STRUCTURE_MAX_CHARS = 5_500;

export const TEAMS: readonly Team[] = [
  {
    name: "Expansion & Operational Growth",
    purpose:
      "everything before a clinic, provider, or health system is live, through activation and handoff to Care Support",
    functions: [
      {
        name: "New Clinic & Provider Onboarding",
        covers:
          "activating a new clinic or provider: scoping, scheduling setup, EHR access and configuration, signage, referral pathway confirmation, readiness sign-off",
        aliases: ["onboarding", "activation", "go-live"]
      },
      {
        name: "Health System Partnerships",
        covers:
          "a health system from contract to activation: referral flows, contact training, integrations, credentialing, payer alignment"
      },
      {
        name: "Account Management (Pre-Handoff)",
        covers:
          "primary contact for providers and health-system stakeholders during activation; asks Implementation when a new workflow is needed"
      },
      {
        name: "Recruiting",
        covers:
          "sourcing and candidate pipeline for Operations roles, then handoff to HR"
      }
    ]
  },
  {
    name: "Care Support",
    purpose:
      "the operational backbone for live clinics and established partners; the first point of contact for inbound requests from patients, providers, and health-system staff",
    route: "Inbound Triage (Zendesk)",
    functions: [
      {
        name: "Inbound Triage",
        covers:
          "every inbound request enters one Zendesk queue to be categorised, prioritised, and routed; inbound mail is scanned here",
        aliases: ["Zendesk triage", "ticket queue"]
      },
      {
        name: "Patient Support (Enrollment & Member Experience)",
        covers:
          "the patient lifecycle from first referral through ongoing engagement: enrollment calls, scheduling coordination, follow-up outreach, language access, complaints and experience issues; care coordinators sit here",
        aliases: [
          "Enrollment",
          "Enrollment Specialist",
          "Member Experience",
          "MX",
          "care coordinator",
          "Caregiver Liaison"
        ]
      },
      {
        name: "Provider & Clinic Support",
        covers:
          "day-to-day needs of active providers and clinics: scheduling support, clinic operations questions, supplies and logistics, provider-facing communications; provider escalations after activation",
        aliases: ["clinic support", "provider support"]
      },
      {
        name: "Post-Activation Account Management (Health Systems)",
        covers:
          "the health-system relationship after Expansion hands it off: referral flow monitoring, pipeline issues, operational point of contact"
      }
    ]
  },
  {
    name: "Implementation",
    purpose:
      "designs and rolls out new workflows and product features and runs training; nothing moves from design to production without it",
    functions: [
      {
        name: "Workflow Design & Product Partnership",
        covers:
          "turning product features (for example the Orchestration Engine or a new EHR integration) into Operations workflows and SOPs; workflow change requests for recurring issues",
        aliases: ["new workflow", "workflow change request"]
      },
      {
        name: "New Feature Rollouts & Pilot Coordination",
        covers:
          "pilot parameters, monitoring, and documented outcomes before wider rollout",
        aliases: ["pilot", "rollout"]
      },
      {
        name: "Training Design & Administration",
        covers: "training for all Operations roles, measured on outcomes",
        aliases: ["training"]
      },
      {
        name: "Training Stickiness & Handoff Readiness",
        covers:
          "confirming Care Support is trained and tested before a workflow is handed to it"
      }
    ]
  },
  {
    name: "Operational Excellence",
    purpose:
      "the infrastructure the rest of Operations runs on: data and dashboards, vendors, the liaisons to Finance and to Revenue Cycle Management (RCM), cross-team efficiency",
    functions: [
      {
        name: "Data Management & Dashboards",
        covers:
          "operational dashboards (referral pathways, visit completion, provider asks, patient churn); data cleanup, source integrations, EHR data dependencies",
        aliases: ["dashboards", "reporting"]
      },
      {
        name: "Vendor Management",
        covers:
          "external vendors (telephony, virtual mail, ticketing, translation services, other ops tools): renewals, pricing, escalations, evaluation",
        aliases: ["vendor", "telephony", "translation services"]
      },
      {
        name: "RCM Liaison",
        covers:
          "the bridge between Operations and RCM so CPT code alignment, prior authorization steps, and claim documentation are reflected in ops SOPs; billing issues needing a process change go to Implementation",
        aliases: ["CPT code", "claim documentation"]
      },
      {
        name: "Finance Liaison",
        covers:
          "budget tracking, vendor invoicing, headcount inputs, operational cost reporting with Finance"
      },
      {
        name: "Team Efficiency & Process Infrastructure",
        covers:
          "tool consolidation, internal communication workflows, cross-team coordination; the framework for how SOPs are documented, versioned, and accessed",
        aliases: ["SOP framework"]
      }
    ]
  }
];

export const HANDOFFS: readonly Handoff[] = [
  {
    from: "Expansion & Operational Growth",
    to: "Care Support",
    when: "a site live 3+ months, its Care Support SOPs complete, no p0 or p1 issue open"
  },
  {
    from: "Implementation",
    to: "Care Support",
    when: "a workflow documented, trained, and tested against measurable criteria"
  },
  {
    from: "Care Support",
    to: "Implementation",
    when: "a p0 or p1 issue, or a recurring ticket type, shows a workflow gap or product need"
  },
  {
    from: "Expansion & Operational Growth",
    to: "Implementation",
    when: "a new site needs a technical workflow that does not exist yet"
  }
];

export const OUTSIDE_OPERATIONS: readonly OutsideGroup[] = [
  {
    name: "Clinical",
    covers:
      "clinical checks, visits, signing notes, interpreting results, treatment decisions",
    aliases: ["RN", "MA", "nurse", "clinician", "physician"],
    contact: { team: "Care Support", fn: "Provider & Clinic Support" }
  },
  {
    name: "Revenue Cycle Management",
    covers:
      "insurance setup and eligibility, prior authorization, claim documentation, billing",
    aliases: ["RCM", "billing", "claims", "eligibility", "prior authorization"],
    contact: { team: "Operational Excellence", fn: "RCM Liaison" }
  },
  {
    name: "Platform",
    covers:
      "automated tasks, the Orchestration Engine, dashboard bugs; contacted when an automation fails or a task looks wrong",
    aliases: ["product", "engineering", "dashboard team", "automation"],
    contact: {
      team: "Implementation",
      fn: "Workflow Design & Product Partnership"
    }
  }
];

function alsoCalled(aliases: readonly string[] | undefined): string {
  return aliases && aliases.length > 0
    ? ` Also called: ${aliases.join(", ")}.`
    : "";
}

// Deterministic text block: one header line per team, one "- " line per
// function, then the handoffs and the outside groups, each block omitted when
// empty. No heading here: prompt.ts owns the section title and intro.
export function renderTeamStructure(
  teams: readonly Team[] = TEAMS,
  handoffs: readonly Handoff[] = HANDOFFS,
  outside: readonly OutsideGroup[] = OUTSIDE_OPERATIONS
): string {
  const blocks: string[] = [];
  for (const team of teams) {
    const route = team.route ? ` Route work through: ${team.route}.` : "";
    const lines = [`${team.name} team: ${team.purpose}.${route}`];
    for (const fn of team.functions) {
      lines.push(`- ${fn.name}: ${fn.covers}.${alsoCalled(fn.aliases)}`);
    }
    blocks.push(lines.join("\n"));
  }
  if (handoffs.length > 0) {
    const lines = [
      "Handoffs (criteria, not timelines; crossing one involves both teams):"
    ];
    for (const handoff of handoffs) {
      lines.push(`- ${handoff.from} to ${handoff.to}: ${handoff.when}.`);
    }
    blocks.push(lines.join("\n"));
  }
  if (outside.length > 0) {
    const lines = [
      "Outside Operations (say so, and name the Operations function that coordinates):"
    ];
    for (const group of outside) {
      lines.push(
        `- ${group.name}: ${group.covers}.${alsoCalled(group.aliases)} Operations contact: ${group.contact.team} team, ${group.contact.fn} function.`
      );
    }
    blocks.push(lines.join("\n"));
  }
  return blocks.join("\n\n");
}
