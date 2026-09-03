import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPassages,
  buildUserBlock,
  classifyPipelineError,
  isTruncated,
  MAX_OUTPUT_TOKENS,
  MAX_SOPS,
  rankSops,
  sectionOf,
  stripFrontmatter,
  textOf,
  trimHistory,
  windows,
  type FileMeta,
  type SearchChunk,
  type SearchResponse,
  type Turn
} from "./pipeline.ts";

const meta = new Map<string, FileMeta>([
  [
    "a.md",
    {
      title: "Alpha SOP",
      category: "ops",
      last_edited: null,
      source_url: "https://n/a",
      status: null,
      use_when: null,
      text: "# Alpha\nStep one.\nStep two."
    }
  ],
  [
    "b.md",
    {
      title: "Beta SOP",
      category: "ops",
      last_edited: null,
      source_url: null,
      status: null,
      use_when: null,
      text: "Beta body"
    }
  ]
]);

// Two more SOPs, one still in draft and one approved. Kept out of `meta` on
// purpose: the buildPassages tests below rely on c.md having no metadata.
const metaWithDraft = new Map(meta)
  .set("c.md", {
    title: "Gamma SOP",
    category: "ops",
    last_edited: null,
    source_url: null,
    status: "draft",
    use_when: "gamma question, gamma form",
    text: "Gamma body"
  })
  .set("d.md", {
    title: "Delta SOP",
    category: "ops",
    last_edited: null,
    source_url: null,
    status: "approved",
    use_when: null,
    text: "Delta body"
  });

const chunk = (key: string, score: number, text = "chunk"): SearchChunk => ({
  score,
  text,
  item: { key }
});

// One chunk, no full documents: the single passage produced is exactly what
// buildPassages did with that chunk's text, for the frontmatter-stripping
// tests below.
function onlyPassage(text: string): string {
  const chunks = [chunk("a.md", 0.9, text)];
  const { passages } = buildPassages(rankSops(chunks, meta), chunks, meta, {
    fullDocCount: 0,
    charBudget: 30_000
  });
  return passages[0];
}

test("textOf joins the text parts with newlines and trims", () => {
  assert.equal(
    textOf({
      parts: [
        { type: "text", text: " hi " },
        { type: "step-start" },
        { type: "text", text: "there" }
      ]
    }),
    "hi \nthere"
  );
});

test("sectionOf returns the first markdown heading, if any", () => {
  assert.equal(
    sectionOf("intro\n## 5. If Insurance Is Missing\nbody"),
    "5. If Insurance Is Missing"
  );
  assert.equal(sectionOf("no heading here"), null);
});

test("rankSops dedupes chunks per file, keeps the best score, sorts descending", () => {
  const ranked = rankSops(
    [
      chunk("a.md", 0.2),
      chunk("b.md", 0.9),
      chunk("a.md", 0.5),
      { score: 0.99 }
    ],
    meta
  );
  assert.deepEqual(
    ranked.map((s) => [s.file, s.score]),
    [
      ["b.md", 0.9],
      ["a.md", 0.5]
    ]
  );
  assert.equal(ranked[0].title, "Beta SOP");
  assert.equal(ranked[1].source_url, "https://n/a");
});

test("rankSops carries the SOP status and omits the key when there is none", () => {
  const ranked = rankSops(
    [chunk("c.md", 0.9), chunk("d.md", 0.7), chunk("a.md", 0.5)],
    metaWithDraft
  );
  assert.equal(ranked[0].file, "c.md");
  assert.equal(ranked[0].status, "draft");
  assert.equal(ranked[1].file, "d.md");
  assert.equal(ranked[1].status, "approved");
  const ref = ranked[2];
  assert.equal(ref.file, "a.md");
  assert.equal(Object.hasOwn(ref, "status"), false);
});

test("rankSops caps the list at MAX_SOPS", () => {
  const chunks = Array.from({ length: 7 }, (_, i) => chunk(`f${i}.md`, i / 10));
  assert.equal(rankSops(chunks, meta).length, MAX_SOPS);
});

