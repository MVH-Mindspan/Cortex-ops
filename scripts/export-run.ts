// Which of a run's stale manifest keys that run cannot account for. Pure
// module (a type-only import, so no runtime side effects) so it can be
// unit-tested with node:test.
//
// The export refuses to prune when too much of the tracked corpus goes stale
// at once, on the assumption that Notion returned an incomplete page set. But
// a run that deliberately skips pages (untitled stubs, excluded non-SOP rows)
// makes their keys stale on purpose, and counting those would make the first
// pruning run refuse itself.
//
// reconcileManifest records the id of the page that produced each stale key
// and carries it forward, so this reads the id straight off the entry: a key
// that has been stale for months is still checked against this run's page set
// rather than counting as unexplained for ever. An excluded page still in
// Notion is explained on every run, and a page that really vanished is
// unexplained on every run until it is pruned, so the rule stays armed
// through an outage instead of forgetting about it after one run.

import type { StaleEntry } from "./manifest.ts";

// A stale key is explained when this run listed its page in Notion and chose
// not to export it. A key whose page never appeared (deleted in Notion, or
// missing from an incomplete listing), or that carries no id to check at all
// (a manifest written before ids were recorded), is unexplained. The input is
// not mutated.
export function unexplainedStale(
  stale: StaleEntry[],
  seenIds: Set<string>
): string[] {
  return stale
    .filter((entry) => !entry.notion_id || !seenIds.has(entry.notion_id))
    .map((entry) => entry.key);
}
