import { test } from "node:test";
import assert from "node:assert/strict";
import type { Persona } from "../src/lib/personas.ts";
import type { RoutingDepartment } from "./persona-parse.ts";
import {
  checkDirectory,
  departmentsNamedIn,
  formatIssues,
  redactNames,
  topicWords,
  topicsOverlap,
  withFullBackups
} from "./routing-check.ts";

// Fictional people and departments only: this repository is public.
const DEPARTMENTS: RoutingDepartment[] = [
  {
    name: "Coordination",
    aliases: ["coordinator"],
    exclusions: [
      { topic: "Insurance eligibility questions", target: "Revenue" },
      { topic: "Caregiver attendance confirmation", target: "Liaison" },
      {
        topic: "Anything a person is meant to action",
        target: "see the owning team"
      }
    ]
  },
  {
    name: "Revenue",
    aliases: ["billing"],
    exclusions: [{ topic: "Clinical questions", target: "Clinic" }]
  },
  { name: "Liaison", aliases: [], exclusions: [] },
  { name: "Member Experience (MX)", aliases: ["MX"], exclusions: [] },
  { name: "Clinic", aliases: ["nurse"], exclusions: [] }
];

function persona(overrides: Partial<Persona>): Persona {
  return {
    name: "Avery Quinn",
    title: "Navigation Lead",
    department: "Clinical",
    routeWhen: "",
    routingDepartments: ["Coordination"],
    priority: "P0",
    owns: ["Care navigation huddles"],
    systems: [],
    outOfScope: [],
    backup: "",
    escalatesTo: "",
    reach: { slack: "", dashboard: "" },
    ...overrides
  };
}

const NAMES = /Avery|Quinn|Blake|Rowe|Casey|Drew|Emery/;

test("topic words keep hyphenated compounds whole and drop filler", () => {
  assert.deepEqual(
    [...topicWords("Own non-clinical operations")],
    ["non-clinical", "operation"]
  );
  assert.deepEqual([...topicWords("Clinical questions")], ["clinical"]);
  assert.ok(
    topicsOverlap(
      "Clinical questions",
      "Clinical questions (Clinical or Provider)"
    )
  );
  assert.ok(
    topicsOverlap(
      "Insurance eligibility",
      "Insurance eligibility work after the lead exists"
    )
  );
  assert.ok(
    !topicsOverlap("Own non-clinical operations", "Clinical questions")
  );
  assert.ok(
    !topicsOverlap(
      "Clinical incidents and huddles",
      "Insurance eligibility questions"
    )
  );
});

test("departments are found by name, by name without its parenthetical, and by alias", () => {
  assert.deepEqual(departmentsNamedIn("Revenue escalates to MX", DEPARTMENTS), [
    "Revenue",
    "Member Experience (MX)"
  ]);
  assert.deepEqual(
    departmentsNamedIn("the Member Experience team", DEPARTMENTS),
    ["Member Experience (MX)"]
  );
  assert.deepEqual(departmentsNamedIn("Billing lead", DEPARTMENTS), [
    "Revenue"
  ]);
  assert.deepEqual(departmentsNamedIn("Revenuecycle", DEPARTMENTS), []);
});

test("rows missing a field are errors and left out; a shared name is fine", () => {
  const result = checkDirectory(
    [
      persona({ name: "Avery Quinn", title: "Lead A" }),
      persona({ name: "Avery Quinn", title: "Lead B" }),
      persona({ name: "Blake Rowe", title: "", owns: [] }),
      persona({ name: "Casey Lin", title: "Lead C", backup: "Avery Quinn" })
    ],
    DEPARTMENTS
  );
  const errors = result.issues.filter((i) => i.level === "error");
  assert.deepEqual(
    errors.map((i) => i.row),
    ["untitled row (Clinical)"]
  );
  assert.match(errors[0].message, /no Title, Core Responsibilities/);
  assert.deepEqual(
    result.valid.map((p) => p.title),
    ["Lead A", "Lead B", "Lead C"]
  );
  // A reference to the shared name resolves (to both rows).
  assert.ok(!result.issues.some((i) => i.level === "reference"));
  assert.equal(result.blocked, null);
});

