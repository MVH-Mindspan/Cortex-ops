// Export Notion SOPs to markdown with YAML frontmatter and sync them to R2.
// Run: npm run export  (requires NOTION_TOKEN and NOTION_SOP_ROOT, e.g. via .env)
// Stale R2 objects (pages renamed, archived, emptied or deleted in Notion) are
// listed on every run and deleted only with: npm run export -- --prune
//
// Runs on Node 24 native type stripping: erasable TS syntax only.

import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
import { pruneKeys, reconcileManifest } from "./manifest.ts";
import type { Manifest, ManifestFile } from "./manifest.ts";
import { slugify, uniqueSlug } from "./slug.ts";

const BUCKET = "cortex-sops";
const EXPORT_DIR = path.resolve("export");
// Committed record of what this script has put in R2: wrangler can put and
// delete objects but cannot list them, so this is how stale ones are found.
const MANIFEST_PATH = fileURLToPath(
  new URL("./sops-manifest.json", import.meta.url)
);

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

function parseArgs(argv: string[]): { prune: boolean } {
  const unknown = argv.filter((arg) => arg !== "--prune");
  if (unknown.length > 0) {
    console.error(
      `Unknown argument(s): ${unknown.join(" ")}. Usage: npm run export [-- --prune]`
    );
    process.exit(1);
  }
  return { prune: argv.includes("--prune") };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isErrno(err: unknown, code: string): boolean {
  return err instanceof Error && "code" in err && err.code === code;
}

async function readManifest(): Promise<Manifest | null> {
  let raw: string;
  try {
    raw = await readFile(MANIFEST_PATH, "utf8");
  } catch (err) {
    if (isErrno(err, "ENOENT")) return null;
    throw err;
  }
  return JSON.parse(raw) as Manifest;
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
  const { prune } = parseArgs(process.argv.slice(2));
  const token = requireEnv("NOTION_TOKEN");
  const rootRaw = requireEnv("NOTION_SOP_ROOT");
  const rootId = extractNotionId(rootRaw) ?? rootRaw;
  // Read up front so an unreadable manifest fails before any Notion call.
  const previous = await readManifest();

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
  let discoveryComplete = true;
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
      discoveryComplete = false;
      rows.push({
        page: titleOf(page),
        status: "failed",
        detail: `listing child pages: ${messageOf(err)}`
      });
    }
  }

  await mkdir(EXPORT_DIR, { recursive: true });
  const usedSlugs = new Set<string>();
  const exportedFiles: ManifestFile[] = [];
  const failedKeys = new Set<string>();

  // Sorted by page id so slug-collision suffixes go to the same pages on every
  // run, whatever order Notion returned them in.
  const ordered = [...pages.values()].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  );

  // Serialized on purpose: Notion allows ~3 requests/second and notion-to-md
  // issues one children.list call per nested block.
  for (const page of ordered) {
    const title = titleOf(page);
    if (page.in_trash || page.archived) {
      rows.push({
        page: title,
        status: "skipped",
        detail: "archived or in trash"
      });
      continue;
    }
    // Key before conversion, so a page that fails to convert still has one.
    const key = `${uniqueSlug(slugify(title), page.id, usedSlugs)}.md`;
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

      const filePath = path.join(EXPORT_DIR, key);
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
          `${BUCKET}/${key}`,
          "--file",
          filePath,
          "--content-type",
          "text/markdown; charset=utf-8",
          "--remote"
        ],
        { stdio: ["ignore", "ignore", "pipe"] }
      );

      exportedFiles.push({
        key,
        title,
        notion_id: page.id,
        last_edited: page.last_edited_time
      });
      rows.push({ page: title, status: "exported", detail: key });
      console.log(`exported ${key}`);
    } catch (err) {
      // The page's old object stays in R2 and must not be pruned: under this
      // key, or under its previous key if the page was renamed as well.
      failedKeys.add(key);
      for (const f of previous?.files ?? []) {
        if (f.notion_id === page.id) failedKeys.add(f.key);
      }
      rows.push({
        page: title,
        status: "failed",
        detail: messageOf(err).slice(0, 120)
      });
    }
  }

  if (!discoveryComplete) {
    // Some child pages could not be listed, so this run's page set is
    // incomplete: keep every previously exported object rather than flagging
    // the unlisted children as stale and deleting them on --prune.
    for (const f of previous?.files ?? []) failedKeys.add(f.key);
    console.log(
      "Child page listing failed for at least one page; keeping all previously exported objects instead of marking any stale."
    );
  }

  const exported = rows.filter((r) => r.status === "exported").length;
  const skipped = rows.filter((r) => r.status === "skipped").length;
  const failed = rows.filter((r) => r.status === "failed").length;
  console.table(rows);

  const now = new Date().toISOString();
  const { next, stale } = reconcileManifest(
    previous,
    exportedFiles,
    failedKeys,
    now
  );
  let manifest = next;
  const pruned: string[] = [];
  if (stale.length > 0) {
    console.log(
      `${stale.length} stale object(s) in R2: no longer produced by this export (page renamed, archived, emptied or deleted in Notion) but still indexed and citable until deleted.`
    );
    for (const key of stale) console.log(`  ${key}`);
    if (prune) {
      for (const key of stale) {
        try {
          execFileSync(
            "npx",
            [
              "wrangler",
              "r2",
              "object",
              "delete",
              `${BUCKET}/${key}`,
              "--remote"
            ],
            { stdio: ["ignore", "ignore", "pipe"] }
          );
          pruned.push(key);
          console.log(`deleted ${key}`);
        } catch (err) {
          console.error(
            `failed to delete ${key} (still listed as stale): ${messageOf(err).slice(0, 200)}`
          );
          process.exitCode = 1;
        }
      }
      manifest = pruneKeys(next, pruned);
    }
  }
  // Always written, so the next run knows what this one left in R2.
  await writeFile(
    MANIFEST_PATH,
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8"
  );
  console.log(
    `Wrote ${path.relative(process.cwd(), MANIFEST_PATH)}; commit it with this export.`
  );

  console.log(`Exported ${exported}, skipped ${skipped}, failed ${failed}.`);
  if (prune) {
    console.log(
      `Stale objects: ${stale.length}, pruned ${pruned.length}, still in R2 ${stale.length - pruned.length}.`
    );
  } else {
    console.log(
      `Stale objects still in R2: ${stale.length}${stale.length > 0 ? " (dry run: run with --prune to delete them)" : ""}.`
    );
  }
  console.log(
    "R2 is not the index: run `npx wrangler ai-search jobs create cortex` to reindex."
  );
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(messageOf(err));
  process.exit(1);
});
