# Team directory (persona routing)

Cortex answers say which team likely owns a situation (the team structure in
`src/lib/teams.ts`) and which person to contact. The people come from the team
directory, described here. The design follows the Notion spec
"Persona-Based Routing System — Implementation Spec (Cortex)"; the ways this
build differs from it are listed at the end.

## Where it lives

- **Canonical:** the Notion database **Team Directory (Cortex)**, one row per
  person, edited by ops managers.
- **Synced:** the nightly **Sync SOPs** workflow (03:07 UTC) runs
  `npm run export-personas`. It reads every row whose Status is **Live**,
  checks it (below), and writes `team-directory.json` to the private R2
  bucket `cortex-directory`.
- **Used:** the Worker reads that object (cached for five minutes) and adds a
  "Team directory" section to the answer prompt. The directory's names also
  go to the patient-name screen as staff, so "should this go to <name>?" is
  not blocked as a possible patient name. The same name used for a patient
  still is.
- **Never in git.** This repository is public. No name, title, channel or
  page text from the directory is committed, printed in the workflow's
  public logs, or used in tests (the tests use invented people).

An edit in Notion is live after the next nightly sync, plus up to five
minutes. For sooner, run the workflow by hand:

```sh
gh workflow run "Sync SOPs" --ref main
```

If R2 has no directory, or it cannot be read, answers go out exactly as
before: team-level steer only, and no person named.

## Who gets named

The person is picked in code before the model answers
(`src/lib/contacts.ts`). Left to itself, the model tended to name whoever sat
on the team it had just named.

- **Scoring:** each Live row is scored by the words its Route When hint, Core
  Responsibilities and Title share with the question. Rare words count more than
  common ones.
  Product names (the capitalised words on Systems lines) count little, since
  naming a system does not make someone its owner.
- **Out of Scope:** these lines count both ways. The person a line points to
  gains, and the person who holds the line loses.
- **The match:** the top one or two rows above a threshold go into the request
  as a "Team directory match" block, with each one's reach and backup, and
  the answer names the first. When no
  row scores high enough, the block says so and the answer names no one.

So the wording of a row matters. Use the words people actually use for the
work (for example "copay") in Core Responsibilities, and list the work someone
should not get in Out of Scope, with where it goes instead.

Hand-overs between teams always go "on Slack". There is no ticketing system,
and a test keeps one out of the prompt.

## What a row needs

| Property           | Used for                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------ |
| Name               | The person, as answers name them. Two rows may share a name; answers tell them apart by title.   |
| Title              | Shown after the name; also how the checks refer to the row in public logs.                       |
| Department         | Shown after the title.                                                                           |
| Routing Department | The Department Routing Map departments this person works in. Only the checks use it.             |
| Priority           | Order in the prompt (P0 first), and which rows go first if the directory ever runs over its cap. |
| Status             | Only Live rows are exported. Draft and Archived rows are ignored.                                |
| Backup             | Used when the page body has no Backup line.                                                      |
| Slack Channel      | Used when the page body has no Slack or Dashboard line.                                          |

The page body uses these headings. A missing heading leaves that field empty.

- `## Route When`: free text (prose or bullets) saying when to route here. Its
  words feed the code matcher exactly like Core Responsibilities, so phrase it
  in the words people use for the work. Optional.
- `## Core Responsibilities`: one bullet per responsibility. Required.
- `## Domain Expertise`: the `Systems:` line is used.
- `## Out of Scope (Do NOT route here)`: one bullet per topic, ending
  `(route to <person or department>)` or `(→ <person>)`. Separate two
  targets with `/`.
- `## Escalation Path`: `Backup:` and `Escalates to:` lines.
- `## How to Reach`: `Slack:` and `Dashboard:` lines. Answers give the Slack
  route, and the dashboard only when there is no Slack line. An
  `(unverified)` marker is for editors; answers never show it.

## Checks

Every export checks the rows (`scripts/routing-check.ts`). It also checks
each row's Out of Scope against the "Do not send them" lists on the Notion
page **Department Routing Map (Cortex)**, in both directions.

| Level     | Meaning                                                                                                                                                       | Effect                    |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| error     | No Title, Department or Core Responsibilities.                                                                                                                | Row left out; run is red. |
| reference | A Backup or Out of Scope target that matches no one in the directory and no department, a redirect back to the same person, or an unknown Routing Department. | Reported only.            |
| conflict  | The person owns work their routing department excludes, or sends a topic to someone whose department excludes it.                                             | Reported only.            |
| gap       | Their routing department excludes some work, and their Out of Scope never sends that work anywhere.                                                           | Reported only.            |
| note      | No Routing Department, so the cross-check is skipped.                                                                                                         | Reported only.            |

Conflicts and gaps come from word overlap between topics. They tell someone to
read the row; they are not verdicts. Nothing is uploaded when a page cannot
be read, no row is usable, or the directory is over its size cap. The last
good directory then stays live.

The run summary (Actions → Sync SOPs → the run) lists every issue by Title.
To see the same thing locally, with a Notion token in `.env`:

```sh
npm run export-personas -- --dry-run   # read + check; writes export/, uploads nothing
npm run validate-routing               # re-check export/team-directory.json
```

`export/` is gitignored; its files contain the directory.

## Size

The rendered directory is capped at `PERSONAS_MAX_CHARS` (9,000 characters,
`src/lib/personas.ts`); 20 rows came to about 7,950 in September 2026. The
model's window is fixed, so the directory is paid for with SOP text. Each
answer's passages get what the prompt, the earlier turns and the message
leave, up to their usual 26,000 characters (`passageBudgetFor` in
`src/lib/pipeline.ts`). An ordinary turn keeps the full 26,000. The longest
conversation plus the longest paste still gets at least `MIN_PASSAGE_CHARS`.
Past about 50 people, move the directory into retrieval instead.

## One-time setup

1. In Notion, open Team Directory (Cortex) → ••• → Connections, and add the
   export integration (the one the SOP sync uses). Without it the step fails
   with a message saying so.
2. Repository secret `NOTION_PERSONA_ROOT`: the database id, dashed. If it is
   unset, the step warns and skips, and the SOP sync is unaffected.
3. R2 bucket `cortex-directory` on the Cortex account, bound to the Worker
   as `DIRECTORY_BUCKET` in `wrangler.jsonc`.

## Differences from the spec

- The spec commits a generated `src/lib/personas.ts` holding the people. This
  repository is public, so the people live in R2 and are read at runtime.
  `src/lib/personas.ts` holds only the format, the checks on the R2 object,
  and the rendering. Updates need no commit or redeploy.
- The spec raises the prompt budget from 21k to 28k. A flat 28k would push a
  worst-case request past the model's 24k-token window. The passages shrink
  by the directory's actual size instead, only when a request needs it.
- The routing checks run on every export, not in `npm run check`, because
  the data is not in the repository. `npm run check` tests the check logic on
  invented rows.
- The spec does not map people to the routing map's departments. The
  Routing Department property was added for that.
- The spec leaves the choice of person to the model. A live eval showed it
  misrouting (a copay question went to an enrollment lead), so the person is
  matched in code and the model is told to use the match.
