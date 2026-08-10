import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

/**
 * The expander has shipped since v0.2.x with no coverage at all. The batch
 * failure toast now routes multi-line text through it, so what it does with
 * newlines and with an absent detail is load-bearing rather than incidental.
 */
describe("Toast details expander", () => {
  const DETAIL = "a.example/one — The site blocked the request.\n…and 2 more";

  it("keeps an error detail behind a toggle", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <Toast toast={makeToast({ variant: "error", title: "3 files failed", detail: DETAIL })} onDismiss={() => {}} />,
    );
    expect(container.querySelector("pre")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Details" }));
    // Read off the node: `getByText` collapses the newlines separating the
    // per-file reasons, which is the whole shape of this text.
    expect(container.querySelector("pre")?.textContent).toBe(DETAIL);

    await user.click(screen.getByRole("button", { name: "Hide details" }));
    expect(container.querySelector("pre")).toBeNull();
  });

  it("caps the detail block so a long one cannot strand the toast", async () => {
    // The container grows upward from the bottom of the viewport and an
    // error toast never auto-dismisses, so an uncapped block pushes the
    // title, the toggle and the dismiss button off the top of the screen
    // and leaves the user with no way to close it.
    const user = userEvent.setup();
    const { container } = render(
      <Toast
        toast={makeToast({ variant: "error", title: "Boom", detail: "line\n".repeat(400) })}
        onDismiss={() => {}}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Details" }));
    const pre = container.querySelector("pre");
    expect(pre?.className).toContain("max-h-");
    expect(pre?.className).toContain("overflow-auto");
    expect(pre?.getAttribute("tabindex")).toBe("0");
  });

  it("offers no expander when there is no detail", () => {
    render(<Toast toast={makeToast({ variant: "error", title: "Boom" })} onDismiss={() => {}} />);
    expect(screen.queryByRole("button", { name: "Details" })).toBeNull();
  });

  it("shows a non-error detail inline rather than behind a toggle", () => {
    // Only failures are worth a click to read. A success's detail is a
    // filename, not a traceback.
    render(
      <Toast toast={makeToast({ variant: "info", title: "2 done · 1 failed", detail: "clip.mp4" })} onDismiss={() => {}} />,
    );
    expect(screen.getByText("clip.mp4")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Details" })).toBeNull();
  });
});
