import type { JobKind, JobState } from "@/types";

/**
 * Which kinds offer Retry. Download failures are usually transient and the
 * partials on disk turn a re-run into a resume; a conversion failure is
 * deterministic, so a Retry button there just fails again more slowly.
 *
 * Shared so the queue row, the History row and the wording of the
 * interrupted message cannot disagree about it — the backend's
 * `queue_retry` is kind-generic, so this restraint is the UI's alone.
 */
export function canRetryKind(kind: JobKind): boolean {
  return kind === "extract";
}

/**
 * Longest headline worth rendering inline. Both surfaces show the message on
 * one clipped line, so past this there is nothing to gain from a longer
 * string — and a great deal to lose: `truncate` sets `white-space: nowrap`,
 * which in History's auto-layout table makes the cell's min-content width the
 * width of the whole string and pushes the table off-screen.
 */
const MAX_HEADLINE = 180;

/**
 * What a failed job says for itself, split into the three things the UI
 * renders differently.
 *
 * The backend hands over two strings: `message`, which `GoopError::user_message`
 * already ran `friendly_message` over, and `detail`, the raw text behind it.
 * Neither is safe to render as-is. `detail` is frequently the message again —
 * verbatim for `Network`, and under a binary prefix whenever no friendly
 * pattern matched — and both fields can carry a line Goop wrote itself rather
 * than something a tool said. Working that out at each call site was how the
 * Queue and History rows drifted apart in the first place.
 */
export interface FailureView {
  /** The headline. Always shown. */
  message: string;
  /**
   * Raw text worth reading, or `null` when there is none — either the row
   * predates the `error_detail` column, or the detail would only repeat the
   * message back. `null` means show no affordance at all, not an empty one.
   */
  detail: string | null;
  /** Goop's own note about what it already tried. Rendered as its own line. */
  note: string | null;
}

/**
 * Boot reconcile flips rows that were `running` when the app died to exactly
 * this message (`goop_queue::store::reconcile`). On its own it reads like a
 * bug report rather than an explanation.
 */
const INTERRUPTED_MARKER = "interrupted";

export const INTERRUPTED_MESSAGE = "Interrupted — Goop closed while this ran.";

/**
 * Only for the kinds that actually offer the button. Boot reconcile flips
 * every running job, conversions included, and those have no Retry on either
 * surface — telling their owner to press one is an instruction to go looking
 * for something that isn't there.
 */
export const INTERRUPTED_MESSAGE_RETRYABLE = `${INTERRUPTED_MESSAGE} Retry to resume.`;

/**
 * Lines Goop appends to a tool's own output, as opposed to anything an
 * extractor printed. The trailing space is part of it: it keeps a stderr that
 * happens to start a line with `[goop]` from being mistaken for one of ours.
 */
const NOTE_PREFIX = "[goop] ";

/**
 * Reduce text to something that fits on one line, reporting whether anything
 * was left behind. When it was, the caller must keep the full text reachable
 * — that is the invariant the detail block exists to hold up.
 */
function clipHeadline(text: string): { headline: string; clipped: boolean } {
  const firstLine = text.split("\n", 1)[0] ?? "";
  const isMultiline = firstLine.length !== text.length;
  if (!isMultiline && text.length <= MAX_HEADLINE) {
    return { headline: text, clipped: false };
  }
  const headline =
    firstLine.length > MAX_HEADLINE
      ? `${firstLine.slice(0, MAX_HEADLINE).trimEnd()}…`
      : `${firstLine}…`;
  return { headline, clipped: true };
}

/** Peel Goop's own trailing note lines off text a tool produced. */
function splitNote(text: string): { body: string; note: string | null } {
  const lines = text.split("\n");
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
  const note: string[] = [];
  while (lines.length > 0 && lines[lines.length - 1]!.startsWith(NOTE_PREFIX)) {
    note.unshift(lines.pop()!);
  }
  return {
    body: lines.join("\n").trimEnd(),
    note: note.length > 0 ? note.join("\n") : null,
  };
}

/**
 * Read a job's terminal state as something renderable, or `null` when the job
 * did not fail.
 */
export function failureView(state: JobState, canRetry = false): FailureView | null {
  if (typeof state === "string" || !("error" in state)) return null;
  const raw = state.error;
  if (!raw?.message) return null;

  const fromMessage = splitNote(raw.message);
  const fromDetail = splitNote(raw.detail ?? "");

  // Either field can carry the note: `user_message` falls through to the raw
  // stderr when no friendly pattern matched, so an unrecognised failure has
  // it in both. Prefer the detail's copy; they are the same line.
  const note = fromDetail.note ?? fromMessage.note;

  const full =
    fromMessage.body.trim() === INTERRUPTED_MARKER
      ? canRetry
        ? INTERRUPTED_MESSAGE_RETRYABLE
        : INTERRUPTED_MESSAGE
      : fromMessage.body;

  const { headline, clipped } = clipHeadline(full);
  const body = fromDetail.body.trim();

  // The rule is "can the user still get at everything", not "are these two
  // strings different".
  //
  // Suppress only when the headline shows the detail IN FULL. `includes` and
  // not equality, because `Network`'s detail is its message minus the
  // `network error:` prefix and an unfriendly `SubprocessFailed`'s is its
  // message minus the binary name — rendering either twice would put the
  // same sentence behind a button implying there was more to read.
  //
  // But `clipped` has to veto that. The failures with the most raw text are
  // exactly the ones no `friendly_message` pattern matched, and for those the
  // message IS the stderr — so a pure `includes` test threw away the details
  // block precisely when it was the only way to read an 8KB ffmpeg dump,
  // leaving a nowrap one-liner and a tooltip nobody can select.
  let detail: string | null;
  if (body === "") {
    // Nothing in the column. If the headline was clipped, the untruncated
    // message is the only remaining copy of what was cut.
    detail = clipped ? fromMessage.body : null;
  } else {
    detail = !clipped && headline.includes(body) ? null : fromDetail.body;
  }

  return { message: headline, detail, note };
}
