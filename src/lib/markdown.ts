// The answer format numbers its steps continuously: "Do now" holds steps 1-3,
// then "Then" continues at 4. CommonMark (which Streamdown uses) forbids an
// ordered list whose first number is not 1 from interrupting a paragraph, so
// when the model omits the blank line between the "Then" heading and step 4 the
// whole section collapses into one run-on paragraph ("Then 4. ... 5. ... 6.
// ..."). "Do now" escapes this only because its list starts at 1, which is
// allowed to interrupt a paragraph.
//
// Fix it at render time instead of trusting the model's whitespace: insert a
// blank line before any numbered step that begins a fresh list directly under a
// heading or prose line. Deterministic, model-agnostic, and it also repairs
// answers already persisted without the blank line.

const NUMBERED_STEP = /^ {0,3}\d+\. /;

export function normalizeAnswerMarkdown(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let inList = false;

  for (const line of lines) {
    if (line.trim() === "") {
      inList = false;
      out.push(line);
      continue;
    }

    if (NUMBERED_STEP.test(line)) {
      // A numbered step that isn't a continuation of an open list is starting a
      // new list. If it sits directly under a non-blank heading/prose line,
      // separate them so a list starting at n != 1 renders instead of merging
      // into that line's paragraph.
      if (!inList && out.length > 0 && out[out.length - 1].trim() !== "") {
        out.push("");
      }
      inList = true;
    }
    // Non-blank, non-numbered lines while inList stay part of the current list
    // (e.g. a step whose text wrapped onto its own line), so inList is left set.

    out.push(line);
  }

  return out.join("\n");
}
