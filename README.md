# Cortex

**Live preview: https://cortex.mvh-9c9.workers.dev**

Cortex is Mindspan's internal operations assistant. Ops staff paste a situation
(a caregiver call, an insurer email, a misrouted order) and Cortex answers in a
structured incident format grounded only in the team's SOPs, with ranked SOP
cards linking back to their canonical Notion pages.

Built entirely on Cloudflare: Workers + Agents SDK for the chat backend
(Durable Objects for per-conversation state), R2 for the exported SOP library,
AI Search for hybrid retrieval with reranking, and Workers AI
(llama-3.3-70b) for generation. SOPs are canonical in Notion and synced to R2
by an export script. No PHI: a layered screen (regex tripwire, live warnings,
a model name-check at send, and server-side redact-and-delete) blocks patient
identifiers, and conversations purge after 7 idle days.

## Commands

```bash
npm run dev      # local dev (requires wrangler auth for remote bindings)
npm run export   # sync SOPs: Notion -> markdown -> R2 (needs NOTION_TOKEN in .env)
npm run deploy   # build and deploy the Worker
npm run check    # format check, lint, typecheck
```

After an export, trigger a reindex so new content is searchable:

```bash
npx wrangler ai-search jobs create cortex
```

## Notes for operators

- Merges into `main` deploy automatically via Workers Builds (Cloudflare's
  Git integration); other branches get preview URLs on push.
- Put the live URL behind Cloudflare Access before sharing beyond the admin
  (Zero Trust dashboard, free under 50 users).
- The monthly answer budget is `MONTHLY_MESSAGE_BUDGET` in `wrangler.jsonc`.
- The answer format and grounding rules live in `SYSTEM_PROMPT` in
  `src/server.ts`.