test("references that resolve to nothing, or back to the same person, are reported", () => {
  const result = checkDirectory(
    [
      persona({
        backup: "Dr. Nobody",
        routingDepartments: ["Coordination", "Nowhere"],
        outOfScope: [
          { topic: "Insurance eligibility", targets: ["Revenue"] },
          { topic: "Caregiver attendance", targets: ["Liaison"] },
          { topic: "Parking", targets: ["Facilities Crew"] },
          { topic: "Huddles", targets: ["Avery"] }
        ]
      }),
      persona({
        name: "Blake Rowe",
        title: "Revenue Lead",
        routingDepartments: ["Revenue"],
        backup: "Avery (weekdays only)",
        outOfScope: [{ topic: "Clinical questions", targets: ["Clinic"] }]
      })
    ],
    DEPARTMENTS
  );
  const references = result.issues.filter((i) => i.level === "reference");
  assert.equal(references.length, 4, JSON.stringify(references));
  assert.ok(references.every((i) => i.row === "Navigation Lead (Clinical)"));
  assert.ok(references.some((i) => /^Backup matches no one/.test(i.message)));
  assert.ok(
    references.some((i) => /"Parking" routes to no one/.test(i.message))
  );
  // An unresolved value may name someone outside the directory, so it is
  // never quoted.
  for (const issue of references) {
    assert.doesNotMatch(issue.message, /Nobody|Facilities Crew/);
  }
  assert.ok(
    references.some((i) => /routes back to the same person/.test(i.message))
  );
  assert.ok(
    references.some((i) => /Routing Department "Nowhere"/.test(i.message))
  );
});

test("conflicts are found in both directions", () => {
  const result = checkDirectory(
    [
      persona({
        owns: ["Insurance eligibility checks for new members"],
        outOfScope: [
          { topic: "Insurance eligibility", targets: ["Revenue"] },
          { topic: "Caregiver attendance", targets: ["Liaison"] }
        ]
      }),
      persona({
        name: "Blake Rowe",
        title: "Revenue Lead",
        department: "Finance",
        routingDepartments: ["Revenue"],
        outOfScope: [{ topic: "Clinical questions", targets: ["Clinic"] }]
      }),
      persona({
        name: "Casey Lin",
        title: "Front Desk",
        department: "Operations",
        routingDepartments: [],
        outOfScope: [{ topic: "Clinical questions", targets: ["Blake"] }]
      })
    ],
    DEPARTMENTS
  );
  const conflicts = result.issues.filter((i) => i.level === "conflict");
  assert.equal(conflicts.length, 1, JSON.stringify(result.issues));
  assert.equal(conflicts[0].row, "Navigation Lead (Clinical)");
  assert.match(
    conflicts[0].message,
    /owns "Insurance eligibility checks for new members", but Coordination excludes/
  );
  // The front desk has no routing department, so only a note, no cross-check.
  assert.ok(
    result.issues.some(
      (i) => i.level === "note" && i.row === "Front Desk (Operations)"
    )
  );
  // Give the front desk a department and its redirect to Revenue is a conflict.
  const second = checkDirectory(
    [
      persona({
        name: "Blake Rowe",
        title: "Revenue Lead",
        department: "Finance",
        routingDepartments: ["Revenue"],
        outOfScope: [{ topic: "Clinical questions", targets: ["Clinic"] }]
      }),
      persona({
        name: "Casey Lin",
        title: "Front Desk",
        department: "Operations",
        routingDepartments: ["Liaison"],
        outOfScope: [{ topic: "Clinical questions", targets: ["Blake"] }]
      })
    ],
    DEPARTMENTS
  );
  const redirect = second.issues.filter((i) => i.level === "conflict");
  assert.equal(redirect.length, 1, JSON.stringify(second.issues));
  assert.match(
    redirect[0].message,
    /sends "Clinical questions" to Revenue Lead \(Finance\), but Revenue excludes "Clinical questions" \(Clinic\)/
  );
});