test("buildPassages: top files as full documents, then remaining chunks, continuous labels", () => {
  const chunks = [
    chunk("a.md", 0.9, "## Alpha chunk"),
    chunk("b.md", 0.5, "Beta chunk text"),
    chunk("c.md", 0.1, "## Gamma\nOrphan chunk")
  ];
  const ranked = rankSops(chunks, meta);
  const { passages, used } = buildPassages(ranked, chunks, meta, {
    fullDocCount: 1,
    charBudget: 30_000
  });
  assert.equal(passages.length, 3);
  assert.match(
    passages[0],
    /^\[1\] Alpha SOP \| full document \| https:\/\/n\/a\n# Alpha\nStep one\.\nStep two\.$/
  );
  assert.equal(passages[1], "[2] Beta SOP | no link\nBeta chunk text");
  assert.equal(
    passages[2],
    "[3] Untitled SOP | Gamma | no link\n## Gamma\nOrphan chunk"
  );
  assert.equal(
    used,
    "# Alpha\nStep one.\nStep two.".length +
      "Beta chunk text".length +
      "## Gamma\nOrphan chunk".length
  );
});

test("buildPassages never repeats a full-document file as a chunk", () => {
  const chunks = [
    chunk("a.md", 0.9, "## Alpha chunk"),
    chunk("a.md", 0.4, "more alpha")
  ];
  const { passages } = buildPassages(rankSops(chunks, meta), chunks, meta, {
    fullDocCount: 3,
    charBudget: 30_000
  });
  assert.equal(passages.length, 1);
  assert.match(passages[0], /^\[1\] Alpha SOP \| full document/);
});

test("buildPassages stops adding passages at the character budget", () => {
  const chunks = [
    chunk("a.md", 0.9, "## Alpha chunk"),
    chunk("b.md", 0.5, "Beta chunk text"),
    chunk("c.md", 0.1, "## Gamma\nOrphan chunk")
  ];
  const { passages } = buildPassages(rankSops(chunks, meta), chunks, meta, {
    fullDocCount: 1,
    charBudget: 20
  });
  // The 26-char full document does not fit; the first 14-char chunk does; the next would overflow.
  assert.deepEqual(passages, [
    "[1] Alpha SOP | Alpha chunk | https://n/a\n## Alpha chunk"
  ]);
});

test("stripFrontmatter removes a leading frontmatter block", () => {
  assert.equal(
    stripFrontmatter(
      "---\ntitle: X\nsource_url: https://u\nstatus: Draft\n---\n## Heading\nbody"
    ),
    "## Heading\nbody"
  );
});

test("stripFrontmatter leaves a chunk that starts on a Notion divider alone", () => {
  const text =
    "---\n\n## Step 3\nCall the payer.\n\n---\n\n## Step 4\nFile it.";
  assert.equal(stripFrontmatter(text), text);
});

test("buildPassages strips a leading frontmatter block from chunk text", () => {
  const passage = onlyPassage(
    "---\ntitle: X\nsource_url: https://u\nstatus: Draft\n---\n## Heading\nbody"
  );
  assert.equal(
    passage,
    "[1] Alpha SOP | Heading | https://n/a\n## Heading\nbody"
  );
  assert.ok(!passage.includes("source_url:"));
});

test("buildPassages strips a CRLF frontmatter block from chunk text", () => {
  assert.equal(
    onlyPassage("---\r\ntitle: X\r\n---\r\nbody"),
    "[1] Alpha SOP | https://n/a\nbody"
  );
});

test("buildPassages leaves a chunk that merely contains a markdown rule untouched", () => {
  assert.equal(
    onlyPassage("intro\n\n---\n\nmore"),
    "[1] Alpha SOP | https://n/a\nintro\n\n---\n\nmore"
  );
});

test("buildUserBlock assembles the request exactly as the Worker did", () => {
  assert.equal(
    buildUserBlock(["[1] A | full document | u\nbody"], "msg"),
    "SOP passages\n\n[1] A | full document | u\nbody\n\nTeam member's message:\n\nmsg"
  );
  assert.equal(
    buildUserBlock(["p1", "p2"], "msg"),
    "SOP passages\n\np1\n\np2\n\nTeam member's message:\n\nmsg"
  );
});

test("SearchResponse types the search query and chunks, including optional per-chunk scoring_details", () => {
  const r: SearchResponse = { search_query: "q", chunks: [] };
  assert.equal(r.chunks.length, 0);
  const scored: SearchResponse = {
    search_query: "q",
    chunks: [{ scoring_details: { reranking_score: 0.5, keyword_rank: 1 } }]
  };
  assert.equal(scored.chunks[0].scoring_details?.reranking_score, 0.5);
});

