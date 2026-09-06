// Manifest of the SOP objects the export has put in R2. Wrangler can get, put
// and delete objects but cannot list them, so this committed file is the only
// record of what is in the bucket and therefore of what has gone stale.
// Pure module (no imports) so it can be unit-tested with node:test.

export type ManifestFile = {
  key: string;
  title: string;
  notion_id: string;
  last_edited: string;
};

// notion_id is what lets a later run ask whether the page behind a key that
// went stale months ago is still in Notion. Optional: manifests written
// before it existed, and hand-written ones, still load.
export type StaleEntry = { key: string; since: string; notion_id?: string };

export type Manifest = {
  exported_at: string;
  files: ManifestFile[];
  stale: StaleEntry[];
};

function byKey(a: { key: string }, b: { key: string }): number {
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

// A key known from the previous manifest (files or stale) is stale when it was
// neither exported this run nor belongs to a page whose export failed: a
// failed page keeps its old object in R2 and must never be pruned, so its
// previous entry is carried into `files` rather than forgotten. Stale keys
// keep their original `since` so a later --prune run still sees them, and
// their `notion_id` so a later run can still tell which page produced them.
export function reconcileManifest(
  previous: Manifest | null,
  exported: ManifestFile[],
  failedKeys: Set<string>,
  now: string
): { next: Manifest; stale: string[] } {
  const previousFiles = previous?.files ?? [];
  const previousStale = previous?.stale ?? [];
  const exportedKeys = new Set(exported.map((f) => f.key));

  const kept = previousFiles.filter(
    (f) => !exportedKeys.has(f.key) && failedKeys.has(f.key)
  );
  const files = [...exported, ...kept].sort(byKey);

  const since = new Map(previousStale.map((s) => [s.key, s.since]));
  // Which page last produced each key: a key going stale for the first time
  // takes the id from the file entry it is leaving, and one already stale
  // keeps the id it was recorded with. Without this a carried-over key could
  // never be tied back to a page again, and scripts/export-run.ts would count
  // it as unexplained for ever. Files last, so the more recent record wins.
  const notionId = new Map<string, string>();
  for (const s of previousStale) {
    if (s.notion_id) notionId.set(s.key, s.notion_id);
  }
  for (const f of previousFiles) notionId.set(f.key, f.notion_id);

  const seen = new Set<string>();
  const stale: StaleEntry[] = [];
  for (const { key } of [...previousFiles, ...previousStale]) {
    if (seen.has(key) || exportedKeys.has(key) || failedKeys.has(key)) continue;
    seen.add(key);
    const id = notionId.get(key);
    stale.push({
      key,
      since: since.get(key) ?? now,
      ...(id ? { notion_id: id } : {})
    });
  }
  stale.sort(byKey);

  return {
    next: { exported_at: now, files, stale },
    stale: stale.map((s) => s.key)
  };
}

// Forget keys whose objects were actually deleted from R2.
export function pruneKeys(manifest: Manifest, pruned: string[]): Manifest {
  const gone = new Set(pruned);
  return {
    ...manifest,
    stale: manifest.stale.filter((s) => !gone.has(s.key))
  };
}

// A run is suspicious when it exported nothing or when more than a fifth of
// the tracked corpus (the threshold never drops below five) went stale at
// once (ceil: 76 tracked objects tolerate 16 stale, 17 trips it): Notion
// returned an incomplete page set (integration un-shared, wrong root,
// permission change) far more often than a fifth of the SOPs were deleted.
// The export refuses to prune on such a run and exits non-zero so the
// scheduled sync goes red instead of silently emptying the index. A
// legitimate bulk deletion trips it too; the export's --force flag is the
// documented way past it once the stale list has been read.
export function suspiciousDrop(
  trackedFiles: number,
  exported: number,
  stale: number
): boolean {
  return exported === 0 || stale > Math.max(5, Math.ceil(trackedFiles * 0.2));
}
