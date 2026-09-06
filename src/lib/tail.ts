// Streaming splitter for the citation section of an answer. The Worker streams
// generated text to the client delta by delta (server.ts `say`), and from B2 on
// it rebuilds the citation items from retrieval instead of trusting the ones the
// model wrote. To do that it has to hold back everything from the first citation
// item to the end of the stream while the body ahead of it still reaches the
// reader with zero lag. TailHold is that holder.
//
// Pure class: no imports, no I/O, no timers, no clock. The only text ever held
// back BEFORE the citation heading is a trailing partial line that is still a
// live prefix of "What the SOPs say" (bounded by MAX_TRIGGER_LINE); a completed
// line that is not the heading is emitted at once. Once the heading is
// confirmed the heading line itself is emitted immediately — the reader watches
// it arrive while the items are held — and everything after it is held until
// end(). The split is lossless: for any input cut into any deltas,
// emitted.join("") + (end() ?? "") is the input, exactly.
//
// Abort policy: a stop must never swallow text the reader already half has. The
// first push that observes isAborted() (or an outright release()) emits
// whatever is buffered, raw and in order, and every later push passes straight
// through. end() then reports no tail, so the caller keeps the model's own
// citation text rather than rebuilding a section from a partial stream.
//
// Invariant this leans on: a degenerate attempt never pushes. server.ts's
// consume() holds the first DEGEN_SNIFF_CHARS back for the collapse sniff and
// cancels a collapsed stream without ever calling say(), so a re-rolled attempt
// meets an untouched holder. reset() at the top of every attempt makes that
// explicit instead of merely true by luck.

