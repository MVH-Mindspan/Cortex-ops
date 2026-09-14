import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { GUIDE_COPY, GUIDE_EXAMPLES } from "./copy.ts";
import { checkPHI, checkPossiblePII } from "./phi.ts";
import {
  guidePrompt,
  guideSeen,
  markGuideSeen,
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

test("the guide's prose names every answer heading the prompt produces", () => {
  const glossary = GUIDE_COPY.how.steps.find((s) => s.glossary)?.glossary ?? [];
  const terms = glossary.map((g) => g.term);
  for (const heading of [
    "Who handles this",
    "Do now",
    "Then",
    "Tell the patient",
    "Stop and escalate",
    "Done when",
    "What the SOPs say",
    "Not covered by the SOPs"
  ]) {
    assert.ok(terms.includes(heading), heading);
  }
});
