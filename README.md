# Cortex

**Live preview: https://cortex.mvh-9c9.workers.dev**

Cortex is Mindspan's internal operations assistant. Ops staff paste a situation
(a caregiver call, an insurer email, a misrouted order) and Cortex answers in a
structured incident format grounded only in the team's SOPs, with ranked SOP
cards linking back to their canonical Notion pages. Each answer leads with the
Operations team and function that likely handles the situation, a steer from a
hand-maintained team structure, before the SOP steps.

Built entirely on Cloudflare: Workers + Agents SDK for the chat backend
(Durable Objects for per-conversation state), R2 for the exported SOP library,
AI Search for hybrid retrieval with reranking, and Workers AI
(llama-3.3-70b) for generation, routed through an AI Gateway for cost
analytics and a spend limit. SOPs are canonical in Notion and synced to R2 by
an export script.

How an answer is produced (`src/server.ts`, pure helpers in `src/lib/`):

1. A layered screen (regex tripwire, live warnings, a model name-check at
   send, and server-side redact-and-delete) blocks patient names, dates of
   birth, and contact details before they reach the model; patient, chart,
   and record numbers are permitted. The name-check reads the whole message
   in overlapping windows. Messages are capped at 8,000 characters.
2. AI Search retrieves and reranks SOP passages; the top SOPs go to the model
   as full documents so every click path and field name can be quoted.
   Retrieval settings — query rewrite, result count, keyword match mode —
   are wrangler vars passed to AI Search per request. With rewrite on, a
   model rewrites every query before search, the first message included,
   which adds seconds and hides what was typed. Chunk passages have their
   frontmatter stripped so the model never sees a passage's link, status, or
   hints, and a SOP whose Notion Status is Draft carries a "Draft" chip on
   its card, in the library, and on pins.
3. The system prompt carries a curated team structure (`src/lib/teams.ts`,
   derived from the Notion page "Operations Teams Structure Overview"; no
   people, no channels). The model may name teams and functions from it, as a
   steer under "Who handles this"; it never supplies steps.
4. The request sent to the model is sized to its 24k-token window by
   characters: prompt, passages, prior turns and the latest message each have
   a budget in `src/lib/pipeline.ts` (oldest turns are trimmed first; error
   and no-match lines are never replayed as history).
5. Generation runs behind a collapse guard: the fp8 model occasionally emits
   stopword soup, so the first 240 characters are held back and the answer
   is regenerated (up to three tries) if they read as garbled. An answer cut
   off at the output limit says so.
6. The "What the SOPs say" block is rebuilt by the Worker from retrieval:
   each citation is matched to the SOP's own text, the whole list item is
   quoted, the section label and Notion link come from the bucket, and a
   follow-up question that asks for an identifier is dropped. Cards for
   cited SOPs carry a Cited chip.

Conversations purge after 7 idle days.

Reading preferences sit below the home and follow-up question boxes. Choose
Concise or Detailed independently of New to Mindspan or Experienced. The
default is Detailed + New to Mindspan. Selections are remembered in this
browser and apply to the next submission, including deep links; changing them
does not rewrite existing answers. Concise trims explanations while retaining
required procedural detail, and Experienced omits introductory definitions.
SOP retrieval, coverage rules and citations apply to every style.

## Commands

```bash
npm run dev                        # local dev (requires wrangler auth for remote bindings)
npm run export                     # sync SOPs: Notion -> markdown -> R2 (needs NOTION_TOKEN and NOTION_SOP_ROOT in .env)
npm run export -- --dry-run        # convert and write export/ only; touches neither R2 nor the manifest
npm run export -- --prune          # also delete the R2 objects the export lists as stale
npm run export -- --prune --force  # prune even when the run looks suspicious (read the stale list first)
npm run deploy                     # build and deploy the Worker
npm run check                      # format check, lint, typecheck, unit tests
npm test                           # unit tests only (node --test over src/lib and scripts)
```

Node 24 or newer is required (native TypeScript type stripping runs the
export script and the tests).

## Export

`npm run export` writes each page under `NOTION_SOP_ROOT` to markdown and
syncs it to R2. Every file's frontmatter carries `title`, `source_url`,
`category` (the primary tag), `categories`, `status` (Notion's Status
select, or empty), `use_when` (the "Use When (Agent Hints)" text — indexed
by AI Search but never shown to the model), and `last_edited`; `owner` is
included only when Notion has one set.

Three kinds of row are skipped: untitled template stubs, the non-procedure
pages deny-listed by id in `scripts/export-filter.ts`, and the children of
any skipped page. A page missing the SOP or Reference tag still exports,
but the run warns about it.

The export writes a manifest of what it put in R2 to
`scripts/sops-manifest.json` (commit it with each export). It records
stale keys — pages renamed, archived, emptied, or newly excluded in
Notion — together with the id of the page that produced them. A run that
exports nothing, or where more than a fifth of the tracked corpus goes
stale without this run having seen the source page, refuses to prune and
exits non-zero. After a genuine bulk deletion, read the stale list and
re-run with `--force` to prune anyway.