// The confirmed heading: "what the sops say" at a line start, optionally as a
// setext-free ATX heading and/or bolded, terminated by the ":" of the question
// format or by the end of the line, LF or CRLF. The "\r" of a CRLF terminator
// is part of the match, so it travels with the emitted heading line rather than
// leaking into the held tail. Neither regex carries /g or /y, so both are
// stateless and safe to share across instances.
export const CITATION_TRIGGER_RE =
  /^[ \t]*(?:#{1,6}[ \t]+)?(?:\*\*|__)?[ \t]*what the sops say(?:[ \t]*(?:\*\*|__))?[ \t]*(?::|\r?\n)/im;

// The same heading sitting at the very end of the buffer with no terminator
// yet — the shape end() sees when the stream stops right after the heading.
// Needs no CRLF-specific update: this regex only requires optional trailing
// spaces/colon before end of input, and a lone trailing "\r" already satisfies
// it, verified with /.../im.test("what the sops say\r") === true — JS `$`
// under /m matches immediately before ANY line terminator, not only "\n", so a
// stream that stops between the "\r" and "\n" of a CRLF terminator still reads
// as a bare heading.
export const CITATION_TRIGGER_AT_END_RE =
  /^[ \t]*(?:#{1,6}[ \t]+)?(?:\*\*|__)?[ \t]*what the sops say(?:[ \t]*(?:\*\*|__))?[ \t]*:?[ \t]*$/im;

const HEADING_TEXT = "what the sops say";

// Longest partial line worth holding: three spaces of indent, "###### ", "**",
// a space and the 17-character heading is 30, so 32 leaves a little slack. A
// line longer than this cannot still be becoming the heading, and the cap keeps
// a pathological run of whitespace from being buffered without limit.
const MAX_TRIGGER_LINE = 32;

// The markdown that may precede the heading text. Deliberately looser than
// CITATION_TRIGGER_RE (single "*"/"_", no space required after the hashes)
// because a partial line may hold half-typed markup: holding one delta too long
// costs nothing, releasing one delta too early loses the trigger.
const LEADING_MARKUP_RE = /^[ \t]*(?:#{1,6}[ \t]*)?(?:\*\*?|__?)?[ \t]*/;
// Trailing "\r?" for the same reason CITATION_TRIGGER_RE accepts "\r?\n": a
// delta boundary can land right after the "\r" of an incoming CRLF terminator,
// and that lone "\r" must not read as disqualifying content — it is still a
// live prefix of the terminator, one "\n" away from confirming the heading.
const TRAILING_MARKUP_RE = /^[ \t]*(?:\*\*?|__?)?[ \t]*\r?$/;

// True when `line` (a partial line, never containing a newline) could still
// grow into the heading, so it must not be emitted yet.
function isLiveTriggerPrefix(line: string): boolean {
  if (line.length > MAX_TRIGGER_LINE) return false;
  const rest = line.replace(LEADING_MARKUP_RE, "").toLowerCase();
  if (rest.length < HEADING_TEXT.length) return HEADING_TEXT.startsWith(rest);
  return (
    rest.startsWith(HEADING_TEXT) &&
    TRAILING_MARKUP_RE.test(rest.slice(HEADING_TEXT.length))
  );
}

export class TailHold {
  // Fields are declared and assigned in the constructor body on purpose:
  // Node 24 strips types, it does not run parameter-property semantics.
  private readonly emit: (text: string) => void;
  private readonly isAborted: () => boolean;
  // Text received but not yet emitted, always a single trailing partial line
  // that begins at a line start (see scan) — empty unless a live prefix is held.
  private pending: string;
  // Everything after a confirmed heading line, held until end().
  private held: string;
  private heading: boolean;
  private passthrough: boolean;
  // Whether the next character to arrive starts a line. True initially, and
  // after every emit it is whether that emitted text ended with a newline.
  private atLineStart: boolean;

  constructor(emit: (text: string) => void, isAborted: () => boolean) {
    this.emit = emit;
    this.isAborted = isAborted;
    this.pending = "";
    this.held = "";
    this.heading = false;
    this.passthrough = false;
    this.atLineStart = true;
  }

  push(delta: string): void {
    if (this.passthrough) {
      this.emitText(delta);
      return;
    }
    if (this.isAborted()) {
      this.release();
      this.emitText(delta);
      return;
    }
    if (this.heading) {
      this.held += delta;
      return;
    }
    this.pending += delta;
    this.scan();
  }

  // Flushes what is left and reports the citation items. Returns the held tail
  // (possibly "") when a heading was confirmed, "" when the stream ended on a
  // bare heading, and null when this answer had no citation heading at all —
  // null meaning "nothing was withheld, leave the text as the model wrote it".
  // Meant to be called once per attempt: after a confirmed heading, a second
  // call returns "" (held is already drained), and it does not itself start a
  // fresh attempt — a later push() just resumes accumulating into the held
  // tail, exactly as if end() had never been called. reset() is what actually
  // starts the next attempt.
  end(): string | null {
    if (this.passthrough) return null;
    if (this.heading) {
      const tail = this.held;
      this.held = "";
      return tail;
    }
    const pending = this.pending;
    this.pending = "";
    if (!pending) return null;
    // pending is always a line-start partial line, so a match here is anchored.
    const bare = CITATION_TRIGGER_AT_END_RE.test(pending);
    this.emitText(pending);
    return bare ? "" : null;
  }

  // Abort backstop: give the reader everything buffered, in the order it
  // arrived, and stop holding anything back from here on.
  release(): void {
    this.passthrough = true;
    const buffered = this.pending + this.held;
    this.pending = "";
    this.held = "";
    this.emitText(buffered);
  }

  reset(): void {
    this.pending = "";
    this.held = "";
    this.heading = false;
    this.passthrough = false;
    this.atLineStart = true;
  }

  // Confirms the heading if it has fully arrived; otherwise lets everything
  // through except a trailing partial line that could still become the heading.
  private scan(): void {
    const offset = this.searchOffset();
    if (offset >= 0) {
      const match = CITATION_TRIGGER_RE.exec(this.pending.slice(offset));
      if (match) {
        // The match consumes the terminating ":" or "\n" (or "\r\n"), so the
        // heading line goes out whole and the tail is whatever follows it,
        // verbatim. With the colon form that means the tail keeps the rest of
        // the line — including the newline when the colon ends it — so a
        // consumer of the tail must trim rather than assume it opens on a
        // fresh line.
        let cut = offset + match.index + match[0].length;
        // A bold question heading closes AFTER its colon. Wait for those
        // two characters, including when each arrives in a separate delta,
        // and emit them with the heading rather than with the citation items.
        const heading = match[0];
        const opener = /^[ \t]*(?:#{1,6}[ \t]+)?(\*\*|__)/.exec(heading)?.[1];
        if (
          opener &&
          heading.endsWith(":") &&
          !heading.slice(heading.indexOf(opener) + 2).includes(opener)
        ) {
          const suffix = this.pending.slice(cut, cut + 2);
          if (suffix.length < 2 && opener.startsWith(suffix)) return;
          if (suffix === opener) cut += 2;
        }
        const headingLine = this.pending.slice(0, cut);
        this.held = this.pending.slice(cut);
        this.pending = "";
        this.heading = true;
        this.emitText(headingLine);
        return;
      }
    }
    const newline = this.pending.lastIndexOf("\n");
    const trailing = this.pending.slice(newline + 1);
    // A partial line only counts as a candidate when it begins a line: either
    // this buffer contains the newline before it, or the buffer itself began
    // at a line start.
    const startsLine = newline >= 0 || this.atLineStart;
    if (trailing && startsLine && isLiveTriggerPrefix(trailing)) {
      const ahead = this.pending.slice(0, newline + 1);
      this.pending = trailing;
      this.emitText(ahead);
      return;
    }
    const all = this.pending;
    this.pending = "";
    this.emitText(all);
  }

  // Where in `pending` a heading may legally start: the whole buffer when it
  // begins at a line start, otherwise only after its first newline. -1 when the
  // buffer holds no line start at all, which is what keeps a mid-line mention
  // ("...as described under What the SOPs say:") from triggering.
  private searchOffset(): number {
    if (this.atLineStart) return 0;
    const newline = this.pending.indexOf("\n");
    return newline === -1 ? -1 : newline + 1;
  }

  private emitText(text: string): void {
    // Guards two things: it skips a spurious empty callback, and — the less
    // obvious job — it leaves atLineStart untouched. scan()'s live-prefix
    // branch calls this with "" when the whole of `pending` is itself the
    // candidate line and there is no newline ahead of it to flush; without
    // this guard that call would fall through to `"".endsWith("\n")` and
    // wrongly clear a true atLineStart, after which searchOffset() would stop
    // treating the held prefix as sitting at a line start and the heading
    // could no longer be confirmed. A reviewer mutation that dropped this
    // guard reproduced exactly that failure.
    if (!text) return;
    this.emit(text);
    this.atLineStart = text.endsWith("\n");
  }
}
