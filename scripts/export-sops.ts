// Export Notion SOPs to markdown with YAML frontmatter and sync them to R2.
// Run: npm run export  (requires NOTION_TOKEN and NOTION_SOP_ROOT, e.g. via .env)
//
// Runs on Node 24 native type stripping: erasable TS syntax only.

import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  APIErrorCode,
  Client,
  extractNotionId,
  isFullPage,
  isNotionClientError,
  iterateAllDataSourceRows,
  iteratePaginatedAPI
} from "@notionhq/client";
import type { PageObjectResponse } from "@notionhq/client";
import matter from "gray-matter";
import { NotionToMarkdown } from "notion-to-md";

const BUCKET = "cortex-sops";
const EXPORT_DIR = path.resolve("export");

type Row = {
  page: string;
  status: "exported" | "skipped" | "failed";
  detail: string;
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(
      `Missing ${name}. Create a .env file at the repo root with NOTION_TOKEN and NOTION_SOP_ROOT, then re-run npm run export.`
    );
    process.exit(1);
  }
  return value;
}

function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "untitled"
  );
}

function titleOf(page: PageObjectResponse): string {
  for (const prop of Object.values(page.properties)) {
    if (prop.type === "title") {
      const text = prop.title
        .map((t) => t.plain_text)
        .join("")
        .trim();
      if (text) return text;
    }
  }
  return "Untitled";
}

function categoryOf(page: PageObjectResponse): string {
  const prop = page.properties["Category"];
  return prop?.type === "select"
    ? (prop.select?.name ?? "uncategorized")
    : "uncategorized";
}

function ownerOf(page: PageObjectResponse): string {
  const prop = page.properties["Owner"];
  if (prop?.type !== "people") return "";
  return prop.people
    .map((u) => ("name" in u && u.name ? u.name : ""))
    .filter(Boolean)
    .join(", ");
}

async function main(): Promise<void> {
  const token = requireEnv("NOTION_TOKEN");
  const rootRaw = requireEnv("NOTION_SOP_ROOT");
  const rootId = extractNotionId(rootRaw) ?? rootRaw;

  const notion = new Client({ auth: token });
  const n2m = new NotionToMarkdown({
    notionClient: notion,
    config: { parseChildPages: false }
  });
  // Retrieval is text-driven and Notion image URLs expire: drop images entirely.
  n2m.setCustomTransformer("image", async () => "");
  // Note: no transformer for synced_block — notion-to-md resolves synced blocks
  // to their source content natively, and a custom transformer would disable that.

  // Collect top-level SOP pages: every row if the root is a database, else the
  // root page itself. Then recurse into child pages exactly one level.
  const topLevel: PageObjectResponse[] = [];
  let rootKind = "database";
  try {
    const db = await notion.databases.retrieve({ database_id: rootId });
    const dataSources = "data_sources" in db ? db.data_sources : [];
    for (const source of dataSources) {
      for await (const row of iterateAllDataSourceRows(notion, {
        data_source_id: source.id
      })) {
        if (row.object === "page" && isFullPage(row)) topLevel.push(row);
      }
    }
  } catch (err) {
    if (isNotionClientError(err) && err.code === APIErrorCode.ObjectNotFound) {
      rootKind = "page";
      const page = await notion.pages.retrieve({ page_id: rootId });
      if (!isFullPage(page))
        throw new Error("Root page returned a partial response");
      topLevel.push(page);
    } else {
      throw err;
    }
  }
  console.log(
    `Root ${rootId} is a ${rootKind}; found ${topLevel.length} top-level page(s).`
  );

  const rows: Row[] = [];
  const pages = new Map<string, PageObjectResponse>();
  for (const page of topLevel) pages.set(page.id, page);

  // One level of child pages under each top-level page.
  for (const page of topLevel) {
    try {
      for await (const block of iteratePaginatedAPI(
        notion.blocks.children.list,
        {
          block_id: page.id
        }
      )) {
        if (
          "type" in block &&
          block.type === "child_page" &&
          !pages.has(block.id)
        ) {
          const child = await notion.pages.retrieve({ page_id: block.id });
          if (isFullPage(child)) pages.set(child.id, child);
        }
      }
    } catch (err) {
      rows.push({
        page: titleOf(page),
        status: "failed",
        detail: `listing child pages: ${err instanceof Error ? err.message : String(err)}`
      });
    }
  }

  await mkdir(EXPORT_DIR, { recursive: true });
  const usedSlugs = new Set<string>();

  // Serialized on purpose: Notion allows ~3 requests/second and notion-to-md
  // issues one children.list call per nested block.
  for (const page of pages.values()) {
    const title = titleOf(page);
    if (page.in_trash || page.archived) {
      rows.push({
        page: title,
        status: "skipped",
        detail: "archived or in trash"
      });
      continue;
    }
    try {
      const mdBlocks = await n2m.pageToMarkdown(page.id);
      const markdown = n2m.toMarkdownString(mdBlocks).parent ?? "";
      if (!markdown.trim()) {
        rows.push({
          page: title,
          status: "skipped",
          detail: "page has no convertible content"
        });
        continue;
      }

      let slug = slugify(title);
      if (usedSlugs.has(slug))
        slug = `${slug}-${page.id.replace(/-/g, "").slice(0, 8)}`;
      usedSlugs.add(slug);

      // Object form on purpose: string input would be re-parsed as frontmatter,
      // and a Notion divider renders as a leading "---" which would corrupt it.
      const body = matter.stringify(
        { content: `\n${markdown.trim()}\n` },
        {
          title,
          source_url: page.url,
          category: categoryOf(page),
          owner: ownerOf(page),
          last_edited: page.last_edited_time
        }
      );

      const filename = `${slug}.md`;
      const filePath = path.join(EXPORT_DIR, filename);
      await writeFile(filePath, body, "utf8");

      // --remote is required: without it wrangler writes to the local Miniflare
      // simulation and exits 0 with nothing in the real bucket.
      execFileSync(
        "npx",
        [
          "wrangler",
          "r2",
          "object",
          "put",
          `${BUCKET}/${filename}`,
          "--file",
          filePath,
          "--content-type",
          "text/markdown; charset=utf-8",
          "--remote"
        ],
        { stdio: ["ignore", "ignore", "pipe"] }
      );

      rows.push({ page: title, status: "exported", detail: filename });
      console.log(`exported ${filename}`);
    } catch (err) {
      rows.push({
        page: title,
        status: "failed",
        detail: err instanceof Error ? err.message.slice(0, 120) : String(err)
      });
    }
  }

  const exported = rows.filter((r) => r.status === "exported").length;
  const skipped = rows.filter((r) => r.status === "skipped").length;
  const failed = rows.filter((r) => r.status === "failed").length;
  console.table(rows);
  console.log(`Exported ${exported}, skipped ${skipped}, failed ${failed}.`);
  console.log(
    "Note: pages deleted in Notion are not removed from R2 by this script; delete stale objects manually if needed."
  );
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
