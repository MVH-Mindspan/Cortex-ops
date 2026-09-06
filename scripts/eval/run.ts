// Retrieval eval runner: the IO half. Drives the local eval Worker
// (scripts/eval/worker.ts, started by `npm run eval:dev`) over a matrix of
// retrieval configs and the questions in questions.json, then writes a markdown
// report and a JSON sidecar to docs/eval/. Everything it decides — the matrix,
// the scoring, the report — lives in report.ts and is unit-tested there.
//
// Run: npm run eval -- --mode retrieval
// Flags: --base http://127.0.0.1:8790  --out docs/eval/<date>-retrieval.md
//        --configs on/15/and,on/30/or  (default: the full 12-config matrix)
//
// Every request costs an AI Search query and reranker neurons from the same
// daily pool as production. Read docs/eval/README.md before running the matrix.
//
// Runs on Node 24 native type stripping: erasable TS syntax only.

import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  askOf,
  cell,
  configMismatch,
  keywordRankOf,
  label,
  parseConfigs,
  rankOf,
  renderReport,
  resolvedLabel,
  turnsOf,
  type Config,
  type EvalRecord,
  type Question,
  type SearchOut
} from "./report.ts";

const DEFAULT_BASE = "http://127.0.0.1:8790";
const FLAGS = ["--base", "--mode", "--out", "--configs"];
// Workers AI error for the exhausted daily neuron allocation. Continuing past
// it burns wall-clock on requests that can only fail.
const ALLOCATION_RE = /7094|allocation/i;
// AI Search rate-limits bursts while it is in open beta, and a matrix run is a
// burst by definition. The Worker retries a rate-limited search, but pacing
// the client is what stops it having to.
const REQUEST_GAP_MS = 250;
// Enough to tell "wrangler died" from "one request went wrong".
const MAX_CONNECT_FAILURES = 3;
// A provider error can be kilobytes of JSON, and the sidecar is committed.
const ERROR_CHARS = 200;

/** fetch rejected outright: nothing is listening, or wrangler dev has gone
 * away. Distinguished from an HTTP error so a dead Worker stops the run
 * instead of failing every remaining cell one by one. */
class ConnectionError extends Error {}

