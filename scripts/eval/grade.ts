// Deterministic regression indicators, not a semantic verifier. A passing
// regex does not establish clinical correctness; reports require manual review.
import { displayLine, indexFile } from "../../src/lib/citations.ts";

function plain(text: string): string {
  return text.replace(/\*\*|__/g, "");
}
export function splitAnswer(text: string) {
  const clean = plain(text);
  const citations = clean.search(/what the sops say\s*:?/i);
  const gaps = clean.search(/not covered by the sops\s*:?/i);
  const question = clean.search(/one question\s*:?/i);
  const script = clean.search(/tell the patient\s*:?/i);
  const stop = clean.search(/stop and escalate\s*:?/i);
  return {
    head: clean.slice(0, citations < 0 ? clean.length : citations),
    citations:
      citations < 0
        ? ""
        : clean.slice(citations, gaps < 0 ? clean.length : gaps),
    gaps:
      gaps < 0 ? "" : clean.slice(gaps, question < 0 ? clean.length : question),
    question: question < 0 ? "" : clean.slice(question),
    script:
      script < 0 ? "" : clean.slice(script, stop < 0 ? clean.length : stop)
  };
}
export function stepsOf(text: string): string[] {
  const head = splitAnswer(text).head;
  const starts = [...head.matchAll(/(?:^|\s)\d{1,2}\.\s+/g)];
  return starts.map((m, i) =>
    head
      .slice((m.index ?? 0) + m[0].length, starts[i + 1]?.index ?? head.length)
      .split(/\n(?:Then|Tell the patient|Stop and escalate|Done when)\b/i)[0]
      .trim()
  );
}
const CODE = /\b(?:icd-?10|diagnosis code|code)\b/i;
export function gradeReserve(text: string): boolean {
  const head = splitAnswer(text).head;
  return stepsOf(text).every((step) => {
    if (!CODE.test(head)) return true;
    const clause = step.split(/(?<=[.!?])\s/)[0];
    if (/\b(?:route|ask|send|flag|notify)\b/i.test(clause)) return true;
    if (/\b(?:never|do not|don't)\b/i.test(clause)) return true;
    // The step must be about a code. Without this, "update it" in a step about
    // the study name is read as ops changing a code (A1, 6 Sep 2026).
    if (!CODE.test(clause)) return true;
    // Named-role actions like "Once the provider adds ... confirm" are
    // observations, not an imperative addressed to Operations. The role has to
    // come first: "Select the code, which the prescriber chooses" is still ops
    // choosing. Waiting for, or acting after, a role that already decided is not.
    const role = clause.search(
      /\b(?:provider|prescriber|clinician|physician)\b/i
    );
    const verb = clause.search(
      /\b(?:add|change|select|choose|determine|enter|pick|apply|update|use)\b/i
    );
    if (role >= 0 && verb >= 0 && role < verb) return true;
    return !/\b(?:add|change|select|choose|determine|enter|pick|apply|update|use)\s+(?:(?:a|an|the|correct|clinically|appropriate|medicare-covered|required|diagnosis|icd-?10)\s+){0,6}(?:code|it)\b/i.test(
      clause
    );
  });
}
export function gradeGapGate(text: string): boolean {
  return !(
    stepsOf(text).length &&
    /the specific steps|how to (?:update|set|change)/i.test(
      splitAnswer(text).gaps
    )
  );
}
export function gradeOneQuestion(text: string): boolean {
  const question = splitAnswer(text).question;
  // Identity must be scoped to the person. A bare /name/ failed "What is the
  // exact study name for the order?" (R2, 6 Sep 2026), and the SOPs expect
  // questions about a facility's phone number to be allowed.
  return !/(?:patient|caregiver|member|mother|father|spouse)(?:'s)?\s+(?:full\s+|first\s+|last\s+)?(?:name|date of birth|dob|phone|address|e-?mail)|\b(?:date of birth|dob)\b|which (?:code|icd)|patient's (?:specific )?(?:diagnosis|condition)|what is the (?:current )?(?:process|procedure)/i.test(
    question
  );
}
export function gradeConstraint(text: string): boolean {
  return /business days|may (?:need to )?move|cannot|not (?:be )?(?:guaranteed|booked)|can't (?:promise|guarantee)/i.test(
    splitAnswer(text).script
  );
}
// null, not true, when there is nothing to check: an answer with no citations
// is unexamined, and a vacuous pass would read as a green row in the report.
export function gradeQuoteWhole(
  citations: { file: string; quote: string | null; verified: boolean }[],
  passages: { file: string | null; text: string }[]
): boolean | null {
  if (citations.length === 0) return null;
  return citations.every(
    (citation) =>
      citation.verified &&
      citation.quote !== null &&
      passages.some(
        (p) =>
          p.file === citation.file &&
          indexFile(p.text).some(
            (line) =>
              displayLine(line.raw).replace(/"/g, "'") === citation.quote
          )
      )
  );
}
// A no-match notice is not an answer. Grading its fixed sentence would pass
// every indicator and inflate the report, so an unscored row reports null.
export const NOT_SCORED = {
  reserve: null,
  routing: null,
  gapGate: null,
  oneQuestion: null,
  timeframe: null,
  steps: 0
} as const;
export function gradeAnswer(id: string, text: string, scored = true) {
  if (!scored) return NOT_SCORED;
  const head = splitAnswer(text).head;
  return {
    reserve: gradeReserve(text),
    routing:
      /\b(?:route|ask|send|flag|notify)\b[^.\n]{0,150}\b(?:provider|prescriber)\b|\b(?:provider|prescriber)\b[^.\n]{0,80}\b(?:selects|chooses|decides)\b/i.test(
        head
      ),
    gapGate: gradeGapGate(text),
    oneQuestion: gradeOneQuestion(text),
    timeframe: ["B3", "C1"].includes(id) ? gradeConstraint(text) : null,
    steps: stepsOf(text).length
  };
}
