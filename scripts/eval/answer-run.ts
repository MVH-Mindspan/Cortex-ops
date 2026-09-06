// Live answer batches. Only summaries leave .context: answers, sources and
// provider errors must never be written into public docs or console output.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { gradeAnswer, gradeQuoteWhole } from "./grade.ts";
import { turnsOf, type Question } from "./report.ts";

export function answerBatchAllowed(
  count: number,
  date: Date,
  override: boolean
): boolean {
  const hour = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      hour: "numeric",
      hourCycle: "h23"
    }).format(date)
  );
  return override || (count <= 8 && (hour < 6 || hour >= 20));
}
function value(args: string[], flag: string, fallback: string): string {
  const i = args.indexOf(flag);
  if (i < 0) return fallback;
  if (!args[i + 1] || args[i + 1].startsWith("--"))
    throw new Error(`Missing value for ${flag}`);
  return args[i + 1];
}
export async function runAnswers(args: string[]): Promise<void> {
  const flags = [
    "--mode",
    "--answers",
    "--base",
    "--ids",
    "--out",
    "--without-rules",
    "--use-production-budget"
  ];
  for (let i = 0; i < args.length; i++) {
    if (!flags.includes(args[i])) throw new Error("Unknown answer-eval flag");
    if (!["--without-rules", "--use-production-budget"].includes(args[i])) {
      value(args, args[i], "");
      i++;
    }
  }
  const count = Number(value(args, "--answers", "4"));
  if (!Number.isInteger(count) || count < 1 || count > 100)
    throw new Error("--answers must be 1–100");
  const override = args.includes("--use-production-budget");
  if (!answerBatchAllowed(count, new Date(), override))
    throw new Error(
      "Live answers require outside clinic hours and at most 8 per batch, or --use-production-budget"
    );
  const base = value(args, "--base", "http://127.0.0.1:8790");
  if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(base).hostname))
    throw new Error("Answer eval is local only");
  const rules = !args.includes("--without-rules");
  const questions: Question[] = JSON.parse(
    await readFile(new URL("./questions.json", import.meta.url), "utf8")
  );
  const ids = value(args, "--ids", "D1,R2,R4,B1").split(",");
  const selected = ids.map((id) => {
    const q = questions.find((q) => q.id === id);
    if (!q) throw new Error("Unknown question ID");
    return q;
  });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const report = path.resolve(
    value(args, "--out", `docs/eval/${stamp}-answers.md`)
  );
  if (!report.startsWith(path.resolve("docs/eval") + path.sep))
    throw new Error("Summary report must live in docs/eval");
  const directory = path.resolve(".context/eval", stamp);
  await mkdir(directory, { recursive: true });
  // docs/eval/README.md: an aggregate report is only citable against a known
  // prompt. Record the commit the harness ran, and whether the tree was dirty.
  const revision = execFileSync("git", ["describe", "--always", "--dirty"], {
    encoding: "utf8"
  }).trim();
  const summary: unknown[] = [];
  console.log(
    `Planned: ${count} answers, ${rules ? "rules enabled" : "rules ablation"}. Rough generation estimate: ${count * 590} neurons before retries and retrieval; shared production budget.`
  );
  for (let i = 0; i < count; i++) {
    if (!answerBatchAllowed(count, new Date(), override))
      throw new Error("Clinic hours began; stopping batch");
    const question = selected[i % selected.length];
    const response = await fetch(`${base}/answer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: turnsOf(question), rules }),
      signal: AbortSignal.timeout(180000)
    });
    const output = (await response.json()) as {
      answer?: string;
      error?: string;
      citations?: Parameters<typeof gradeQuoteWhole>[0];
      passages?: Parameters<typeof gradeQuoteWhole>[1];
      stats?: Record<string, unknown>;
      outcome?: {
        degenerate?: boolean;
        truncated?: boolean;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      metadata?: { coverage?: string; coverageBlocked?: string };
      notice?: boolean;
    };
    await writeFile(
      path.join(directory, `${i + 1}-${question.id}.json`),
      JSON.stringify(output, null, 2)
    );
    if (!response.ok || typeof output.answer !== "string") {
      console.error(
        /7094|allocation/i.test(output.error ?? "")
          ? "Allocation exhausted; stopped. No further requests."
          : "Eval request failed; stopped. Details remain in .context."
      );
      summary.push({ id: question.id, error: true });
      process.exitCode = 1;
      break;
    }
    // A no-match notice reached the reader instead of an answer. Grade nothing:
    // its fixed sentence trips no indicator, and a row of passes would count a
    // retrieval miss as a successful answer.
    const scored = output.notice !== true;
    const graded = gradeAnswer(question.id, output.answer, scored);
    summary.push({
      id: question.id,
      rules,
      ...graded,
      quoteWhole: scored
        ? gradeQuoteWhole(output.citations ?? [], output.passages ?? [])
        : null,
      coverage: output.metadata?.coverage ?? null,
      blocked: output.metadata?.coverageBlocked ?? null,
      truncated: output.outcome?.truncated ?? false,
      degenerate: output.outcome?.degenerate ?? false,
      noMatch: output.notice === true,
      usage: output.outcome?.usage
        ? {
            prompt_tokens: output.outcome.usage.prompt_tokens,
            completion_tokens: output.outcome.usage.completion_tokens
          }
        : null
    });
    // Save after every answer so a failed connection cannot erase the batch.
    await writeFile(
      path.join(directory, "summary.json"),
      JSON.stringify(summary, null, 2)
    );
    console.log(
      scored
        ? `${i + 1}/${count} ${question.id}: coverage=${output.metadata?.coverage ?? "absent"}, steps=${graded.steps}, reserve=${graded.reserve}, gapGate=${graded.gapGate}`
        : `${i + 1}/${count} ${question.id}: no match, no answer generated; not graded`
    );
  }
  await writeFile(
    path.join(directory, "summary.json"),
    JSON.stringify(summary, null, 2)
  );
  // Report the real denominator: a batch of no-match notices is not evidence.
  const generated = summary.filter(
    (row) =>
      (row as { steps?: number; error?: boolean }).error !== true &&
      (row as { reserve?: unknown }).reserve !== null
  ).length;
  await mkdir(path.dirname(report), { recursive: true });
  await writeFile(
    report,
    `# Answer evaluation — ${stamp}\n\nPrompt revision: ${revision}. Local batch: ${count} planned answers; rules ${rules ? "enabled" : "disabled"}. ${generated} of ${summary.length} rows generated an answer; the rest are no-match notices or request failures and are reported as null, not as passes. Indicators require manual review; they do not establish semantic correctness. Raw artifacts: ${path.relative(process.cwd(), directory)} (gitignored).\n\n\`\`\`json\n${JSON.stringify(summary, null, 2)}\n\`\`\`\n`
  );
  execFileSync("npx", ["oxfmt", "--write", report], { stdio: "ignore" });
  console.log(`Summary: ${path.relative(process.cwd(), report)}`);
}