test("gaps: an exclusion the persona never sends on, by topic or by target", () => {
  const result = checkDirectory(
    [
      persona({
        outOfScope: [
          // Covered by target: Blake sits in Revenue.
          { topic: "Coverage checks", targets: ["Blake"] }
        ]
      }),
      persona({
        name: "Blake Rowe",
        title: "Revenue Lead",
        routingDepartments: ["Revenue"],
        outOfScope: [{ topic: "Clinical questions", targets: [] }]
      })
    ],
    DEPARTMENTS
  );
  const gaps = result.issues.filter((i) => i.level === "gap");
  assert.deepEqual(
    gaps.map((i) => [i.row, i.message]),
    [
      [
        "Navigation Lead (Clinical)",
        'Coordination excludes "Caregiver attendance confirmation" (Liaison), but Out of Scope never sends it on'
      ]
    ]
  );
});

test("messages never carry a directory name", () => {
  const result = checkDirectory(
    [
      persona({
        owns: ["Insurance eligibility for Blake Rowe and Drew"],
        backup: "Emery",
        outOfScope: [{ topic: "Huddles with Avery", targets: ["Avery Quinn"] }]
      }),
      persona({
        name: "Blake Rowe",
        title: "Revenue Lead",
        routingDepartments: ["Revenue"]
      }),
      persona({ name: "Drew", title: "Desk", routingDepartments: [] })
    ],
    DEPARTMENTS
  );
  assert.ok(result.issues.length > 3);
  for (const issue of result.issues) {
    assert.doesNotMatch(`${issue.row} ${issue.message}`, NAMES, issue.message);
  }
  for (const line of formatIssues(result))
    assert.doesNotMatch(line, NAMES, line);
  assert.equal(
    redactNames("Ask Avery Quinn or Avery", ["Avery", "Avery Quinn"]),
    "Ask <person> or <person>"
  );
});

test("blocks the upload when nothing is usable or the directory is over the ceiling", () => {
  assert.equal(checkDirectory([], DEPARTMENTS).blocked, "no usable Live rows");
  const result = checkDirectory([persona({})], DEPARTMENTS, 20);
  assert.match(result.blocked ?? "", /over the 20 ceiling/);
  assert.ok(result.renderedChars > 20);
});

test("without the routing map only the row and reference checks run", () => {
  const result = checkDirectory(
    [persona({ routingDepartments: ["Anything"], backup: "Nobody" })],
    []
  );
  assert.deepEqual(
    result.issues.map((i) => i.level),
    ["reference"]
  );
});

test("a Backup naming one person by a shorter name becomes their full name", () => {
  const people = [
    persona({ name: "Avery Quinn", backup: "Blake" }),
    persona({
      name: "Blake Rowe",
      title: "Revenue Lead",
      backup: "Casey (weekdays only)"
    }),
    persona({ name: "Casey Lin", title: "Desk", backup: "Revenue lead" }),
    persona({ name: "Dr. Drew", title: "Provider", backup: "Emery" }),
    persona({
      name: "Emery Cole",
      title: "Front Desk",
      backup: "Dr. Drew (medication only)"
    }),
    persona({ name: "Emery Park", title: "Nurse", backup: "Emery Park" })
  ];
  const expanded = withFullBackups(people);
  assert.deepEqual(
    expanded.map((p) => p.backup),
    [
      "Blake Rowe",
      "Casey Lin (weekdays only)",
      // Names no one: left as written, and still reported.
      "Revenue lead",
      // Two people are called Emery: ambiguous, so left as written.
      "Emery",
      // Already the full name.
      "Dr. Drew (medication only)",
      // The row itself.
      "Emery Park"
    ]
  );
  assert.equal(expanded[2], people[2]);
  assert.equal(people[0].backup, "Blake");
});

test("formatIssues lists a counts line, then the most severe first", () => {
  const lines = formatIssues(
    checkDirectory(
      [
        persona({ title: "Lead A", owns: [] }),
        persona({ title: "Lead B", owns: [] }),
        persona({ name: "Blake Rowe", title: "Lead C", routingDepartments: [] })
      ],
      DEPARTMENTS
    )
  );
  assert.match(
    lines[0],
    // Rows left out are still cross-checked, so their fixes show on one run:
    // Lead A and Lead B each miss two of Coordination's exclusions.
    /^1 persona\(s\) usable, \d+ characters rendered; 2 error, 0 reference, 0 conflict, 4 gap, 1 note\.$/
  );
  assert.ok(lines[1].startsWith("error: Lead A"));
  assert.ok(lines.at(-1)?.startsWith("note: Lead C"));
});
