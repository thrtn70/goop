import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import type { Job } from "@/types";
import { useAppStore } from "@/store/appStore";
import HistoryGrid from "@/features/history/HistoryGrid";
import QuickViewModal from "../QuickViewModal";
import { useQuickView } from "../useQuickView";

vi.mock("@/hooks/useThumbnail", () => ({
  useThumbnail: () => ({ status: "unavailable" as const }),
}));

class IntersectionObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const initialHistory = useAppStore.getState().history;

function makeJob(id: string): Job {
  return {
    id,
    kind: "extract",
    state: "done",
    payload: null,
    result: { output_path: `/tmp/${id}.mp4`, bytes: 1n, duration_ms: 1n },
    priority: 0,
    attempts: 1,
    created_at: 1n,
    started_at: 1n,
    finished_at: 2n,
  } as Job;
}

function Harness({ onAction }: { onAction: () => void }) {
  const quick = useQuickView();
  if (!quick.currentJob) {
    return <button onClick={() => quick.open("first")}>Open quick view</button>;
  }
  return (
    <div>
      <span>{String(quick.currentJob.id)}</span>
      <button onClick={onAction}>Output action</button>
    </div>
  );
}

function GridModalHarness() {
  const quick = useQuickView();
  return (
    <>
      <HistoryGrid
        onPreview={() => {}}
        onQuickView={(job) => quick.open(job.id)}
      />
      <QuickViewModal job={quick.currentJob} onClose={quick.close} />
    </>
  );
}

beforeEach(() => {
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver =
    IntersectionObserverStub;
  useAppStore.setState({
    history: {
      ...initialHistory,
      jobs: [makeJob("first"), makeJob("second")],
      selectedIds: new Set<string>(),
    },
  });
});

afterEach(cleanup);

describe("useQuickView keyboard handling", () => {
  it("lets Space activate a focused action without closing Quick View", async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    render(<Harness onAction={onAction} />);

    await user.click(screen.getByRole("button", { name: "Open quick view" }));
    const action = screen.getByRole("button", { name: "Output action" });
    action.focus();
    await user.keyboard(" ");

    expect(onAction).toHaveBeenCalledOnce();
    expect(screen.getByText("first")).toBeTruthy();
  });

  it("still lets Escape close from a focused action", async () => {
    const user = userEvent.setup();
    render(<Harness onAction={() => {}} />);

    await user.click(screen.getByRole("button", { name: "Open quick view" }));
    screen.getByRole("button", { name: "Output action" }).focus();
    await user.keyboard("{Escape}");

    expect(screen.getByRole("button", { name: "Open quick view" })).toBeTruthy();
  });

  it("moves focus from a grid card into Quick View and restores it after Space closes", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <GridModalHarness />
      </MemoryRouter>,
    );
    const card = screen.getByTitle("/tmp/first.mp4").closest("button");
    expect(card).not.toBeNull();
    card!.focus();

    await user.keyboard(" ");
    const dialog = screen.getByRole("dialog", { name: "Quick view" });
    expect(document.activeElement).toBe(dialog);

    const dialogButtons = within(dialog).getAllByRole("button");
    await user.keyboard("{Tab}");
    expect(document.activeElement).toBe(dialogButtons[0]);
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(document.activeElement).toBe(dialogButtons.at(-1));
    await user.keyboard("{Tab}");
    expect(document.activeElement).toBe(dialogButtons[0]);

    dialog.focus();
    await user.keyboard(" ");
    expect(screen.queryByRole("dialog", { name: "Quick view" })).toBeNull();
    expect(document.activeElement).toBe(card);
  });
});
