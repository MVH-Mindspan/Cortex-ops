// Stable, unique R2 keys for exported SOP pages. Pure module (no imports) so
// it can be unit-tested with node:test.

export function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "untitled"
  );
}

// First the plain slug, then slug-<8 chars of the page id>, then numbered
// suffixes — checked against `used` every time, so two pages can never share
// a key. Reserves the returned slug.
export function uniqueSlug(
  base: string,
  pageId: string,
  used: Set<string>
): string {
  const withId = `${base}-${pageId.replace(/-/g, "").slice(0, 8)}`;
  let slug = base;
  if (used.has(slug)) slug = withId;
  for (let n = 2; used.has(slug); n++) slug = `${withId}-${n}`;
  used.add(slug);
  return slug;
}
