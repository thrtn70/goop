import { describe, expect, it } from "vitest";
import {
  IDLE_START,
  nextStartState,
  startBanner,
  startPhaseFor,
  type StartOptions,
  type StartState,
} from "@/features/extract/startState";

const A = "https://example.com/a";
const B = "https://example.com/b";

function opts(format_id: string | null = null, audioOnly = false): StartOptions {
  return {
    format:
      format_id == null
        ? null
        : {
            format_id,
            ext: "mp4",
            resolution: "1920x1080",
            filesize: null,
            is_audio_only: false,
            selector: format_id,
          },
    audioOnly,
  };
}

const starting = (id = 1, url = A, retryingAfter: string | null = null): StartState => ({
  kind: "starting",
  id,
  url,
  opts: opts(),
  retryingAfter,
});
const started = (id = 1, url = A, o = opts()): StartState => ({ kind: "started", id, url, opts: o });
const failed = (id = 1, url = A, message = "the queue is full"): StartState => ({
  kind: "failed",
  id,
  url,
  opts: opts(),
  message,
});

describe("nextStartState — settling", () => {
  it("takes a success from the attempt that is current", () => {
    expect(nextStartState(starting(7), { type: "succeeded", id: 7 }).kind).toBe("started");
  });

  it("ignores a success from a superseded attempt", () => {
    // The whole staleness story. A settle that is not the current attempt
    // must not report, must not clear a live attempt's state, and must not
    // strand one — so the state comes back untouched, by identity.
    const s = starting(8);
    expect(nextStartState(s, { type: "succeeded", id: 7 })).toBe(s);
  });

  it("takes a failure from the attempt that is current", () => {
    const next = nextStartState(starting(7), { type: "failed", id: 7, message: "nope" });
    expect(next).toMatchObject({ kind: "failed", message: "nope" });
  });

  it("ignores a failure from a superseded attempt", () => {
    const s = starting(8);
    expect(nextStartState(s, { type: "failed", id: 7, message: "nope" })).toBe(s);
  });

  it("ignores a settle that arrives when nothing is starting", () => {
    expect(nextStartState(IDLE_START, { type: "succeeded", id: 1 })).toBe(IDLE_START);
    const done = started(1);
    expect(nextStartState(done, { type: "failed", id: 1, message: "x" })).toBe(done);
  });
});

describe("nextStartState — attempts", () => {
  it("carries the failure it is retrying, so the banner can stay on screen", () => {
    const next = nextStartState(failed(1, A, "the queue is full"), {
      type: "attempt",
      id: 2,
      url: A,
      opts: opts(),
    });
    expect(next).toMatchObject({ kind: "starting", id: 2, retryingAfter: "the queue is full" });
  });

  it("keeps a carried message when one attempt replaces another", () => {
    // Unreachable through the UI today, but it is one `disabled` removal
    // away, and losing the message would silently drop the banner.
    const next = nextStartState(starting(2, A, "the queue is full"), {
      type: "attempt",
      id: 3,
      url: A,
      opts: opts(),
    });
    expect(next).toMatchObject({ id: 3, retryingAfter: "the queue is full" });
  });

  it("carries nothing when the start is not retrying anything", () => {
    const next = nextStartState(IDLE_START, { type: "attempt", id: 1, url: A, opts: opts() });
    expect(next).toMatchObject({ kind: "starting", retryingAfter: null });
  });

  it("lets the newer attempt win, and the older one no longer settle", () => {
    const two = nextStartState(starting(1), { type: "attempt", id: 2, url: A, opts: opts() });
    expect(nextStartState(two, { type: "succeeded", id: 1 })).toBe(two);
    expect(nextStartState(two, { type: "succeeded", id: 2 }).kind).toBe("started");
  });
});

describe("nextStartState — retire and dismiss", () => {
  it("retires from every state", () => {
    for (const s of [IDLE_START, starting(), started(), failed()]) {
      expect(nextStartState(s, { type: "retire" })).toEqual(IDLE_START);
    }
  });

  it("drops an attempt that settles after its card was retired", () => {
    const gone = nextStartState(starting(4), { type: "retire" });
    expect(nextStartState(gone, { type: "failed", id: 4, message: "x" })).toEqual(IDLE_START);
  });

  it("dismisses a failure", () => {
    expect(nextStartState(failed(), { type: "dismiss" })).toEqual(IDLE_START);
  });

  it("dismisses only the message while an attempt is in flight", () => {
    // Dismiss is about the message; retire is about the card. Collapsing
    // them would let a Dismiss mid-retry orphan a live attempt — the card
    // re-arms, the settle is dropped, and the next click queues a
    // duplicate against the same .part.
    const next = nextStartState(starting(5, A, "the queue is full"), { type: "dismiss" });
    expect(next).toMatchObject({ kind: "starting", id: 5, retryingAfter: null });
  });

  it("does nothing on dismiss when there is no message", () => {
    expect(nextStartState(IDLE_START, { type: "dismiss" })).toBe(IDLE_START);
    const done = started();
    expect(nextStartState(done, { type: "dismiss" })).toBe(done);
  });
});

describe("startPhaseFor", () => {
  it("is busy for any selection while a start for this url is in flight", () => {
    // Nothing in the queue dedupes, and two jobs for one URL run the same
    // output template with --continue against the same .part. So while an
    // enqueue is in the air the card is dead whatever the picker says —
    // comparing opts here would reopen the duplicate through the picker.
    expect(startPhaseFor(starting(1, A), A, opts("299"))).toBe("starting");
    expect(startPhaseFor(starting(1, A), A, opts(null, true))).toBe("starting");
  });

  it("is idle for a different url even while a start is in flight", () => {
    expect(startPhaseFor(starting(1, A), B, opts())).toBe("idle");
  });

  it("reports started only for the selection that was actually started", () => {
    const s = started(1, A, opts("299"));
    expect(startPhaseFor(s, A, opts("299"))).toBe("started");
    expect(startPhaseFor(s, A, opts("18"))).toBe("idle");
    expect(startPhaseFor(s, A, opts("299", true))).toBe("idle");
  });

  it("does not carry a started selection over to another video", () => {
    expect(startPhaseFor(started(1, A, opts("299")), B, opts("299"))).toBe("idle");
  });

  it("compares formats by id, not by object identity", () => {
    // The old resetKey was a string of format_id — a faithful port has to
    // match that. Identity would silently differ the moment a re-probe
    // rebuilt the FormatOption objects.
    const s = started(1, A, opts("299"));
    expect(startPhaseFor(s, A, opts("299"))).toBe("started");
  });

  it("is idle when nothing has been started", () => {
    expect(startPhaseFor(IDLE_START, A, opts())).toBe("idle");
    expect(startPhaseFor(failed(1, A), A, opts())).toBe("idle");
  });
});

describe("startBanner", () => {
  it("shows a failure with its retry armed", () => {
    expect(startBanner(failed(1, A, "the queue is full"))).toMatchObject({
      message: "the queue is full",
      retrying: false,
    });
  });

  it("keeps the message on screen while its retry is in flight", () => {
    expect(startBanner(starting(2, A, "the queue is full"))).toMatchObject({
      message: "the queue is full",
      retrying: true,
    });
  });

  it("shows nothing when there is nothing to report", () => {
    expect(startBanner(IDLE_START)).toBeNull();
    expect(startBanner(started())).toBeNull();
    expect(startBanner(starting(1, A, null))).toBeNull();
  });
});
