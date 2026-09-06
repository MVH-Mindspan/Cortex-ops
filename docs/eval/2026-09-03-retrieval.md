# Retrieval eval — 2026-09-03

Binding-level run against the `cortex` AI Search instance through `scripts/eval/worker.ts` at http://127.0.0.1:8790: 18 questions × 12 configs, 216 searches. Configs are `query_rewrite / max_num_results / keyword_match_mode`.

## Summary by config

| config     | hits@1 | hits@3 | hits@5 | misses | mean rank | mean ms | errors |
| ---------- | ------ | ------ | ------ | ------ | --------- | ------- | ------ |
| on/15/and  | 6      | 13     | 13     | 3      | 1.62      | 8338    | 0      |
| on/15/or   | 8      | 14     | 15     | 1      | 1.73      | 7536    | 0      |
| on/30/and  | 9      | 16     | 16     | 0      | 1.56      | 5497    | 0      |
| on/30/or   | 10     | 15     | 16     | 0      | 1.63      | 7752    | 0      |
| on/50/and  | 9      | 15     | 15     | 1      | 1.53      | 6528    | 0      |
| on/50/or   | 8      | 15     | 16     | 0      | 1.75      | 7076    | 0      |
| off/15/and | 9      | 15     | 15     | 1      | 1.4       | 4808    | 0      |
| off/15/or  | 9      | 15     | 15     | 1      | 1.4       | 6399    | 0      |
| off/30/and | 9      | 14     | 14     | 2      | 1.36      | 6580    | 0      |
| off/30/or  | 9      | 15     | 15     | 1      | 1.4       | 6521    | 0      |
| off/50/and | 9      | 14     | 14     | 2      | 1.36      | 5404    | 0      |
| off/50/or  | 9      | 15     | 15     | 1      | 1.4       | 5791    | 0      |

Scored over the 16 questions with an expected SOP. Rank is the 1-based position of the first expected key in `ranked`, which rankSops caps at 5 — so hits@5 is every hit, and "miss" means the SOP was not among the 5 files offered. Failed requests are excluded from every column but `errors`.

## Questions

- **D1** (demo) — expected `imaging-order-requirements-amyloid-pet-mri-checklist-draft-needs-review.md` — the tester's demo scenario: one long multi-part request that names the codes, the vendor and the modality
- **A1** (A) — expected `imaging-order-requirements-amyloid-pet-mri-checklist-draft-needs-review.md` — the symptom, not the cause: no code, no field name, nothing to match on but the modality
- **A2** (A) — expected `imaging-order-requirements-amyloid-pet-mri-checklist-draft-needs-review.md` — the checklist asked for directly, in the SOP's own vocabulary
- **A3** (A) — _no SOP covers this_ — no SOP covers cancellations; the tester's run retrieved Misrouted & Missing Orders
- **B1** (B) — expected `imaging-order-requirements-amyloid-pet-mri-checklist-draft-needs-review.md` or `external-facility-provider-calls-records-re-faxes-code-fixes-draft-needs-review.md` — either SOP is a correct source; both carry the ops-never-picks-the-code rule
- **B2** (B) — expected `results-next-steps-requests-draft-needs-review.md` — scope-of-practice question with no imaging keywords beyond the word imaging
- **B3** (B) — expected `insurance-verification-prior-authorization-draft-needs-review.md` — pressure to skip a prerequisite; the SOP that says no is the auth one
- **C1** (C) — expected `insurance-verification-prior-authorization-draft-needs-review.md` — two topics in one question: imaging and prior auth
- **C2** (C) — expected `results-next-steps-requests-draft-needs-review.md` — already rank <=3 under the current config; excluded from the F2 decision rule (its failure was F1)
- **C3** (C) — _no SOP covers this_ — no SOP covers patient-facing reminder recipients
- **R1** (rerun) — expected `imaging-order-requirements-amyloid-pet-mri-checklist-draft-needs-review.md` — the shortest possible form of the headline question
- **R2** (rerun) — expected `imaging-order-requirements-amyloid-pet-mri-checklist-draft-needs-review.md` — same question under time pressure; VRI and ICD-10 are the only keyword-index tokens
- **R3** (rerun) — expected `imaging-order-requirements-amyloid-pet-mri-checklist-draft-needs-review.md` — the headline miss: under keyword mode and, the checklist is absent
- **R4** (rerun) — expected `imaging-order-requirements-amyloid-pet-mri-checklist-draft-needs-review.md` or `external-facility-provider-calls-records-re-faxes-code-fixes-draft-needs-review.md` — ranked 5th (chunk only) in the tester's run
- **R5** (rerun) — expected `imaging-order-requirements-amyloid-pet-mri-checklist-draft-needs-review.md` — the same fix asked for as a procedure rather than as a fact
- **D2** (control) — expected `new-medication-new-prescription-requests-triage-draft-needs-review.md` — control: an imaging-flavoured question whose answer is a medication SOP, so a config that simply pulls the imaging checklist toward everything shows up as a regression here; this SOP entered the corpus in the 3 Sep 2026 refresh
- **T1** (follow-up) — expected `imaging-order-requirements-amyloid-pet-mri-checklist-draft-needs-review.md` — measures query rewrite, which only applies to follow-up turns
- **T2** (follow-up) — expected `results-next-steps-requests-draft-needs-review.md` — measures query rewrite, which only applies to follow-up turns

