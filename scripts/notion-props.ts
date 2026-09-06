// Reads the Notion page properties the SOP exporter needs: title, status,
// category tags, agent hints and owner. Pure module (a type-only import, so
// no runtime side effects) so it can be unit-tested with node:test.
//
// UNTITLED is the exact fallback titleOf returns for a page with no title
// text. It is load-bearing: scripts/export-filter.ts compares a page's title
// against this same sentinel to drop Notion's blank template stubs from the
// export, so the two must never drift apart.

import type { PageObjectResponse } from "@notionhq/client";

export type Props = PageObjectResponse["properties"];

export const UNTITLED = "Untitled";

function plainText(runs: { plain_text: string }[]): string {
  return runs
    .map((r) => r.plain_text)
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

export function titleOf(props: Props): string {
  for (const prop of Object.values(props)) {
    if (prop?.type === "title") {
      const text = plainText(prop.title);
      if (text) return text;
    }
  }
  return UNTITLED;
}

export function statusOf(props: Props): string {
  const prop = props["Status"];
  if (prop?.type === "select") return prop.select?.name ?? "";
  if (prop?.type === "status") return prop.status?.name ?? "";
  return "";
}

export function categoriesOf(props: Props): string[] {
  const prop = props["Category"];
  if (prop?.type === "multi_select")
    return prop.multi_select.map((s) => s.name);
  if (prop?.type === "select") return prop.select ? [prop.select.name] : [];
  return [];
}

// These category names mirror the Category multi_select options of the
// Notion "Ops Document Hub" database as of 3 Sep 2026. They are
// case-sensitive — "Physical clinic" is the real casing, not "Physical
// Clinic" — and SOP and Reference come first because the SOP library groups
// pages by this value.
export const CATEGORY_PRIORITY = [
  "SOP",
  "Reference",
  "Care Support",
  "All Ops",
  "Expansion Team",
  "Physical clinic",
  "Strategy",
  "Planning"
] as const;

// An unlisted tag falls back to the page's first tag; only a page with no
// tags at all becomes "uncategorized".
export function primaryCategory(categories: string[]): string {
  for (const category of CATEGORY_PRIORITY) {
    if (categories.includes(category)) return category;
  }
  return categories[0] ?? "uncategorized";
}

export function useWhenOf(props: Props): string {
  const prop = props["Use When (Agent Hints)"];
  if (prop?.type !== "rich_text") return "";
  return plainText(prop.rich_text);
}

// The SOP database has no Owner property today; kept for compatibility with
// databases that do.
export function ownerOf(props: Props): string {
  const prop = props["Owner"];
  if (prop?.type !== "people") return "";
  return prop.people
    .map((u) => ("name" in u && u.name ? u.name : ""))
    .filter(Boolean)
    .join(", ");
}