function argValue(argv: string[], flag: string): string | null {
  const at = argv.indexOf(flag);
  if (at < 0) return null;
  const value = argv[at + 1];
  // A missing value would otherwise swallow the next flag as its argument.
  if (value === undefined || value.startsWith("--")) {
    fail(`${flag} needs a value`);
  }
  return value;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function clip(text: string): string {
  return text.length > ERROR_CHARS ? `${text.slice(0, ERROR_CHARS)}…` : text;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function search(
  base: string,
  question: Question,
  cfg: Config
): Promise<SearchOut> {
  let response: Response;
  try {
    response = await fetch(`${base}/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: turnsOf(question), config: cfg })
    });
  } catch (err) {
    throw new ConnectionError(err instanceof Error ? err.message : String(err));
  }
  const text = await response.text();
  if (!response.ok) {
    let detail = text;
    try {
      detail = (JSON.parse(text) as { error?: string }).error ?? text;
    } catch {
      // Not JSON (wrangler itself errored): keep the body as the message.
    }
    throw new Error(`${response.status} ${clip(detail)}`);
  }
  return JSON.parse(text) as SearchOut;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    if (!FLAGS.includes(argv[i])) {
      fail(`Unknown flag "${argv[i]}". Known: ${FLAGS.join(" ")}`);
    }
    i++; // Skip the value, so a value that looks like a flag is not checked.
  }
  const mode = argValue(argv, "--mode") ?? "retrieval";
  if (mode !== "retrieval") {
    fail(`Unknown --mode "${mode}". Only "retrieval" exists so far.`);
  }
  const base = (argValue(argv, "--base") ?? DEFAULT_BASE).replace(/\/+$/, "");
  const date = new Date().toISOString().slice(0, 10);
  const mdPath = path.resolve(
    argValue(argv, "--out") ?? `docs/eval/${date}-retrieval.md`
  );
  const jsonPath = `${mdPath.replace(/\.md$/, "")}.json`;
  let configs: Config[];
  try {
    configs = parseConfigs(argValue(argv, "--configs"));
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }

  const questions = JSON.parse(
    await readFile(new URL("./questions.json", import.meta.url), "utf8")
  ) as Question[];

  const records: EvalRecord[] = [];
  let halted: string | null = null;
  let connectFailures = 0;
  console.error(
    `${configs.length * questions.length} searches: ${configs.length} configs` +
      ` × ${questions.length} questions.`
  );

  for (const cfg of configs) {
    const config = label(cfg);
    if (halted) break;
    for (const question of questions) {
      await delay(REQUEST_GAP_MS);
      let out: SearchOut;
      try {
        out = await search(base, question, cfg);
        connectFailures = 0;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (err instanceof ConnectionError) {
          connectFailures++;
          if (connectFailures >= MAX_CONNECT_FAILURES) {
            halted =
              `${MAX_CONNECT_FAILURES} requests in a row could not reach` +
              ` ${base} (${message}). Is \`npm run eval:dev\` still running?`;
            console.error(`\nStopped: ${halted}`);
            break;
          }
        }
        if (ALLOCATION_RE.test(message)) {
          halted =
            `the daily Workers AI neuron allocation is exhausted (${message}).` +
            ` Reranking cannot run until it resets, so the remaining configs` +
            ` were skipped.`;
          console.error(`\nStopped: ${halted}`);
          break;
        }
        console.error(`  ${config} ${question.id}: ${message}`);
        records.push({
          config,
          id: question.id,
          block: question.block,
          expected: question.expected,
          rank: null,
          matched: null,
          files: 0,
          keywordRank: null,
          rewritten: false,
          ms: 0,
          attempts: 0,
          top3: [],
          resolved: null,
          error: clip(message)
        });
        continue;
      }
      // A Worker running a different config than the one asked for would file
      // every number under the wrong heading. Nothing salvageable: stop.
      const mismatch = configMismatch(cfg, out.config);
      if (mismatch) fail(`Config mismatch on ${question.id}: ${mismatch}`);
      const { rank, matched } = rankOf(out.ranked, question.expected);
      records.push({
        config,
        id: question.id,
        block: question.block,
        expected: question.expected,
        rank,
        matched,
        files: out.ranked.length,
        keywordRank: keywordRankOf(out.chunks, matched),
        rewritten: out.search_query.trim() !== askOf(question).trim(),
        ms: out.ms,
        attempts: out.attempts,
        top3: out.ranked.slice(0, 3).map((file) => file.file ?? "?"),
        resolved: resolvedLabel(out.config),
        error: null
      });
      console.error(
        `  ${config} ${question.id}: ${cell(records.at(-1))} (${out.ms} ms)`
      );
    }
  }

  await mkdir(path.dirname(mdPath), { recursive: true });
  await writeFile(
    mdPath,
    renderReport(questions, configs, records, { base, date, halted }),
    "utf8"
  );
  await writeFile(
    jsonPath,
    `${JSON.stringify({ date, base, mode, configs: configs.map(label), halted, records }, null, 2)}\n`,
    "utf8"
  );
  // Both files are committed, and `npm run check` runs `oxfmt --check .`. A
  // formatting failure must not hide where the run's results ended up.
  try {
    execFileSync("npx", ["oxfmt", "--write", mdPath, jsonPath], {
      stdio: ["ignore", "ignore", "pipe"]
    });
  } catch (err) {
    console.error(
      `Warning: oxfmt failed, run it by hand before committing` +
        ` (${err instanceof Error ? err.message : String(err)}).`
    );
  }
  console.log(mdPath);
  if (halted || records.some((record) => record.error)) process.exitCode = 1;
}

await main();
