import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DIRECTORY_VERSION,
  parseDirectory,
  renderDirectory,
  renderPersona,
  staffNames,
  type Directory,
  type Persona
} from "./personas.ts";

// Fictional people only: this repository is public and the real directory
// lives in Notion and R2.
function persona(overrides: Partial<Persona> = {}): Persona {
  return {
    name: "Avery Quinn",
    title: "Intake Lead",
    department: "Operations",
    routingDepartments: ["Enrollment"],
    priority: "P1",
    owns: ["New referrals"],
    systems: ["Salesforce"],
    outOfScope: [{ topic: "Clinical questions", targets: ["Blake Rowe"] }],
    backup: "Blake Rowe",
    escalatesTo: "",
    reach: {
      slack: "#fictional-intake",
      dashboard: "Escalate → Member Experience"
    },
    ...overrides
  };
}

function directory(personas: Persona[]): Directory {
  return {
    version: DIRECTORY_VERSION,
    generated_at: "2026-09-14T00:00:00.000Z",
    personas
  };
}

test("renders one persona in the compact template", () => {
  assert.equal(
    renderPersona(persona()),
    [
      "Avery Quinn: Intake Lead (Operations)",
      "- Owns: New referrals",
      "- Systems: Salesforce",
      "- Out of scope: Clinical questions → Blake Rowe",
      "- Backup: Blake Rowe",
      "- Reach: Slack #fictional-intake"
    ].join("\n")
  );
});

test("reach is Slack when there is a Slack route, else the dashboard, never 'unverified'", () => {
  const reach = (slack: string, dashboard: string) =>
    renderPersona(persona({ reach: { slack, dashboard } }))
      .split("\n")
      .find((line) => line.startsWith("- Reach: "));
  assert.equal(
    reach("#fictional-escalations (unverified)", "Escalate → Clinical"),
    "- Reach: Slack #fictional-escalations"
  );
  assert.equal(
    reach("", "Escalate → Clinical (Unverified)"),
    "- Reach: Dashboard Escalate → Clinical"
  );
  assert.equal(reach("", ""), undefined);
});

test("omits empty fields, collapses line breaks, and words a direct message", () => {
  const rendered = renderPersona(
    persona({
      title: "Intake\nLead",
      systems: [],
      outOfScope: [{ topic: "Day-to-day routing", targets: [] }],
      backup: " ",
      escalatesTo: "Morgan (Operations Management)",
      reach: { slack: "Direct message", dashboard: "" }
    })
  );
  assert.equal(
    rendered,
    [
      "Avery Quinn: Intake Lead (Operations)",
      "- Owns: New referrals",
      "- Out of scope: Day-to-day routing",
      "- Escalates to: Morgan (Operations Management)",
      "- Reach: Slack direct message"
    ].join("\n")
  );
});

test("orders P0 first, keeps export order within a tier, and has no trailing newline", () => {
  const rendered = renderDirectory(
    directory([
      persona({ name: "Casey Lin", priority: "P2" }),
      persona({ name: "Drew Park", priority: "P0" }),
      persona({ name: "Avery Quinn", priority: "P1" }),
      persona({ name: "Emery Cole", priority: "P0" })
    ])
  );
  const headers = rendered
    .split("\n")
    .filter((line) => !line.startsWith("- ") && line.length > 0)
    .map((line) => line.split(":")[0]);
  assert.deepEqual(headers, [
    "Drew Park",
    "Emery Cole",
    "Avery Quinn",
    "Casey Lin"
  ]);
  assert.equal(rendered, rendered.trimEnd());
  assert.match(rendered, /\n\nEmery Cole: /);
});

test("over the ceiling, drops whole personas from the lowest tier", () => {
  const dir = directory([
    persona({ name: "Casey Lin", priority: "P2" }),
    persona({ name: "Drew Park", priority: "P0" })
  ]);
  const one = renderPersona(persona({ name: "Drew Park", priority: "P0" }));
  assert.equal(renderDirectory(dir, one.length), one);
  assert.equal(renderDirectory(dir, one.length - 1), "");
  assert.equal(renderDirectory(null), "");
});

test("parseDirectory accepts the exported shape and rejects anything else", () => {
  const good = directory([persona()]);
  assert.deepEqual(parseDirectory(JSON.parse(JSON.stringify(good))), good);
  const bad: unknown[] = [
    null,
    [],
    "text",
    { ...good, version: 2 },
    { ...good, personas: "none" },
    { ...good, generated_at: 1 },
    directory([{ ...persona(), priority: "P9" } as unknown as Persona]),
    directory([{ ...persona(), name: " " }]),
    directory([{ ...persona(), owns: "one" } as unknown as Persona]),
    directory([
      {
        ...persona(),
        outOfScope: [{ topic: "x" }]
      } as unknown as Persona
    ]),
    directory([{ ...persona(), reach: null } as unknown as Persona])
  ];
  for (const value of bad) assert.equal(parseDirectory(value), null);
});

test("staffNames gives full names, plus first names except for doctors", () => {
  assert.deepEqual(
    staffNames(
      directory([
        persona({ name: "Avery Quinn" }),
        persona({ name: "Morgan" }),
        persona({ name: "Dr. Casey Lin" }),
        persona({ name: "Avery  Quinn" })
      ])
    ),
    ["Avery Quinn", "Avery", "Morgan", "Dr. Casey Lin"]
  );
  assert.deepEqual(staffNames(null), []);
});
