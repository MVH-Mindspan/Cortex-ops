// Export the Notion "Team Directory (Cortex)" database to the private R2
// bucket cortex-directory as team-directory.json, which the Worker reads per
// answer (src/lib/personas.ts). Run: npm run export-personas (requires
// NOTION_TOKEN and NOTION_PERSONA_ROOT, e.g. via .env).
// --dry-run reads Notion and writes export/ but does not upload.
//
// Only Live rows are exported. The Department Routing Map page is read too,
// and every row is checked against it (scripts/routing-check.ts) before the
// upload. Nothing is uploaded when a page fails to read, no row is usable, or
// the directory renders over the prompt ceiling: the last good object stays
// live. A row with an error is left out and the rest go up; the run still
// exits non-zero so the Sync SOPs job shows red.
//
// The Sync SOPs workflow runs this nightly and its logs are public, and this
// repo is public: persona names and page bodies are never printed (a row is
// named by its Title), and the export/ files never leave the runner.
//
// Runs on Node 24 native type stripping: erasable TS syntax only.

import { execFileSync } from "node:child_process";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  APIErrorCode,
  Client,
  extractNotionId,
  isFullPage,
  isNotionClientError,
  iterateAllDataSourceRows
} from "@notionhq/client";
import type { PageObjectResponse } from "@notionhq/client";
import { NotionToMarkdown } from "notion-to-md";
import { DIRECTORY_KEY, DIRECTORY_VERSION } from "../src/lib/personas.ts";
import type { Directory, Persona } from "../src/lib/personas.ts";
import {
  multiSelectOf,
  richTextOf,
  selectOf,
  statusOf,
  titleOf
} from "./notion-props.ts";
import { personaFrom, routingDepartmentsFrom } from "./persona-parse.ts";
import type { RoutingDepartment } from "./persona-parse.ts";
import { redactIds } from "./redact.ts";
import { checkDirectory, formatIssues } from "./routing-check.ts";

const BUCKET = "cortex-directory";
const EXPORT_DIR = path.resolve("export");
// "Department Routing Map (Cortex)" in the Ops Document Hub: the source of the
// "Do not send them" lists. A Hub row, so the SOP export's integration can
// read it (the SOP export itself skips it; see export-filter.ts).
const ROUTING_MAP_PAGE = "3ceb5943-d52d-815f-b551-e43a73530969";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(
      `Missing ${name}. Add NOTION_TOKEN and NOTION_PERSONA_ROOT to .env at the repo root, then re-run npm run export-personas.`
    );
    process.exit(1);
  }
  return value;
}

