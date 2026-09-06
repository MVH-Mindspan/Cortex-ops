# Retrieval eval harness

Cortex retrieves SOP chunks through the AI Search **binding**
(`env.AI_SEARCH.get("cortex").search(...)`) with per-request options built from
three wrangler vars, then `rankSops` dedupes the chunks to at most five files.
This harness measures that path — the real instance, the real corpus, the real
options — across a matrix of settings, so a change to the defaults is decided
from numbers rather than from one tester's transcript.

It exists because the CLI cannot answer the question. `wrangler ai-search
search` applies the instance's own `score_threshold` (0.4) whatever flags you
pass it, and Cortex overrides that per request with a near-zero threshold
(0.01 / 0.001, see `src/lib/retrieval.ts`). The CLI therefore hides exactly the
chunks the Worker relies on. **Never draw a conclusion about retrieval from the
CLI.** Use the binding.

## Running it

Two terminals, from the repo root.

```sh
npm run eval:dev                 # wrangler dev, local code, remote bindings
npm run eval -- --mode retrieval # the matrix, in a second terminal
```

`eval:dev` starts `scripts/eval/worker.ts` on port 8790 with the AI Search,
Workers AI and R2 bindings marked `remote: true` — local code against the
production instance, the same way `npm run dev` already works.

Smoke the endpoint once before spending the matrix:

```sh
curl -s -X POST 127.0.0.1:8790/search \
  -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"amyloid PET order ICD-10"}]}'
```

You want JSON with a `ranked` array naming the imaging checklist.

If wrangler's esbuild cannot bundle `gray-matter` (pulled in through
`src/lib/frontmatter.ts`), settle it offline rather than by guessing — this
uploads nothing:

```sh
npx wrangler deploy --dry-run --outdir /tmp/cortex-eval-bundle \
  -c scripts/eval/wrangler.jsonc
```

The fix, if it comes to that, is to parse frontmatter inside the eval Worker
with a small regex-based fallback — accepting that doing so trades away the
guarantee below that titles and statuses cannot drift from production, since
the harness would no longer read them through `loadSopMeta`.

Do **not** reach for `wrangler dev --remote`: that runs the code on a
Cloudflare preview host, where the hostname guard in `worker.ts` correctly
404s every request. That guard, and the fact that this Worker is never
deployed, are the only things standing between an unauthenticated `/search`
endpoint and the open internet. Leave both alone.

### Flags

| flag        | default                         | meaning                                                        |
| ----------- | ------------------------------- | -------------------------------------------------------------- |
| `--base`    | `http://127.0.0.1:8790`         | where the eval Worker is listening                             |
| `--mode`    | `retrieval`                     | `retrieval` or `answers`; see Answer evaluation                |
| `--out`     | `docs/eval/<date>-retrieval.md` | report path; the JSON sidecar takes the same name              |
| `--configs` | the full 12-config matrix       | comma list of `rewrite/max/keyword`, e.g. `on/15/and,on/30/or` |

The default matrix is rewrite {on, off} × max {15, 30, 50} × keyword {and, or}
= 12 configs over the 18 questions in `scripts/eval/questions.json` = 216
searches. Narrow it with `--configs` while iterating.

The run stops itself, writes the report from what completed and exits 1 when
Workers AI reports an exhausted daily neuron allocation (error 7094 —
reranking cannot run until it resets), or when three requests in a row cannot
reach the Worker at all. It also exits 1, without writing anything, if the
Worker resolves a different config than the one asked for: every number in the
report would be filed under the wrong heading. Individual failed requests are
recorded as `err` cells and make the run exit 1 without stopping it. Requests
are paced 250 ms apart, because AI Search rate-limits bursts.

## Cost

Not free, and not isolated from production.

- Every question is one AI Search query against the shared monthly quota.
- Reranking spends neurons from the **same daily pool production uses**. A full
  matrix that exhausts it takes Cortex's answers down until it resets.
- R2 reads are negligible; there is no generation in this mode, so no
  generation spend.

Run the matrix outside clinic hours, and smoke-test with one question first.

## What it does and does not reproduce

Reproduced:

