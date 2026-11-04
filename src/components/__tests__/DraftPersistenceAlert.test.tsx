import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";

const recorderState = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));

vi.mock("@/performance/responsiveness", () => ({
  getResponsivenessRecorder: () => recorderState.current,
}));
vi.mock("../LeftNav", () => ({ default: () => null }));
vi.mock("../TopBar", () => ({ default: () => null }));
vi.mock("../CommandPalette", () => ({ default: () => null }));
vi.mock("../Onboarding", () => ({ default: () => null }));
vi.mock("../SkipNav", () => ({ default: () => null }));
vi.mock("@/features/queue/QueueSidebar", () => ({ default: () => null }));
vi.mock("@/hooks/useTheme", () => ({ useTheme: () => undefined }));
vi.mock("@/hooks/useQueueHotkey", () => ({ useQueueHotkey: () => undefined }));
vi.mock("@/hooks/useHotkeys", () => ({ useHotkeys: () => undefined }));

const FORGET = "Forget edits from earlier sessions";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.resetModules();
});

function recorder(mode: "noop" | "enabled" | "faulted") {
  const owner = { kind: "setup" as const, setup_id: 1 };
  let spanId = 0;
  if (mode === "noop") {
    return {
      startSetup: () => null,
      settleSetup: () => undefined,
      cancelSetup: () => undefined,
      startSpan: () => null,
      endSpan: () => undefined,
      cancelSpan: () => undefined,
    };
  }
  if (mode === "faulted") {
    // A recorder that has crossed its internal failure boundary is inert.
    return {
      startSetup: vi.fn(() => null),
      settleSetup: vi.fn(),
      cancelSetup: vi.fn(),
      startSpan: vi.fn(() => null),
      endSpan: vi.fn(),
      cancelSpan: vi.fn(),
    };
  }
  return {
    startSetup: vi.fn(() => owner),
    settleSetup: vi.fn(),
    cancelSetup: vi.fn(),
    startSpan: vi.fn(() => ++spanId),
    endSpan: vi.fn(),
    cancelSpan: vi.fn(),
  };
}

describe.each(["noop", "enabled", "faulted"] as const)("draft persistence alert with %s recorder", (mode) => {
  it("keeps the unchanged in-memory draft visible and retries the real storage write", async () => {
    let failWrites = true;
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (failWrites) throw new Error("quota detail must stay private");
        values.set(key, value);
      },
    });
    recorderState.current = recorder(mode);

    const drafts = await import("@/store/workspaceDrafts");
    const { DRAFT_STORAGE_KEY, decodeDraftEntries } = await import("@/store/workspacePersistence");
    const { default: Layout } = await import("../Layout");
    const wrapper = ({ children }: { children: ReactNode }) => createElement(
      drafts.WorkspaceDraftProvider,
      { tool: "image" },
      children,
    );

    render(<MemoryRouter><Layout /></MemoryRouter>);
    const draft = renderHook(
      () => drafts.useWorkspaceDraftState<string[]>("ImagePage.files", []),
      { wrapper },
    );
    act(() => draft.result.current[1](["/private/source.png"]));

    expect((await screen.findByRole("alert")).textContent).toContain("Unfinished edits could not be saved for restart");
    expect(draft.result.current[0]).toEqual(["/private/source.png"]);
    expect(values.has(DRAFT_STORAGE_KEY)).toBe(false);

    expect(screen.queryByRole("button", { name: "Forget edits from earlier sessions" })).toBeNull();
    failWrites = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());

    expect(draft.result.current[0]).toEqual(["/private/source.png"]);
    expect(decodeDraftEntries(values.get(DRAFT_STORAGE_KEY) ?? "")).toEqual({
      [JSON.stringify(["image", "ImagePage.files"])]: { value: ["/private/source.png"] },
    });
  });
});

