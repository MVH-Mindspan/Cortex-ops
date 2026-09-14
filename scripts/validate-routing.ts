// Check a team directory against the Department Routing Map's "Do not send
// them" lists and print what it finds, most severe first. The export runs the
// same check (scripts/routing-check.ts) before every upload; this re-checks
// the files a dry run wrote, e.g. while editing rows in Notion:
//
//   npm run export-personas -- --dry-run && npm run validate-routing
//
// Arguments: [directory.json] [routing-exclusions.json], defaulting to the
// dry run's export/ files. Exits 1 when a row has an error or the directory
// is over the prompt ceiling.
//
// Runs on Node 24 native type stripping: erasable TS syntax only.

import { readFile } from "node:fs/promises";
import { parseDirectory } from "../src/lib/personas.ts";
import type { RoutingDepartment } from "./persona-parse.ts";
import { checkDirectory, formatIssues } from "./routing-check.ts";

async function main(): Promise<void> {
  const [
    directoryPath = "export/team-directory.json",
    routingPath = "export/routing-exclusions.json"
  ] = process.argv.slice(2);
  const directory = parseDirectory(
    JSON.parse(await readFile(directoryPath, "utf8"))
  );
  if (!directory) {
    console.error(
      `${directoryPath} is not a team directory this version of Cortex can read.`
    );
    process.exit(1);
  }
  const departments = JSON.parse(
    await readFile(routingPath, "utf8")
  ) as RoutingDepartment[];
  const result = checkDirectory(directory.personas, departments);
  for (const line of formatIssues(result)) console.log(line);
  if (result.blocked || result.issues.some((i) => i.level === "error")) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
