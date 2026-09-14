import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CONTACT_BLOCK_MAX_CHARS,
  contactBlockFor,
  contactQuery,
  contactWords,
  matchContacts,
  NO_CONTACT_LINE,
  renderContactBlock
} from "./contacts.ts";
import { DIRECTORY_VERSION, type Directory, type Persona } from "./personas.ts";

// Fictional people only: this repository is public.
function persona(overrides: Partial<Persona>): Persona {
  return {
    name: "Nobody",
    title: "Role",
    department: "Operations",
    routingDepartments: [],
    priority: "P0",
    owns: [],
    systems: [],
    outOfScope: [],
    backup: "",
    escalatesTo: "",
    reach: { slack: "", dashboard: "" },
    routeWhen: "",
    ...overrides
  };
}

const DIRECTORY: Directory = {
  version: DIRECTORY_VERSION,
  generated_at: "2026-09-14T00:00:00.000Z",
  personas: [
    persona({
      name: "Avery Quinn",
      title: "Intake Lead",
      routingDepartments: ["Enrollment"],
      owns: ["Referral intake, Salesforce leads", "Own enrollment funnel"],
      systems: ["Salesforce"],
      outOfScope: [
        { topic: "Clinical-judgment questions", targets: ["Blake Rowe"] }
      ]
    }),
    persona({
      name: "Blake Rowe",
      title: "Clinical Navigation Lead",
      department: "Clinical",
      routingDepartments: ["Care Coordination"],
      owns: [
        "Own clinical questions and clinical navigation",
        "Route clinical-judgment questions accordingly"
      ],
      outOfScope: [
        { topic: "Copay or billing questions", targets: ["Casey"] },
        { topic: "IT issues", targets: ["Drew"] }
      ]
    }),
    persona({
      name: "Casey Lin",
      title: "Billing Lead",
      department: "Finance",
      routingDepartments: ["RCM"],
      owns: ["Billing configuration", "Copay-process questions"],
      systems: ["Athena"]
    }),
    persona({
      name: "Drew Park",
      title: "IT",
      department: "Technology",
      owns: [
        "IT issues and technical infrastructure",
        "LabCorp-related coordination"
      ],
      systems: ["Athena", "LabCorp"]
    }),
    persona({
      name: "Emery Cole",
      title: "Front Desk (Danvers)",
      priority: "P1",
      owns: ["Front-desk check-ins", "Phone coverage"]
    }),
    persona({
      name: "Finley Shaw",
      title: "New Clinics (Danvers)",
      priority: "P1",
      owns: ["New clinic setup", "Front-desk check-in training"],
      outOfScope: [{ topic: "Clinical questions", targets: ["Blake"] }]
    })
  ]
};

const names = (text: string) =>
  matchContacts(DIRECTORY, text).map((m) => m.persona.name);

test("contactWords keeps negated compounds whole, acronyms, and drops filler", () => {
  assert.deepEqual(contactWords("Own non-clinical operations"), [
    "nonclinical",
    "operation"
  ]);
  assert.deepEqual(contactWords("Who fixes IT? it is broken"), [
    "fixe",
    "it",
    "broken"
  ]);
  assert.deepEqual(contactWords("Copay-process questions for the patient"), [
    "copay",
    "process"
  ]);
});

test("the owner of the work wins over the team it sits near", () => {
  // Copay: the billing lead owns it, and another entry redirects it there.
  assert.deepEqual(
    names(
      "A family member asks why they were charged a copay. Who handles copay questions?"
    ),
    ["Casey Lin"]
  );
  // Clinical judgment: the intake lead has it on their Out of scope line.
  assert.deepEqual(names("Is increasing the dose a clinical judgment call?"), [
    "Blake Rowe"
  ]);
  assert.deepEqual(names("A new referral arrived by fax this morning"), [
    "Avery Quinn"
  ]);
  // An acronym on its own still matches, helped by the redirect.
  assert.deepEqual(names("Who fixes IT problems with the laptop?"), [
    "Drew Park"
  ]);
});