## Rank grid

| id  | on/15/and | on/15/or | on/30/and | on/30/or | on/50/and | on/50/or | off/15/and | off/15/or | off/30/and | off/30/or | off/50/and | off/50/or |
| --- | --------- | -------- | --------- | -------- | --------- | -------- | ---------- | --------- | ---------- | --------- | ---------- | --------- |
| D1  | 1         | 1        | 1         | 1        | 1         | 1k       | 1          | 1         | 1          | 1k        | 1          | 1k        |
| A1  | 2         | 2k       | 2         | 1k       | 1         | 2k       | 2          | 2k        | —          | 2k        | 2          | 2k        |
| A2  | 2         | 2k       | 2         | 2k       | 2         | 2k       | 2          | 2k        | 2          | 2         | —          | 2k        |
| A3  | 5         | 5        | 5         | 5        | 5         | 5        | 5          | 5         | 5          | 5         | 5          | 5         |
| B1  | 1         | 1k       | 1         | 1k       | 1         | 1k       | 1          | 1k        | 1          | 1k        | 1          | 1k        |
| B2  | —         | 1k       | 1         | 1k       | 1         | 1k       | 1          | 1k        | 1          | 1k        | 1          | 1k        |
| B3  | —         | 5k       | 3         | 3k       | 3         | 5k       | 2          | 2k        | 2          | 2         | 2          | 2         |
| C1  | 2         | 2k       | 2         | 2k       | 2         | 2k       | 2          | 2k        | 2          | 2k        | 2          | 2k        |
| C2  | 2         | 2k       | 2         | 1k       | 2         | 2k       | 1          | 1k        | 1          | 1k        | 1          | 1k        |
| C3  | 5         | 5        | 5         | 5        | 5         | 5        | 5          | 5         | 5          | 5         | 5          | 5         |
| R1  | 1         | 1k       | 1         | 1k       | 1         | 1k       | 1          | 1k        | 1          | 1k        | 1          | 1k        |
| R2  | 1         | 1k       | 1         | 1k       | 1         | 1k       | 1          | 1k        | 1          | 1k        | 1          | 1k        |
| R3  | 2         | —        | 2         | 4k       | —         | 2k       | 2          | 2k        | 2          | 2k        | 2          | 2k        |
| R4  | 2         | 2k       | 1         | 2k       | 2         | 2k       | 1          | 1k        | 1          | 1k        | 1          | 1k        |
| R5  | 3         | 3k       | 3         | 3k       | 3         | 3k       | 2          | 2k        | 2          | 2k        | 2          | 2k        |
| D2  | 1         | 1k       | 1         | 1k       | 1         | 1k       | 1          | 1k        | 1          | 1k        | 1          | 1k        |
| T1  | —         | 1k       | 1         | 1k       | 1         | 1k       | —          | —         | —          | —         | —          | —         |
| T2  | 1         | 1k       | 1         | 1k       | 1         | 1k       | 1          | 1k        | 1          | 1k        | 1          | 1k        |

`—` = not in the top 5. A trailing `k` means the matched file's best chunk carried a `keyword_rank`, i.e. the BM25 leg fired rather than vector-only. For the questions no SOP covers the cell is the number of files returned.

## Query rewrite (follow-up turns)

| id  | on/15/and | on/15/or | on/30/and | on/30/or | on/50/and | on/50/or | off/15/and | off/15/or | off/30/and | off/30/or | off/50/and | off/50/or |
| --- | --------- | -------- | --------- | -------- | --------- | -------- | ---------- | --------- | ---------- | --------- | ---------- | --------- |
| T1  | yes       | yes      | yes       | yes      | yes       | yes      | no         | no        | no         | no        | no         | no        |
| T2  | yes       | yes      | yes       | yes      | yes       | yes      | no         | no        | no         | no        | no         | no        |

`yes` = AI Search ran a query different from the last user turn. With rewrite on this happens on every turn, the first included (observed 3 Sep 2026); with rewrite off it must never happen.