- the AI Search binding, not the CLI;
- the Worker's exact per-request options, because the harness calls
  `searchOptions(retrievalConfig(...))` from `src/lib/retrieval.ts`;
- the R2 frontmatter read: the harness and `ChatAgent.fileMetaFor` both call
  `loadSopMeta` in `src/lib/frontmatter.ts`, so titles and statuses cannot
  drift apart from production;
- `rankSops`, so "rank" means the position on the SOP cards an operator sees.

Not reproduced:

- the `ChatAgent` Durable Object, its persistence and its purge alarm;
- `trimHistory` — the follow-up cases send their turns verbatim;
- the PHI name screen and the monthly `UsageBudget` gate;
- generation in retrieval mode. Answer mode below exercises the shared generation pipeline.

Chunk text never leaves the Worker: reports are committed, and the repo is
public. Only keys, scores, scoring details and section headings are returned.

## Decision rule for flipping the defaults

Adopt `on / 30 / or` (`RETRIEVAL_QUERY_REWRITE`, `RETRIEVAL_MAX_RESULTS`,
`RETRIEVAL_KEYWORD_MATCH` in `wrangler.jsonc`) only if all three hold:

1. **R3 ranks the imaging checklist in the top 5.** This is the headline miss —
   pre-supplying the ICD-10 codes made the checklist disappear under
   `keyword_match_mode: "and"`.
2. **R4 improves from rank 5.**
3. **No regression:** every question that ranked its expected SOP **first**
   under `on / 15 / and` still ranks it in the **top 3**.

C2 is excluded from rule 3: it already ranks ≤3 under the current config and
its failure was an answer-quality problem, not a retrieval one.

## Reports

Reports live beside this file as `<date>-retrieval.md` with a `<date>-retrieval.json`
sidecar holding the raw per-question records. The runner formats both with
oxfmt so `npm run check` stays green. Record the report path in the commit
message of any change to the retrieval defaults.

## Outcomes

- **3 Sep 2026** (`2026-09-03-retrieval.md`, first run after the corpus refresh that indexed the agent hints): `on/30/and` adopted. All 16 expected SOPs in the top 3 with no misses, every rank-1 under `on/15/and` still rank 1, R3 at rank 2 and R4 at rank 1. Keyword mode `or` demoted R3 (weak keyword candidates crowd the reranker) and rewrite off lost the follow-up case T1 (with rewrite off only the latest message is searched), so both stay as they were.

## Answer evaluation

`npm run eval -- --mode answers --answers 4 --ids D1,R2,R4,B1` runs four **total** answers through the production generation settings, collapse guard, coverage gate, and citation repair. Pass `--without-rules` for the rules-block ablation. `--ids` cycles when `--answers` exceeds the number of IDs. `--out docs/eval/<name>.md` selects a summary report.

The default is four answers. More than eight answers per batch, or any run during 06:00–20:00 America/Los_Angeles (DST-aware), requires `--use-production-budget`. A batch prints its rough generation-neuron estimate before calling the Worker and stops on an allocation or provider error. Reranking and retries add cost; this shares production's quota. Never continue after allocation exhaustion.

Raw answers, rules, and source passages are saved only under gitignored `.context/eval/<timestamp>/`. Reports contain aggregate indicators and token counts, not content. The indicators catch known failure shapes, but require manual review: a keyword-based passing score is not evidence that a workflow is supported. No-match notices must not be counted as successful answer generation or as the model correctly choosing coverage `none`; the harness enforces this by reporting every indicator on such a row as `null`, and the report header states how many of its rows actually generated an answer. An answer that cites nothing reports `quoteWhole: null` for the same reason.

For acceptance, run each of the 16 original cases three times, then T1 and T2. Run D1/R2/R4/B1 three times with the rules block disabled for ablation. Compare role authority, result interpretation, timing promises, gap handling, and complete citations against the original feedback; inspect full delivered answers locally. The report header records the prompt revision (`git describe --always --dirty`) automatically; keep failed smoke runs distinct from acceptance runs.

The harness reproduces generation and stream processing, but does not call the production chat Durable Object, PHI screen, or monthly budget gate. UI and persistence checks remain separate. The eval Worker stays local and must never be deployed.