test("a Route When hint matches, and the block cites it as the reason", () => {
  const dir: Directory = {
    version: DIRECTORY_VERSION,
    generated_at: "2026-09-14T00:00:00.000Z",
    personas: [
      persona({
        name: "Robin Vale",
        title: "Escalations Lead",
        owns: ["General coordination"],
        routeWhen:
          "Any CRIOS readiness escalation, or a stuck onboarding cohort"
      }),
      persona({ name: "Sam Doe", title: "Coordinator", owns: ["Scheduling"] })
    ]
  };
  const matches = matchContacts(dir, "We have a CRIOS readiness escalation");
  assert.deepEqual(
    matches.map((m) => m.persona.name),
    ["Robin Vale"]
  );
  assert.equal(
    renderContactBlock(dir, matches).split("\n")[1],
    '1. Robin Vale, Escalations Lead (Operations). Route when "Any CRIOS readiness escalation, or a stuck onboarding cohort".'
  );
});

test("a product name alone does not make someone the owner", () => {
  assert.deepEqual(names("LabCorp says they never received the order"), []);
  assert.equal(
    contactBlockFor(DIRECTORY, [
      { role: "user", content: "LabCorp says they never received the order" }
    ]).block,
    NO_CONTACT_LINE
  );
});

test("the title breaks a tie, and a close second is listed", () => {
  assert.deepEqual(
    names("The Danvers front desk is unstaffed; who covers check-ins?"),
    ["Emery Cole", "Finley Shaw"]
  );
});

