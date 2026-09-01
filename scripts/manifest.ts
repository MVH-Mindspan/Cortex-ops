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

export type StaleEntry = { key: string; since: string };

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
// keep their original `since` so a later --prune run still sees them.
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
  const seen = new Set<string>();
  const stale: StaleEntry[] = [];
  for (const { key } of [...previousFiles, ...previousStale]) {
    if (seen.has(key) || exportedKeys.has(key) || failedKeys.has(key)) continue;
    seen.add(key);
    stale.push({ key, since: since.get(key) ?? now });
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
