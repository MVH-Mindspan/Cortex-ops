import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { GUIDE_EXAMPLES, ONBOARDING_COPY } from "./copy.ts";
import { checkPHI, checkPossiblePII } from "./phi.ts";
import {
  guidePrompt,
  guideSeen,
  markGuideSeen,
  splitAnswerSections,
  toGuideMessages,
  type GuideExample
} from "./guide.ts";

test("the guide ships three examples that each start with a prompt", () => {
  assert.equal(GUIDE_EXAMPLES.length, 3);
  for (const example of GUIDE_EXAMPLES) {
    assert.equal(example.turns[0]?.role, "user", example.id);
    assert.ok(guidePrompt(example).length > 20, example.id);
    assert.ok(
      example.turns.some((t) => t.role === "assistant"),
      example.id
    );
  }
});

test("every example prompt passes the identifier screen", () => {
  for (const example of GUIDE_EXAMPLES) {
    for (const turn of example.turns) {
      if (turn.role !== "user") continue;
      assert.equal(checkPHI(turn.text).blocked, false, turn.text);
      assert.equal(checkPossiblePII(turn.text), null, turn.text);
    }
  }
});

// Matched on the Notion page id rather than the title or key: both change
// when an SOP is reviewed and renamed, and the sync workflow commits the new
// manifest straight to main, so a title match would turn main red from a bot
// commit. The page id survives a rename.
test("example SOP cards point at pages in the exported manifest", () => {
  const manifest = JSON.parse(
    readFileSync(
      new URL("../../scripts/sops-manifest.json", import.meta.url),
      "utf8"
    )
  ) as { files: { notion_id: string }[] };
  const ids = new Set(manifest.files.map((f) => f.notion_id.replace(/-/g, "")));
  let cards = 0;
  for (const example of GUIDE_EXAMPLES) {
    for (const turn of example.turns) {
      if (turn.role !== "assistant" || !turn.sops) continue;
      for (const sop of turn.sops) {
        cards++;
        const id = sop.source_url?.match(/([0-9a-f]{32})$/)?.[1];
        assert.ok(id && ids.has(id), `${example.id}: ${sop.title}`);
      }
    }
  }
  assert.ok(cards >= 3);
});

test("the examples cover a cited answer and a no-coverage answer", () => {
  const assistant = GUIDE_EXAMPLES.flatMap((e) =>
    e.turns.filter((t) => t.role === "assistant")
  );
  assert.ok(
    assistant.some((t) => t.sops?.some((s) => s.cited === true)),
    "one example should show a Cited card"
  );
  assert.ok(
    assistant.some((t) => t.coverageBlocked === "none"),
    "one example should show the Related SOPs path"
  );
});

test("toGuideMessages builds the message shape the answer components read", () => {
  const example: GuideExample = {
    id: "x",
    label: "X",
    turns: [
      { role: "user", text: "First" },
      {
        role: "assistant",
        text: "Answer",
        sops: [
          {
            title: "SOP",
            category: "c",
            last_edited: null,
            source_url: null,
            score: 1
          }
        ]
      },
      { role: "user", text: "Second" },
      { role: "assistant", text: "Nothing", coverageBlocked: "none" }
    ]
  };
  const messages = toGuideMessages(example);
  assert.deepEqual(
    messages.map((m) => m.id),
    ["guide-x-0", "guide-x-1", "guide-x-2", "guide-x-3"]
  );
  assert.deepEqual(
    messages.map((m) => m.role),
    ["user", "assistant", "user", "assistant"]
  );
  assert.deepEqual(messages[0].parts, [{ type: "text", text: "First" }]);
  assert.equal(messages[1].parts[0].type, "data-sops");
  assert.equal(messages[1].metadata, undefined);
  assert.equal(
    messages[3].parts.some((p) => p.type === "data-sops"),
    false
  );
  assert.deepEqual(messages[3].metadata, {
    coverage: "none",
    coverageBlocked: "none"
  });
});

test("the seen flag is a boolean in localStorage and fails closed", (t) => {
  const store = new Map<string, string>();
  const fake = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v);
    }
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: fake,
    configurable: true,
    writable: true
  });
  t.after(() => {
    Reflect.deleteProperty(globalThis, "localStorage");
  });
  assert.equal(guideSeen(), false);
  markGuideSeen();
  assert.equal(guideSeen(), true);
  assert.equal(store.get("cortex-guide-seen"), "1");
  markGuideSeen();
  assert.equal(store.get("cortex-guide-seen"), "1");

  // Storage throwing (private mode, locked-down browser): read as seen so the
  // app never boots into the guide on every visit.
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      }
    },
    configurable: true,
    writable: true
  });
  assert.equal(guideSeen(), true);
  assert.doesNotThrow(() => markGuideSeen());
});

test("splitAnswerSections keeps inline and block headings apart", () => {
  const text = [
    "",
    "Situation: A caller is waiting.",
    "",
    "Urgency: Now. Someone is on the phone.",
    "",
    "Do now",
    "1. Pick up. Expect to see a name.",
    "2. Ask for the chart number.",
    "",
    "Tell the patient",
    '"One moment."',
    "",
    "Not covered by the SOPs",
    "- Nothing."
  ].join("\n");
  assert.deepEqual(splitAnswerSections(text), [
    { heading: "Situation", body: "A caller is waiting." },
    { heading: "Urgency", body: "Now. Someone is on the phone." },
    {
      heading: "Do now",
      body: "1. Pick up. Expect to see a name.\n2. Ask for the chart number."
    },
    { heading: "Tell the patient", body: '"One moment."' },
    { heading: "Not covered by the SOPs", body: "- Nothing." }
  ]);
  assert.deepEqual(splitAnswerSections("no headings here"), []);
});

test("every heading in the example answers has a meaning on the shape screen", () => {
  const known = new Set(ONBOARDING_COPY.sections.map((s) => s.heading));
  let headings = 0;
  for (const example of GUIDE_EXAMPLES) {
    for (const turn of example.turns) {
      if (turn.role !== "assistant") continue;
      for (const section of splitAnswerSections(turn.text)) {
        headings++;
        assert.ok(
          known.has(section.heading),
          `${example.id}: ${section.heading}`
        );
      }
    }
  }
  assert.ok(headings >= 10);
  // The shape screen lights up "Do now" first, so that example must have it.
  const phone = GUIDE_EXAMPLES.find((e) => e.id === "on-the-phone");
  const first = phone?.turns.find((t) => t.role === "assistant");
  assert.ok(
    first && splitAnswerSections(first.text).some((s) => s.heading === "Do now")
  );
  // The follow-up screen shows these sections from its two answers.
  const follow = GUIDE_EXAMPLES.find((e) => e.id === "follow-up");
  const answers = follow?.turns.filter((t) => t.role === "assistant") ?? [];
  assert.ok(
    splitAnswerSections(answers[0].text).some((s) => s.heading === "Answer")
  );
  assert.ok(
    splitAnswerSections(answers[1].text).some((s) => s.heading === "Do now")
  );
});