test("the block names each match with its reason, within its ceiling", () => {
  const matches = matchContacts(
    DIRECTORY,
    "The Danvers front desk is unstaffed; who covers check-ins?"
  );
  const block = renderContactBlock(DIRECTORY, matches);
  assert.equal(
    block,
    [
      "Team directory match for this message (computed from the team directory; see hard rule 17):",
      '1. Emery Cole, Front Desk (Danvers) (Operations). Owns "Front-desk check-ins".',
      '2. Finley Shaw, New Clinics (Danvers) (Operations). Owns "Front-desk check-in training".'
    ].join("\n")
  );
  const long = renderContactBlock(DIRECTORY, [
    { ...matches[0], owns: "x ".repeat(400) },
    { ...matches[1], owns: "y ".repeat(400) }
  ]);
  assert.ok(long.length <= CONTACT_BLOCK_MAX_CHARS, String(long.length));
  assert.match(long, /…"\./);
});

test("an Out of scope line costs in proportion to how much of it the message covers", () => {
  // The revenue lead's own line shares one word ("insurance") of four with
  // the message; the other entry's redirect covers it fully. Without the
  // scaling, the insurance specialist would come first.
  const dir: Directory = {
    ...DIRECTORY,
    personas: [
      persona({
        name: "Gray Hale",
        title: "Revenue Lead",
        routingDepartments: ["RCM"],
        owns: ["Claims setup"],
        outOfScope: [
          {
            topic: "Member-facing outreach for insurance details",
            targets: ["Avery"]
          }
        ]
      }),
      persona({
        name: "Harper Moss",
        title: "Navigator",
        owns: ["Care navigation huddles"],
        outOfScope: [{ topic: "Insurance eligibility", targets: ["RCM"] }]
      }),
      persona({
        name: "Ivy Stone",
        title: "Insurance SME",
        owns: ["Insurance rules"]
      }),
      persona({
        name: "Avery Quinn",
        title: "Intake Lead",
        owns: ["Referral intake"]
      })
    ]
  };
  assert.deepEqual(
    matchContacts(dir, "Insurance eligibility came back inactive").map(
      (m) => m.persona.name
    ),
    ["Gray Hale", "Ivy Stone"]
  );
});

test("the block carries the reach and backup, so the answer copies them", () => {
  // Live eval: without them beside the name, the model wrote "contact his
  // Backup" instead of the backup itself.
  const block = renderContactBlock(DIRECTORY, [
    {
      persona: persona({
        name: "Casey Lin",
        title: "Billing Lead",
        department: "Finance",
        backup: "Revenue lead",
        reach: { slack: "#fictional-billing (unverified)", dashboard: "" }
      }),
      score: 2,
      owns: "Copay-process questions",
      routeWhen: null,
      redirect: null
    }
  ]);
  assert.equal(
    block.split("\n")[1],
    '1. Casey Lin, Billing Lead (Finance). Reach: Slack #fictional-billing. Backup: Revenue lead. Owns "Copay-process questions".'
  );
});

test("a Route When clause picks the row and is given as the reason", () => {
  const dir: Directory = {
    ...DIRECTORY,
    personas: [
      ...DIRECTORY.personas,
      persona({
        name: "Gray Hale",
        title: "Provider",
        department: "Clinical",
        owns: ["Patient visits"],
        routeWhen: "Medication management protocol changes only; dosing policy"
      })
    ]
  };
  const matches = matchContacts(
    dir,
    "We need to change the medication management protocol"
  );
  assert.deepEqual(
    matches.map((m) => m.persona.name),
    ["Gray Hale"]
  );
  assert.equal(matches[0].owns, null);
  assert.equal(
    matches[0].routeWhen,
    "Medication management protocol changes only"
  );
  assert.equal(
    renderContactBlock(dir, matches).split("\n")[1],
    '1. Gray Hale, Provider (Clinical). Route when "Medication management protocol changes only".'
  );
});

test("a directory name inside Route When never scores", () => {
  const dir: Directory = {
    ...DIRECTORY,
    personas: [
      ...DIRECTORY.personas,
      persona({
        name: "Gray Hale",
        title: "Coordinator",
        owns: ["Room setup"],
        routeWhen: "Clinic meetings with Avery"
      })
    ]
  };
  assert.deepEqual(matchContacts(dir, "Should this go to Avery?"), []);
});

test("words about how work moves never pick a row on their own", () => {
  const dir: Directory = {
    ...DIRECTORY,
    personas: [
      ...DIRECTORY.personas,
      persona({
        name: "Gray Hale",
        title: "Leadership",
        owns: ["Strategy"],
        routeWhen:
          "Cross-clinic decisions only; escalation when the specific person listed above can't resolve"
      })
    ]
  };
  for (const text of [
    "This needs escalation, the family is upset",
    "Nobody can resolve this"
  ]) {
    assert.deepEqual(matchContacts(dir, text), [], text);
  }
  assert.deepEqual(
    matchContacts(dir, "A cross-clinic decision about opening hours").map(
      (m) => m.persona.name
    ),
    ["Gray Hale"]
  );
});

test("no directory means no block at all", () => {
  assert.deepEqual(matchContacts(null, "copay"), []);
  assert.equal(renderContactBlock(null, []), "");
  assert.deepEqual(
    contactBlockFor(null, [{ role: "user", content: "copay" }]),
    {
      block: "",
      matches: 0,
      top: 0
    }
  );
});

test("a short follow-up is matched with the turn before it", () => {
  const turns = [
    { role: "user", content: "We got a new referral by fax." },
    { role: "assistant", content: "Start the intake." },
    { role: "user", content: "Who owns it?" }
  ];
  assert.equal(
    contactQuery(turns),
    "We got a new referral by fax.\nWho owns it?"
  );
  const result = contactBlockFor(DIRECTORY, turns);
  assert.equal(result.matches, 1);
  assert.match(result.block, /1\. Avery Quinn, Intake Lead/);
  assert.equal(
    contactQuery([
      { role: "user", content: "old topic" },
      {
        role: "user",
        content:
          "Who handles the copay billing configuration change for Danvers?"
      }
    ]),
    "Who handles the copay billing configuration change for Danvers?"
  );
});