describe("recovering saved edits a strict load refused", () => {
  const V2 = "goop.workspace-drafts.v2";
  const V1 = "goop.workspace-drafts.v1";
  const BACKUP = "goop.workspace-drafts.v2.unreadable";
  const RECOVER = "Back up and recover what can be read";
  const files = JSON.stringify(["image", "ImagePage.files"]);
  const rotation = JSON.stringify(["image", "ImageRotateFlow.degrees"]);
  const oversized = JSON.stringify(["compress", "pdf", ...Array.from({ length: 18 }, (_, i) => `/doc-${i}.pdf`), "PdfFlow.op"]);
  const refusedRaw = JSON.stringify({ version: 2, entries: { [files]: { value: ["/kept.png"] }, [oversized]: { value: "merge" } } });

  async function boot(saved: Record<string, string>, options: { failBackup?: boolean; unreadable?: boolean } = {}) {
    // Each boot loads the draft store afresh against its own saved data.
    vi.resetModules();
    const values = new Map<string, string>(Object.entries(saved));
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => {
        if (options.unreadable) throw new Error("storage unavailable");
        return values.get(key) ?? null;
      },
      setItem: (key: string, value: string) => {
        if (options.failBackup && key.startsWith(BACKUP)) throw new Error("quota");
        values.set(key, value);
      },
    });
    recorderState.current = recorder("noop");
    const drafts = await import("@/store/workspaceDrafts");
    const persistence = await import("@/store/workspacePersistence");
    const { default: Layout } = await import("../Layout");
    const wrapper = ({ children }: { children: ReactNode }) => createElement(drafts.WorkspaceDraftProvider, { tool: "image" }, children);
    render(<MemoryRouter><Layout /></MemoryRouter>);
    const filesDraft = renderHook(() => drafts.useWorkspaceDraftState<string[]>("ImagePage.files", []), { wrapper });
    const rotationDraft = renderHook(() => drafts.useWorkspaceDraftState<string>("ImageRotateFlow.degrees", "cw180"), { wrapper });
    act(() => rotationDraft.result.current[1]("cw90"));
    const strictLoad = () => persistence.loadDraftEntriesOutcome({ getItem: key => values.get(key) ?? null, setItem: () => undefined });
    return { values, strictLoad, filesDraft, rotationDraft };
  }

  it("backs up what was saved, then restores every entry that can be read and keeps entries only this session has", async () => {
    const { values, strictLoad, filesDraft, rotationDraft } = await boot({ [V2]: refusedRaw });
    expect((await screen.findByRole("alert")).textContent).toContain("Some saved edits can't be read.");
    expect(filesDraft.result.current[0]).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: RECOVER }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());

    expect(values.get(`${BACKUP}.0`)).toBe(refusedRaw);
    expect(filesDraft.result.current[0]).toEqual(["/kept.png"]);
    expect(rotationDraft.result.current[0]).toBe("cw90");
    expect(strictLoad()).toEqual({ kind: "ready", entries: { [files]: { value: ["/kept.png"] }, [rotation]: { value: "cw90" } } });
    expect(document.activeElement?.id).toBe("main");
  });

  it("keeps an earlier backup and adds the new one beside it", async () => {
    const { values } = await boot({ [V2]: refusedRaw, [`${BACKUP}.0`]: "earlier unreadable drafts" });
    fireEvent.click(await screen.findByRole("button", { name: RECOVER }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());

    expect(values.get(`${BACKUP}.0`)).toBe("earlier unreadable drafts");
    expect(values.get(`${BACKUP}.1`)).toBe(refusedRaw);
  });

  it("reuses an identical backup wherever it is kept", async () => {
    const { values } = await boot({ [V2]: refusedRaw, [`${BACKUP}.0`]: "earlier unreadable drafts", [`${BACKUP}.2`]: refusedRaw });
    fireEvent.click(await screen.findByRole("button", { name: RECOVER }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());

    expect(values.has(`${BACKUP}.1`)).toBe(false);
    expect(values.get(`${BACKUP}.2`)).toBe(refusedRaw);
  });

  it("keeps drafts a newer Goop added in the backup while recovering the rest", async () => {
    const newer = JSON.stringify({ version: 2, entries: { [files]: { value: ["/kept.png"] }, [JSON.stringify(["image", "FutureFeature.option"])]: { value: "on" } } });
    const { values, strictLoad } = await boot({ [V2]: newer });
    fireEvent.click(await screen.findByRole("button", { name: RECOVER }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());

    expect(values.get(`${BACKUP}.0`)).toBe(newer);
    expect(strictLoad()).toEqual({ kind: "ready", entries: { [files]: { value: ["/kept.png"] }, [rotation]: { value: "cw90" } } });
  });

  it("changes nothing when the backup cannot be written, and says so", async () => {
    const { values, filesDraft } = await boot({ [V2]: refusedRaw }, { failBackup: true });
    fireEvent.click(await screen.findByRole("button", { name: RECOVER }));

    expect(screen.getByRole("alert").textContent).toContain("Nothing was recovered.");
    expect(values.get(V2)).toBe(refusedRaw);
    expect([...values.keys()].some(key => key.startsWith(BACKUP))).toBe(false);
    expect(filesDraft.result.current[0]).toEqual([]);
  });

  it("keeps entries only this session has when nothing saved can be read", async () => {
    const { values } = await boot({ [V2]: "{" });
    fireEvent.click(await screen.findByRole("button", { name: RECOVER }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());

    expect(values.get(`${BACKUP}.0`)).toBe("{");
    expect(JSON.parse(values.get(V2) ?? "{}").entries)
      .toEqual({ [files]: { value: [] }, [rotation]: { value: "cw90" } });
  });

  it("recovers from unreadable drafts in the older format too", async () => {
    const legacy = JSON.stringify({ version: 1, entries: "not entries" });
    const { values, strictLoad } = await boot({ [V1]: legacy });
    fireEvent.click(await screen.findByRole("button", { name: RECOVER }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());

    expect(values.get(`${BACKUP}.0`)).toBe(legacy);
    expect(strictLoad().kind).toBe("ready");
  });

  it("does not overwrite edits a newer Goop saved after this one started", async () => {
    const { values } = await boot({ [V2]: refusedRaw });
    const newer = JSON.stringify({ version: 3, entries: {} });
    values.set(V2, newer);
    fireEvent.click(await screen.findByRole("button", { name: RECOVER }));

    expect(values.get(V2)).toBe(newer);
    expect([...values.keys()].some(key => key.startsWith(BACKUP))).toBe(false);
  });

  it.each([
    ["edits saved by a newer Goop", { [V2]: JSON.stringify({ version: 3, entries: {} }) }, {}],
    ["storage that cannot be read", { [V2]: refusedRaw }, { unreadable: true }],
  ])("offers no recovery for %s", async (_label, saved, options) => {
    await boot(saved, options);
    expect((await screen.findByRole("alert")).textContent).toContain("Unfinished edits could not be saved for restart");
    expect(screen.queryByRole("button", { name: RECOVER })).toBeNull();
    expect(screen.queryByRole("button", { name: FORGET })).toBeNull();
  });

  it("offers no recovery but offers Forget for edits too large for this Goop to read", async () => {
    const tooLarge = JSON.stringify({ version: 2, entries: { [files]: { value: ["x".repeat(600 * 1024)] } } });
    const { values, strictLoad } = await boot({ [V2]: tooLarge });
    expect((await screen.findByRole("alert")).textContent)
      .toBe("Unfinished edits from earlier sessions are too large to restore. Your edits still work until you quit. Forget edits from earlier sessions");
    expect(screen.queryByRole("button", { name: RECOVER })).toBeNull();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: FORGET }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());

    expect(values.get(`${BACKUP}.0`)).toBe(tooLarge);
    expect(strictLoad()).toEqual({ kind: "ready", entries: { [files]: { value: [] }, [rotation]: { value: "cw90" } } });
    expect(document.activeElement?.id).toBe("main");
  });
});

describe("a full unfinished-edits store", () => {
  const V2 = "goop.workspace-drafts.v2";
  const V1 = "goop.workspace-drafts.v1";
  const BACKUP = "goop.workspace-drafts.v2.unreadable";
  const RECOVER = "Back up and recover what can be read";
  const files = JSON.stringify(["image", "ImagePage.files"]);
  const largeFiles = Array.from({ length: 150 }, (_, i) => `/${i}-${"x".repeat(4000)}.png`);
  const SESSION_TOO_LARGE = "Unfinished edits from this session are too large to keep after a restart (588 KB of 512 KB). Your edits still work until you quit.";
  const saved = (count: number) => JSON.stringify({ version: 2, entries: Object.fromEntries(Array.from({ length: count }, (_, i) =>
    [JSON.stringify(["image", "source", `/photo-${i}.png`, "ImageRotateFlow.degrees"]), { value: "cw90" }])) });

  async function boot(stored: Record<string, string>, field: { slot: string; initial: unknown } = { slot: "ImageRotateFlow.degrees", initial: "cw180" }, failWrites = { current: false }) {
    vi.resetModules();
    const values = new Map<string, string>(Object.entries(stored));
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (failWrites.current) throw new Error("quota");
        values.set(key, value);
      },
    });
    recorderState.current = recorder("noop");
    const drafts = await import("@/store/workspaceDrafts");
    const persistence = await import("@/store/workspacePersistence");
    const { default: Layout } = await import("../Layout");
    const wrapper = ({ children }: { children: ReactNode }) => createElement(drafts.WorkspaceDraftProvider, { tool: "image" }, children);
    render(<MemoryRouter><Layout /></MemoryRouter>);
    const draft = renderHook(() => drafts.useWorkspaceDraftState(field.slot, field.initial), { wrapper });
    const strictLoad = () => persistence.loadDraftEntriesOutcome({ getItem: key => values.get(key) ?? null, setItem: () => { throw new Error("must not write"); } });
    return { values, draft, strictLoad };
  }

  it("shows the counts and offers Forget instead of Try again", async () => {
    const { values } = await boot({ [V2]: saved(500) });

    expect((await screen.findByRole("alert")).textContent)
      .toBe("Too many unfinished edits to keep after a restart (501 of 500). Your edits still work until you quit. Forget edits from earlier sessions");
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: FORGET }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(values.get(`${BACKUP}.0`)).toBe(saved(500));
    expect(document.activeElement?.id).toBe("main");
  });

  it("says why nothing was forgotten when no backup slot is free", async () => {
    const slots = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`${BACKUP}.${i}`, `earlier backup ${i}`]));
    const { values } = await boot({ [V2]: saved(500), ...slots });

    fireEvent.click(await screen.findByRole("button", { name: FORGET }));

    expect(screen.getByRole("alert").textContent).toContain("Nothing was forgotten: there's no room to back up the saved edits first.");
    expect(values.get(V2)).toBe(saved(500));
  });

  it("says this session's own edits are too large, offers nothing more, and keeps focus in the page", async () => {
    await boot({ [V2]: saved(3) }, { slot: "ImagePage.files", initial: largeFiles });
    const forget = await screen.findByRole("button", { name: FORGET });
    forget.focus();
    expect(document.activeElement).toBe(forget);

    fireEvent.click(forget);

    expect(screen.getByRole("alert").textContent).toBe(SESSION_TOO_LARGE);
    expect(screen.queryByRole("button")).toBeNull();
    expect(document.activeElement?.id).toBe("main");
  });

  it("keeps Recover and Try again when recovered edits are over the limit, and saves once they fit", async () => {
    const { values, draft, strictLoad } = await boot({ [V2]: "{" }, { slot: "ImagePage.files", initial: largeFiles });
    fireEvent.click(await screen.findByRole("button", { name: RECOVER }));

    expect(screen.getByRole("alert").textContent).toContain(SESSION_TOO_LARGE);
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(values.get(`${BACKUP}.0`)).toBe("{");
    expect(values.get(V2)).toBe("{");

    act(() => draft.result.current[1](["/small.png"]));
    fireEvent.click(screen.getByRole("button", { name: RECOVER }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());

    expect(strictLoad()).toEqual({ kind: "ready", entries: { [files]: { value: ["/small.png"] } } });
  });

  it("keeps Try again when an unfinished migration is over the limit, and saves once it fits", async () => {
    const legacy = JSON.stringify({ version: 1, entries: { [files]: { value: ["/a.png"] } } });
    const failWrites = { current: true };
    const { values, draft, strictLoad } = await boot({ [V1]: legacy }, { slot: "ImagePage.files", initial: [] }, failWrites);
    expect(draft.result.current[0]).toEqual(["/a.png"]);
    act(() => draft.result.current[1](largeFiles));
    failWrites.current = false;
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));

    expect(screen.getByRole("alert").textContent).toContain(SESSION_TOO_LARGE);
    expect(values.has(V2)).toBe(false);

    act(() => draft.result.current[1](["/b.png"]));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());

    expect(strictLoad()).toEqual({ kind: "ready", entries: { [files]: { value: ["/b.png"] } } });
    expect(values.get(V1)).toBe(legacy);
  });

  it("keeps focus in the page when Forget is refused and its button goes away", async () => {
    const { values } = await boot({ [V2]: saved(500) });
    const forget = await screen.findByRole("button", { name: FORGET });
    forget.focus();
    values.set(V2, JSON.stringify({ version: 3, entries: {} }));

    fireEvent.click(forget);

    expect(screen.queryByRole("button", { name: FORGET })).toBeNull();
    expect(document.activeElement?.id).toBe("main");
  });

  it("says why a failed Forget could not finish when there's no room to back up a changed save", async () => {
    const slots = Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`${BACKUP}.${i}`, `earlier backup ${i}`]));
    const { values } = await boot({ [V2]: saved(500), ...slots });
    const forget = await screen.findByRole("button", { name: FORGET });
    let refuseV2 = true;
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { if (refuseV2 && key === V2) throw new Error("quota"); values.set(key, value); },
    });
    fireEvent.click(forget);
    expect(values.get(`${BACKUP}.4`)).toBe(saved(500));
    refuseV2 = false;
    const changed = saved(2);
    values.set(V2, changed);

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(screen.getByRole("alert").textContent).toContain("there's no room to back up the saved edits");
    expect(values.get(V2)).toBe(changed);
  });
});