function parseArgs(argv: string[]): { dryRun: boolean } {
  const unknown = argv.filter((arg) => arg !== "--dry-run");
  if (unknown.length > 0) {
    console.error(
      `Unknown argument(s): ${unknown.join(" ")}. Usage: npm run export-personas [-- --dry-run]`
    );
    process.exit(1);
  }
  return { dryRun: argv.includes("--dry-run") };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function summary(lines: string[]): Promise<void> {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  await appendFile(
    file,
    `### Team Directory\n\n${lines.map((line) => `- ${line}`).join("\n")}\n`,
    "utf8"
  );
}

async function main(): Promise<void> {
  const { dryRun } = parseArgs(process.argv.slice(2));
  const token = requireEnv("NOTION_TOKEN");
  const rootRaw = requireEnv("NOTION_PERSONA_ROOT");
  const rootId = extractNotionId(rootRaw) ?? rootRaw;

  const notion = new Client({ auth: token });
  const n2m = new NotionToMarkdown({
    notionClient: notion,
    config: { parseChildPages: false }
  });
  n2m.setCustomTransformer("image", async () => "");
  const markdownOf = async (pageId: string): Promise<string> =>
    n2m.toMarkdownString(await n2m.pageToMarkdown(pageId)).parent ?? "";

  const pages: PageObjectResponse[] = [];
  try {
    const db = await notion.databases.retrieve({ database_id: rootId });
    for (const source of "data_sources" in db ? db.data_sources : []) {
      for await (const row of iterateAllDataSourceRows(notion, {
        data_source_id: source.id
      })) {
        if (row.object === "page" && isFullPage(row)) pages.push(row);
      }
    }
  } catch (err) {
    if (isNotionClientError(err) && err.code === APIErrorCode.ObjectNotFound) {
      console.error(
        "The Team Directory database is not visible to this integration. In Notion, open Team Directory (Cortex) → ••• → Connections and add the export integration."
      );
      process.exit(1);
    }
    throw err;
  }
  // Sorted by page id so the uploaded order, and so the object, is stable.
  pages.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // Serialized on purpose: Notion allows ~3 requests/second.
  const personas: Persona[] = [];
  let skipped = 0;
  let failed = 0;
  for (const page of pages) {
    const props = page.properties;
    if (page.in_trash || page.archived || statusOf(props) !== "Live") {
      skipped += 1;
      continue;
    }
    try {
      personas.push(
        personaFrom({
          name: titleOf(props),
          title: richTextOf(props, "Title"),
          department: selectOf(props, "Department"),
          routingDepartments: multiSelectOf(props, "Routing Department"),
          priority: selectOf(props, "Priority"),
          backup: richTextOf(props, "Backup"),
          slackChannel: richTextOf(props, "Slack Channel"),
          markdown: await markdownOf(page.id)
        })
      );
    } catch (err) {
      failed += 1;
      console.error(
        `failed to read a directory page (${richTextOf(props, "Title") || "untitled row"}): ${redactIds(messageOf(err)).slice(0, 120)}`
      );
    }
  }

  let departments: RoutingDepartment[] = [];
  try {
    departments = routingDepartmentsFrom(await markdownOf(ROUTING_MAP_PAGE));
  } catch (err) {
    console.warn(
      `Could not read the Department Routing Map; routing-map checks skipped: ${redactIds(messageOf(err)).slice(0, 120)}`
    );
  }
  if (departments.length === 0) {
    console.warn(
      "The Department Routing Map has no departments to check against."
    );
  }

  const result = checkDirectory(personas, departments);
  const report = formatIssues(result);
  console.log(
    `Read ${pages.length} row(s): ${personas.length} Live, ${skipped} not Live, ${failed} failed. Routing map: ${departments.length} department(s).`
  );
  for (const line of report) console.log(line);

  const directory: Directory = {
    version: DIRECTORY_VERSION,
    generated_at: new Date().toISOString(),
    personas: result.valid
  };
  await mkdir(EXPORT_DIR, { recursive: true });
  const directoryPath = path.join(EXPORT_DIR, DIRECTORY_KEY);
  await writeFile(
    directoryPath,
    `${JSON.stringify(directory, null, 2)}\n`,
    "utf8"
  );
  await writeFile(
    path.join(EXPORT_DIR, "routing-exclusions.json"),
    `${JSON.stringify(departments, null, 2)}\n`,
    "utf8"
  );

  const withheld =
    failed > 0 ? `${failed} page(s) could not be read` : result.blocked;
  let outcome: string;
  if (withheld) {
    outcome = `Not uploaded (${withheld}); the directory already in R2 stays live.`;
    process.exitCode = 1;
  } else if (dryRun) {
    outcome = `Dry run: wrote ${path.relative(process.cwd(), directoryPath)}; nothing uploaded.`;
  } else {
    // --remote is required: without it wrangler writes to the local Miniflare
    // simulation and exits 0 with nothing in the real bucket.
    execFileSync(
      "npx",
      [
        "wrangler",
        "r2",
        "object",
        "put",
        `${BUCKET}/${DIRECTORY_KEY}`,
        "--file",
        directoryPath,
        "--content-type",
        "application/json; charset=utf-8",
        "--remote"
      ],
      { stdio: ["ignore", "ignore", "pipe"] }
    );
    outcome = `Uploaded ${result.valid.length} persona(s) to ${BUCKET}/${DIRECTORY_KEY}; answers use it within 5 minutes.`;
  }
  if (result.issues.some((issue) => issue.level === "error")) {
    process.exitCode = 1;
  }
  console.log(outcome);
  await summary([outcome, ...report]);
}

main().catch((err) => {
  console.error(redactIds(messageOf(err)).slice(0, 300));
  process.exit(1);
});
