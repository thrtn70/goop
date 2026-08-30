import type { FormatOption } from "@/types";

/**
 * What a start was asked to download.
 *
 * Lives here rather than in `ProbeCard` because `ProbeCard` imports this
 * module for the state it renders from — leaving the type there would make
 * a cycle. A type-only cycle survives `tsc` and Vite, which is worse than
 * failing: it sits quiet until someone adds the first value export.
 */
export interface StartOptions {
  format: FormatOption | null;
  audioOnly: boolean;
}

/**
 * Everything the extract card knows about starting a download.
 *
 * This is one state because the fact it describes is one fact. It used to
 * be five — an epoch ref, two booleans, an error object, and the button's
 * own phase — and every defect in this area was two of them disagreeing:
 * a retry the card could not see, a card the retry could not see, a busy
 * flag nothing cleared, a cleared flag that belonged to someone else. As a
 * union those states cannot be held at once, so they cannot disagree.
 *
 * `id` is what makes a settle safe. An enqueue outlives the thing that
 * asked for it — `UrlHero` is re-rendered with a new `url` rather than
 * remounted — so a promise can come back to a card that is already gone.
 * Comparing its id against the current state is the whole guard, and it
 * lives in exactly one place: `nextStartState`.
 *
 * `url` is here for the same reason at a slower timescale: it stops a
 * settled "Added to queue" from latching onto whatever video is on screen
 * later.
 */
export type StartState =
  | { kind: "idle" }
  | { kind: "starting"; id: number; url: string; opts: StartOptions; retryingAfter: string | null }
  | { kind: "started"; id: number; url: string; opts: StartOptions }
  | { kind: "failed"; id: number; url: string; opts: StartOptions; message: string };

/**
 * `dismiss` and `retire` are deliberately separate and must stay that way.
 *
 * `retire` is about the *card*: the thing this attempt belonged to is
 * gone, so the attempt is void. `dismiss` is about the *message*: the user
 * has read it. They happen to share a resting value, which is exactly what
 * makes collapsing them tempting and wrong — a Dismiss that retired would
 * orphan a live attempt, re-arm the card, drop the settle, and let the
 * next click queue a duplicate against the same `.part`.
 */
export type StartEvent =
  | { type: "attempt"; id: number; url: string; opts: StartOptions }
  | { type: "succeeded"; id: number }
  | { type: "failed"; id: number; message: string }
  | { type: "dismiss" }
  | { type: "retire" };

export const IDLE_START: StartState = { kind: "idle" };

/**
 * The one place a start transitions. Pure, so the interleavings that broke
 * this four times can be enumerated in a test without React or timing.
 *
 * Not named `startReducer` — there is no `useReducer` here, and the name
 * would advertise a hook that does not exist. Not named `startTransition`
 * either: React 18 exports that from "react", and both callers already
 * import from it, so an auto-import would silently bind the wrong one.
 */
export function nextStartState(state: StartState, ev: StartEvent): StartState {
  switch (ev.type) {
    case "attempt":
      return {
        kind: "starting",
        id: ev.id,
        url: ev.url,
        opts: ev.opts,
        // A retry keeps its failure on screen. Dropping the banner the
        // moment a retry starts takes the only sign of activity away,
        // which is what invited a second click on the card.
        retryingAfter:
          state.kind === "failed"
            ? state.message
            : state.kind === "starting"
              ? state.retryingAfter
              : null,
      };
    case "succeeded":
      if (state.kind !== "starting" || state.id !== ev.id) return state;
      return { kind: "started", id: state.id, url: state.url, opts: state.opts };
    case "failed":
      if (state.kind !== "starting" || state.id !== ev.id) return state;
      return {
        kind: "failed",
        id: state.id,
        url: state.url,
        opts: state.opts,
        message: ev.message,
      };
    case "dismiss":
      if (state.kind === "failed") return IDLE_START;
      // Mid-flight, dismissing takes the message and nothing else. The
      // attempt keeps running and still owns the card.
      if (state.kind === "starting" && state.retryingAfter !== null) {
        return { ...state, retryingAfter: null };
      }
      return state;
    case "retire":
      return IDLE_START;
  }
}

export type StartPhase = "idle" | "starting" | "started";

/**
 * How a start control for `(url, opts)` should render.
 *
 * The asymmetry is the point, and it is the content of two separate bugs:
 *
 * - **`starting` matches on url alone.** Nothing in the queue dedupes, and
 *   two jobs for one URL run the same output template with `--continue`
 *   against the same `.part`. While any enqueue for this URL is in the air
 *   every control on the card is dead, whatever the picker currently says.
 *   Comparing `opts` here would reopen the duplicate through the picker.
 * - **`started` matches on url *and* opts.** That is the re-arm: change
 *   the format after a start and the button offers itself again. It
 *   replaces the old `resetKey`/`startedKey` pair with a derivation.
 */
export function startPhaseFor(s: StartState, url: string, opts: StartOptions): StartPhase {
  if (s.kind === "starting" && s.url === url) return "starting";
  if (s.kind === "started" && s.url === url && sameStartOptions(s.opts, opts)) return "started";
  return "idle";
}

export interface StartBanner {
  message: string;
  opts: StartOptions;
  retrying: boolean;
}

/**
 * What the failure banner should show, or nothing.
 *
 * A selector rather than a JSX condition because "render when failed, or
 * when starting with a carried message" is precisely the two-things-agree
 * shape that produced every defect here — as a selector it gets its own
 * test rows instead of only ever being exercised through a render.
 */
export function startBanner(s: StartState): StartBanner | null {
  if (s.kind === "failed") return { message: s.message, opts: s.opts, retrying: false };
  if (s.kind === "starting" && s.retryingAfter !== null) {
    return { message: s.retryingAfter, opts: s.opts, retrying: true };
  }
  return null;
}

/** By `format_id`, never by object identity: the old `resetKey` was a
 *  string of exactly these two fields, and identity would silently differ
 *  the moment a re-probe rebuilt the `FormatOption` objects. */
function sameStartOptions(a: StartOptions, b: StartOptions): boolean {
  return (
    (a.format?.format_id ?? null) === (b.format?.format_id ?? null) && a.audioOnly === b.audioOnly
  );
}
