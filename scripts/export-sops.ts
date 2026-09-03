// Export Notion SOPs to markdown with YAML frontmatter and sync them to R2.
// Run: npm run export  (requires NOTION_TOKEN and NOTION_SOP_ROOT, e.g. via .env)
// --dry-run converts every page and writes export/ but touches neither R2 nor
// the manifest. Stale R2 objects (pages renamed, archived, emptied, deleted or
// newly excluded in Notion) are listed on every run and deleted only with
// --prune; --force overrides the guard that refuses to prune a run whose page
// set looks incomplete. A scheduled GitHub Actions workflow runs this and its
// logs are public: only page titles and object keys are printed, page bodies
// never are, and Notion ids inside error text are redacted.
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
import { exportDecision } from "./export-filter.ts";
import { unexplainedStale } from "./export-run.ts";
import { pruneKeys, reconcileManifest, suspiciousDrop } from "./manifest.ts";
import type { Manifest, ManifestFile } from "./manifest.ts";
import {
  categoriesOf,
  ownerOf,
  primaryCategory,
  statusOf,
  titleOf,
  useWhenOf
} from "./notion-props.ts";
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
  outcome: "exported" | "skipped" | "failed";
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

function parseArgs(argv: string[]): {
  prune: boolean;
  dryRun: boolean;
  force: boolean;
} {
  const known = ["--prune", "--dry-run", "--force"];
  const unknown = argv.filter((arg) => !known.includes(arg));
  if (unknown.length > 0) {
    console.error(
      `Unknown argument(s): ${unknown.join(" ")}. Usage: npm run export [-- --dry-run | --prune [--force]]`
    );
    process.exit(1);
  }
  const prune = argv.includes("--prune");
  const dryRun = argv.includes("--dry-run");
  const force = argv.includes("--force");
  if (dryRun && prune) {
    console.error(
      "--dry-run cannot be combined with --prune: a dry run never deletes anything."
    );
    process.exit(1);
  }
  if (force && !prune) {
    console.error(
      "--force only means anything with --prune: it overrides the guard that blocks a prune."
    );
    process.exit(1);
  }
  return { prune, dryRun, force };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Notion quotes the id of the page or block that failed in its error text.
// This runs in a workflow whose logs are public, so ids are stripped before
// any error reaches them (dashed and undashed, both forms Notion returns).
function redactIds(message: string): string {
  return message.replace(
    /[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    "<id>"
  );
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

async function main(): Promise<void> {
  const { prune, dryRun, force } = parseArgs(process.argv.slice(2));
  const token = requireEnv("NOTION_TOKEN");
  const rootRaw = requireEnv("NOTION_SOP_ROOT");
  const rootId = extractNotionId(rootRaw) ?? rootRaw;
  // Read up front so an unreadable manifest fails before any Notion call.
  const previous = await readManifest();
  const previousFiles = previous?.files ?? [];

  // Every change this script makes to the bucket goes through these two, so
  // --dry-run bypasses R2 by returning here rather than by threading a flag
  // through the export and prune loops.
  // --remote is required: without it wrangler writes to the local Miniflare
  // simulation and exits 0 with nothing in the real bucket.
  function put(key: string, filePath: string): void {
    if (dryRun) return;
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
  }
  function remove(key: string): void {
    if (dryRun) return;
    execFileSync(
      "npx",
      ["wrangler", "r2", "object", "delete", `${BUCKET}/${key}`, "--remote"],
      { stdio: ["ignore", "ignore", "pipe"] }
    );
  }

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
    `Root is a ${rootKind}; found ${topLevel.length} top-level page(s).`
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
        page: titleOf(page.properties),
        outcome: "failed",
        detail: `listing child pages: ${redactIds(messageOf(err)).slice(0, 120)}`
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
    const title = titleOf(page.properties);
    if (page.in_trash || page.archived) {
      rows.push({
        page: title,
        outcome: "skipped",
        detail: "archived or in trash"
      });
      continue;
    }
    const categories = categoriesOf(page.properties);
    const decision = exportDecision({ id: page.id, title, categories });
    if (!decision.export) {
      rows.push({
        page: title,
        outcome: "skipped",
        detail: `excluded: ${decision.reason}`
      });
      continue;
    }
    const useWhen = useWhenOf(page.properties);
    // Key before conversion, so a page that fails to convert still has one.
    const key = `${uniqueSlug(slugify(title), page.id, usedSlugs)}.md`;
    try {
      const mdBlocks = await n2m.pageToMarkdown(page.id);
      const markdown = n2m.toMarkdownString(mdBlocks).parent ?? "";
      if (!markdown.trim()) {
        rows.push({
          page: title,
          outcome: "skipped",
          detail: "page has no convertible content"
        });
        continue;
      }

      const owner = ownerOf(page.properties);
      // Object form on purpose: string input would be re-parsed as frontmatter,
      // and a Notion divider renders as a leading "---" which would corrupt it.
      const body = matter.stringify(
        { content: `\n${markdown.trim()}\n` },
        {
          title,
          source_url: page.url,
          category: primaryCategory(categories),
          categories,
          status: statusOf(page.properties), // "" when unset; never invent Approved
          use_when: useWhen,
          // The SOP database has no Owner property, so an empty owner is
          // omitted rather than written as an empty string.
          ...(owner ? { owner } : {}),
          last_edited: page.last_edited_time
        }
      );

      const filePath = path.join(EXPORT_DIR, key);
      await writeFile(filePath, body, "utf8");
      put(key, filePath);

      exportedFiles.push({
        key,
        title,
        notion_id: page.id,
        last_edited: page.last_edited_time
      });
      let detail = key;
      if (decision.warning) detail += ` (warning: ${decision.warning})`;
      // A hint naming a Slack channel or a person is a steer, not a procedure:
      // worth a look on the next pass, but not worth dropping the page over.
      if (/#[a-z][a-z0-9_-]{2,}|@[a-z]/i.test(useWhen)) {
        detail += " (hint names a channel or person)";
      }
      rows.push({ page: title, outcome: "exported", detail });
      console.log(`${dryRun ? "would upload" : "exported"} ${key}`);
    } catch (err) {
      // The page's old object stays in R2 and must not be pruned: under this
      // key, or under its previous key if the page was renamed as well.
      failedKeys.add(key);
      for (const f of previousFiles) {
        if (f.notion_id === page.id) failedKeys.add(f.key);
      }
      rows.push({
        page: title,
        outcome: "failed",
        detail: redactIds(messageOf(err)).slice(0, 120)
      });
    }
  }

  if (!discoveryComplete) {
    // Some child pages could not be listed, so this run's page set is
    // incomplete: keep every previously exported object rather than flagging
    // the unlisted children as stale and deleting them on --prune.
    for (const f of previousFiles) failedKeys.add(f.key);
    console.log(
      "Child page listing failed for at least one page; keeping all previously exported objects instead of marking any stale."
    );
  }

  const exported = rows.filter((r) => r.outcome === "exported").length;
  const skipped = rows.filter((r) => r.outcome === "skipped").length;
  const failed = rows.filter((r) => r.outcome === "failed").length;
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

  // Count only the stale keys this run cannot explain. Every page this run
  // listed counts as seen, exported or skipped: a page the run saw but chose
  // to skip is an explained absence; a page that vanished from Notion, or a
  // key whose entry carries no id, is not.
  const seenIds = new Set(pages.keys());
  const unexplained = unexplainedStale(next.stale, seenIds);
  const unexplainedSet = new Set(unexplained);
  const suspicious = suspiciousDrop(
    previousFiles.length,
    exportedFiles.length,
    unexplained.length
  );
  const blocked = suspicious && !force;

  if (stale.length > 0) {
    console.log(
      `${stale.length} stale object(s) in R2: no longer produced by this export (page renamed, archived, emptied or deleted in Notion) but still indexed and citable until deleted.`
    );
    for (const key of stale) {
      const note = unexplainedSet.has(key)
        ? "  (unexplained: page not seen this run)"
        : "";
      console.log(`  ${key}${note}`);
    }
  }
  if (blocked) {
    // A run that exported nothing has no stale arithmetic worth reciting.
    const headline =
      exportedFiles.length === 0
        ? `Suspicious drop: the export produced no files (tracked ${previousFiles.length}).`
        : `Suspicious drop: ${unexplained.length} of ${stale.length} stale object(s) cannot be explained by pages this run saw (tracked ${previousFiles.length}, exported ${exportedFiles.length}).`;
    console.error(
      `${headline} This usually means Notion returned an incomplete page set. ${dryRun ? "Nothing was uploaded and the manifest was not written (dry run)" : "The uploads above happened and the manifest was written"}; only pruning is withheld. If the pages really are gone, read the list above and run npm run export -- --prune --force locally.`
    );
    process.exitCode = 1;
  } else if (suspicious) {
    console.warn(
      `Suspicious drop overridden with --force: pruning ${stale.length} object(s), ${unexplained.length} unexplained.`
    );
  }

  if (prune && !blocked) {
    for (const key of stale) {
      try {
        remove(key);
        pruned.push(key);
        console.log(`${dryRun ? "would delete" : "deleted"} ${key}`);
      } catch (err) {
        console.error(
          `failed to delete ${key} (still listed as stale): ${redactIds(messageOf(err)).slice(0, 200)}`
        );
        process.exitCode = 1;
      }
    }
    manifest = pruneKeys(next, pruned);
  }

  if (!dryRun) {
    // Always written, so the next run knows what this one left in R2.
    await writeFile(
      MANIFEST_PATH,
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8"
    );
    console.log(
      `Wrote ${path.relative(process.cwd(), MANIFEST_PATH)}; commit it with this export.`
    );
  }

  console.log(`Exported ${exported}, skipped ${skipped}, failed ${failed}.`);
  if (prune) {
    console.log(
      `Stale objects: ${stale.length}, pruned ${pruned.length}, still in R2 ${stale.length - pruned.length}.`
    );
  } else {
    console.log(
      `Stale objects still in R2: ${stale.length}${stale.length > 0 ? " (run with --prune to delete them)" : ""}.`
    );
  }
  console.log(
    "R2 is not the index: run `npx wrangler ai-search jobs create cortex` to reindex."
  );
  if (dryRun) console.log("Dry run: nothing uploaded, manifest untouched.");
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(redactIds(messageOf(err)).slice(0, 300));
  process.exit(1);
});
