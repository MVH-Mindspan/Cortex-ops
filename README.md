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

Conversations purge after 7 idle days.

## Commands

```bash
npm run dev      # local dev (requires wrangler auth for remote bindings)
npm run export   # sync SOPs: Notion -> markdown -> R2 (needs NOTION_TOKEN and NOTION_SOP_ROOT in .env)
npm run deploy   # build and deploy the Worker
npm run check    # format check, lint, typecheck, unit tests
npm test         # unit tests only (node --test over src/lib and scripts)
```

Node 24 or newer is required (native TypeScript type stripping runs the
export script and the tests).

After an export, trigger a reindex so new content is searchable:

```bash
npx wrangler ai-search jobs create cortex
```

The export keeps a manifest of what is in the bucket at
`scripts/sops-manifest.json`; commit it with each export. Pages renamed,
archived, emptied, or deleted in Notion leave stale objects in R2 that keep
being retrieved and cited. Each run lists them at the end, and

```bash
npm run export -- --prune
```

deletes them (then reindex). Objects from exports made before the manifest
existed are not tracked: the first run records what it exports, and only
changes after that are flagged.

## Notes for operators

- Merges into `main` deploy automatically via Workers Builds (Cloudflare's
  Git integration); other branches get preview URLs on push. CI runs
  `npm run check` and `npm run build` on every pull request.
- The live URL sits behind Cloudflare Access (Zero Trust dashboard, free
  under 50 users); keep it there before sharing beyond the admin.
- The monthly answer budget is `MONTHLY_MESSAGE_BUDGET` in `wrangler.jsonc`;
  the dollar cap is the AI Gateway spend limit (dashboard).
- The answer format and grounding rules live in `SYSTEM_PROMPT` in
  `src/lib/prompt.ts`; the team structure it embeds lives in
  `src/lib/teams.ts`. Edit the structure by hand when the Notion page changes
  (it is not synced), and never add people's names, Slack channels, or the
  page's open questions. `npm test` pins both to the model-window budget in
  `src/lib/pipeline.ts`. Every user-facing string, including the lines the
  Worker streams on errors, lives in `src/lib/copy.ts`.
- Workers Logs are enabled (`observability` in `wrangler.jsonc`); nothing
  Cortex logs contains message text.