## Sync

`.github/workflows/sync-sops.yml` runs the export daily at 03:07 UTC, and
on manual dispatch (Actions → Sync SOPs → Run workflow); it syncs only from
`main`. The workflow reindexes AI Search itself and, when the exported file
list changed, commits the manifest back as `github-actions[bot]`. Pruning
is dispatch-only (`prune=true`); the run summary lists any stale keys and
warns when one is older than 7 days. Notion edits still in progress ship at
03:07 UTC the same as finished ones — a Draft status shows a chip on the
card rather than being filtered out.

The workflow needs four repository secrets that do not exist yet:
`NOTION_TOKEN` (an internal integration secret with Read content access,
connected to the database), `NOTION_SOP_ROOT` (store as the dashed
lowercase UUID), `CLOUDFLARE_API_TOKEN` (account-scoped: Workers R2
Storage Edit + AI Search Edit), and `CLOUDFLARE_ACCOUNT_ID`.

Logs and step summaries are public: only titles and object keys are
printed, never page bodies. A manifest commit triggers a Workers Builds
redeploy; exclude `scripts/sops-manifest.json` from the build watch paths
if that redeploy isn't wanted.

Manual `npm run export` followed by `npx wrangler ai-search jobs create
cortex` remains the break-glass path — don't run it while a workflow run is
in progress.

## Notes for operators

- Merges into `main` deploy automatically via Workers Builds (Cloudflare's
  Git integration); other branches get preview URLs on push. CI runs
  `npm run check` and `npm run build` on every pull request.
- The live URL sits behind Cloudflare Access (Zero Trust dashboard, free
  under 50 users); keep it there before sharing beyond the admin. Preview
  hostnames from Workers Builds are challenged too (checked 2026-09-02).
- Other Mindspan apps can open Cortex with a situation prefilled and sent
  once (`docs/deeplink.md`). A deep link's query string is stripped from
  the address bar on load and never reaches Worker code or Workers Logs;
  the text itself then follows the ordinary message path, exactly as if
  it had been typed.
- The monthly answer budget is `MONTHLY_MESSAGE_BUDGET` in `wrangler.jsonc`;
  the dollar cap is the AI Gateway spend limit (dashboard).
- Retrieval is tuned by three `wrangler.jsonc` vars: `RETRIEVAL_QUERY_REWRITE`
  (`on`/`off`) controls whether a model rewrites each query, first message
  included, before search; `RETRIEVAL_MAX_RESULTS` (1-50) caps how many chunks AI Search
  returns before they dedupe into SOP cards; `RETRIEVAL_KEYWORD_MATCH`
  (`and`/`or`) sets hybrid search's keyword mode, and `and` needs every word
  of a sentence-length question to match a chunk.
- `docs/eval/README.md` documents the retrieval eval harness and the
  decision rule for flipping the vars above.
- The answer format and grounding rules live in `buildSystemPrompt` in
  `src/lib/prompt.ts`; the team structure it embeds lives in
  `src/lib/teams.ts`. Edit the structure by hand when the Notion page changes
  (it is not synced), and never add people's names, Slack channels, or the
  page's open questions. `SYSTEM_PROMPT` exports the default style for existing
  consumers. `npm test` pins every style to the model-window budget in
  `src/lib/pipeline.ts`. Every user-facing string, including the lines the
  Worker streams on errors, lives in `src/lib/copy.ts`.
- Workers Logs are enabled (`observability` in `wrangler.jsonc`); nothing
  Cortex logs contains message text. Every search writes one line tagged
  `[cortex] retrieval` with the SOP keys returned, their scores, counts,
  the active retrieval config, and latency — never the query or chunk text.

### Coverage and source rules

Cortex repeats complete governing rules from retrieved passages before
generating an answer. Conditions and exceptions stay attached; an
oversized rule is omitted from the repeated block, while its original
passage remains available. The prompt limits remain inside the model
window: 21,000 prompt characters, 26,000 passage characters, 1,500
repeated-rule characters, and 9,000 history characters including
coverage prefixes.

Generation still streams through the existing collapse guard. Before any
generated prose is delivered, a bounded gate reads the opening
`Coverage:` declaration. Answers marked `none`, or missing a valid
declaration, are replaced with a fixed response without a workflow.
Their retrieved cards read “Searched, not used.” Answers marked
`partial` can contain supported steps and show a coverage note. Coverage
is a model judgment; this is not semantic validation of full or partial
answers.

Coverage metadata is optional on persisted messages, so older threads
retain their existing display. Only delivered text enters history, and
coverage declarations are replayed to generation, never to retrieval.
`[cortex] answer` telemetry contains coverage/suppression enums,
generated and delivered step/gap counts, citation counts, attempt
counts, and timing. It contains no query, answer, or source text.

Live answer evaluation runs through the same generation, coverage, and
citation code as production. See `docs/eval/README.md`; raw answers and
evidence stay in gitignored `.context/eval`, and committed reports
contain summary indicators only.
