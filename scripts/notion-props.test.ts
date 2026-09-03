import { test } from "node:test";
import assert from "node:assert/strict";
import {
  categoriesOf,
  ownerOf,
  primaryCategory,
  statusOf,
  titleOf,
  UNTITLED,
  useWhenOf,
  type Props
} from "./notion-props.ts";

// Minimal property shapes cast once; only the discriminants under test matter.
const props = (overrides: Record<string, unknown>): Props =>
  overrides as unknown as Props;
const text = (t: string) => ({ plain_text: t });

test("titleOf joins runs, collapses whitespace, falls back to Untitled", () => {
  assert.equal(
    titleOf(
      props({ "Doc name": { type: "title", title: [text("Long Beach\n•")] } })
    ),
    "Long Beach •"
  );
  assert.equal(
    titleOf(props({ "Doc name": { type: "title", title: [] } })),
    UNTITLED
  );
  assert.equal(
    titleOf(props({ "Doc name": { type: "title", title: [text("   \n ")] } })),
    UNTITLED
  );
});
test("statusOf reads select, status, and missing", () => {
  assert.equal(
    statusOf(
      props({
        Status: { type: "select", select: { name: "Draft — Needs Review" } }
      })
    ),
    "Draft — Needs Review"
  );
  assert.equal(
    statusOf(
      props({ Status: { type: "status", status: { name: "In Review" } } })
    ),
    "In Review"
  );
  assert.equal(
    statusOf(props({ Status: { type: "select", select: null } })),
    ""
  );
  assert.equal(statusOf(props({ Status: { type: "rollup" } })), "");
  assert.equal(statusOf(props({})), "");
});
test("categoriesOf keeps multi_select order and accepts a legacy select", () => {
  assert.deepEqual(
    categoriesOf(
      props({
        Category: {
          type: "multi_select",
          multi_select: [{ name: "Care Support" }, { name: "SOP" }]
        }
      })
    ),
    ["Care Support", "SOP"]
  );
  assert.deepEqual(
    categoriesOf(
      props({ Category: { type: "select", select: { name: "SOP" } } })
    ),
    ["SOP"]
  );
  assert.deepEqual(
    categoriesOf(props({ Category: { type: "rich_text" } })),
    []
  );
  assert.deepEqual(categoriesOf(props({})), []);
});
test("primaryCategory follows the fixed priority, then the first tag, then uncategorized", () => {
  assert.equal(primaryCategory(["Care Support", "SOP"]), "SOP");
  assert.equal(primaryCategory(["Care Support", "Reference"]), "Reference");
  assert.equal(primaryCategory(["Planning"]), "Planning");
  assert.equal(primaryCategory([]), "uncategorized");
});
test("useWhenOf joins rich_text runs and collapses whitespace", () => {
  assert.equal(
    useWhenOf(
      props({
        "Use When (Agent Hints)": {
          type: "rich_text",
          rich_text: [text("Consult BEFORE\nsending "), text(" any order")]
        }
      })
    ),
    "Consult BEFORE sending any order"
  );
  assert.equal(useWhenOf(props({})), "");
});
test("ownerOf joins people names", () => {
  assert.equal(
    ownerOf(
      props({
        Owner: {
          type: "people",
          people: [{ name: "A" }, { object: "user", id: "x" }, { name: "B" }]
        }
      })
    ),
    "A, B"
  );
  assert.equal(ownerOf(props({})), "");
});
