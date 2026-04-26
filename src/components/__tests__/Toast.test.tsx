import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import Toast from "@/components/Toast";
import type { Toast as ToastData } from "@/store/appStore";

vi.mock("@/ipc/commands", () => ({
  api: {
    queue: { reveal: vi.fn() },
  },
}));

function makeToast(overrides: Partial<ToastData> = {}): ToastData {
  return {
    id: "t1",
    variant: "info",
    title: "Hello",
    detail: undefined,
    outputPath: undefined,
    dismissAt: null,
    createdAt: Date.now(),
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

describe("Toast variant a11y semantics", () => {
  it("info variant uses role=status + aria-live=polite", () => {
    render(<Toast toast={makeToast({ variant: "info" })} onDismiss={() => {}} />);
    const node = screen.getByRole("status");
    expect(node.getAttribute("aria-live")).toBe("polite");
  });

  it("success variant uses role=status + aria-live=polite", () => {
    render(<Toast toast={makeToast({ variant: "success" })} onDismiss={() => {}} />);
    const node = screen.getByRole("status");
    expect(node.getAttribute("aria-live")).toBe("polite");
  });

  it("error variant uses role=alert + aria-live=assertive", () => {
    render(<Toast toast={makeToast({ variant: "error", title: "Boom" })} onDismiss={() => {}} />);
    const node = screen.getByRole("alert");
    expect(node.getAttribute("aria-live")).toBe("assertive");
  });

  it("cancelled variant uses role=status + aria-live=polite", () => {
    render(<Toast toast={makeToast({ variant: "cancelled" })} onDismiss={() => {}} />);
    const node = screen.getByRole("status");
    expect(node.getAttribute("aria-live")).toBe("polite");
  });
});