test("trimHistory keeps the latest turn and drops the oldest turns past the char budget", () => {
  const turns: Turn[] = [
    { role: "user", content: "x".repeat(50) },
    { role: "assistant", content: "y".repeat(50) },
    { role: "user", content: "z".repeat(50) },
    { role: "assistant", content: "w".repeat(50) },
    { role: "user", content: "latest" }
  ];
  const out = trimHistory(turns, { maxMessages: 12, charBudget: 120 });
  assert.deepEqual(
    out.map((t) => t.content[0]),
    ["z", "w", "l"]
  );
});

test("trimHistory drops empty and notice turns before counting", () => {
  const turns: Turn[] = [
    { role: "user", content: "a" },
    { role: "assistant", content: "" },
    {
      role: "assistant",
      content: "Cortex is briefly rate limited.",
      notice: true
    },
    { role: "user", content: "b" }
  ];
  assert.deepEqual(
    trimHistory(turns).map((t) => t.content),
    ["a", "b"]
  );
});

test("trimHistory enforces the message count cap including the latest turn", () => {
  const turns: Turn[] = Array.from({ length: 15 }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: `m${i}`
  }));
  assert.deepEqual(
    trimHistory(turns, { maxMessages: 4, charBudget: 20_000 }).map(
      (t) => t.content
    ),
    ["m11", "m12", "m13", "m14"]
  );
});

test("trimHistory never drops the latest turn even when it alone exceeds the budget", () => {
  const turns: Turn[] = [{ role: "user", content: "q".repeat(100) }];
  assert.equal(
    trimHistory(turns, { maxMessages: 12, charBudget: 10 }).length,
    1
  );
});

test("windows returns the whole text when it fits in one window", () => {
  assert.deepEqual(windows("abc", 5, 1), ["abc"]);
});

test("windows covers the full text with overlap between neighbours", () => {
  assert.deepEqual(windows("abcdefghij", 4, 1), ["abcd", "defg", "ghij"]);
  assert.deepEqual(windows("abcde", 4, 1), ["abcd", "de"]);
});

test("classifyPipelineError maps provider messages to an error kind", () => {
  assert.equal(
    classifyPipelineError(
      "generation",
      "AiError: 5021: exceeded context window limit (24000)"
    ),
    "context-overflow"
  );
  assert.equal(
    classifyPipelineError("generation", "7094: allocation exceeded"),
    "allocation"
  );
  assert.equal(
    classifyPipelineError(
      "generation",
      "AI Gateway: budget exceeded (spend limit)"
    ),
    "spend-limit"
  );
  assert.equal(
    classifyPipelineError("retrieval", "429 rate limit exceeded"),
    "rate-limit"
  );
  assert.equal(classifyPipelineError("retrieval", "boom"), "retrieval");
  assert.equal(classifyPipelineError("generation", "boom"), "generation");
  assert.equal(classifyPipelineError("metadata", "boom"), "retrieval");
});

test("isTruncated uses completion_tokens when the provider reports usage", () => {
  assert.equal(
    isTruncated(
      { completion_tokens: MAX_OUTPUT_TOKENS },
      "…\n\nNot covered by the SOPs\nNothing",
      MAX_OUTPUT_TOKENS
    ),
    true
  );
  assert.equal(
    isTruncated(
      { completion_tokens: 900 },
      "Situation: cut mid",
      MAX_OUTPUT_TOKENS
    ),
    false
  );
});

test("isTruncated falls back to the missing closing section when usage is absent", () => {
  assert.equal(
    isTruncated(
      undefined,
      "Situation: A patient is waiting.\n\nThen\n4. Open the",
      MAX_OUTPUT_TOKENS
    ),
    true
  );
  assert.equal(
    isTruncated(
      undefined,
      "Answer: yes.\n\nNot covered by the SOPs\nNothing",
      MAX_OUTPUT_TOKENS
    ),
    false
  );
  assert.equal(isTruncated(undefined, "", MAX_OUTPUT_TOKENS), false);
});

test("trimHistory keeps at least two prior exchanges of realistic size by default", () => {
  const turns: Turn[] = [];
  for (let i = 0; i < 6; i++) {
    turns.push(
      { role: "user", content: "y".repeat(400) },
      { role: "assistant", content: "x".repeat(3_500) }
    );
  }
  turns.push({ role: "user", content: "latest" });
  const out = trimHistory(turns);
  assert.ok(out.length >= 5, String(out.length));
  assert.equal(out.at(-1)?.content, "latest");
});
