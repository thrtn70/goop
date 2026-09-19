import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import ToastContainer from "@/components/ToastContainer";
import { useAppStore } from "@/store/appStore";

beforeEach(() => {
  const root = document.createElement("div");
  root.id = "toast-root";
  document.body.appendChild(root);
  useAppStore.setState({
    toasts: [
      {
        id: "toast-1",
        variant: "success",
        title: "Finished clip.mp4",
        detail: undefined,
        outputPath: undefined,
        dismissAt: null,
        createdAt: Date.now(),
      },
    ],
  });
});

afterEach(() => {
  cleanup();
  document.getElementById("toast-root")?.remove();
  useAppStore.setState({ toasts: [] });
});

describe("ToastContainer live-region ownership", () => {
  it("leaves each toast as the only semantic announcement owner", () => {
    render(<ToastContainer />);

    const toast = screen.getByRole("status");
    expect(toast.getAttribute("aria-live")).toBe("polite");

    const wrapper = toast.closest<HTMLElement>("[data-toast-id]");
    const stack = wrapper?.parentElement;
    expect(stack?.getAttribute("aria-live")).toBeNull();
    expect(stack?.getAttribute("aria-relevant")).toBeNull();
  });

  it("mounts a semantic owner for every toast beyond the visual cap", () => {
    useAppStore.setState({
      toasts: Array.from({ length: 5 }, (_, index) => ({
        id: `toast-${index + 1}`,
        variant: "success" as const,
        title: `Finished file ${index + 1}`,
        detail: undefined,
        outputPath: undefined,
        dismissAt: null,
        createdAt: Date.now() + index,
      })),
    });

    render(<ToastContainer />);

    const owners = screen.getAllByRole("status");
    expect(owners).toHaveLength(5);
    const wrappers = owners.map((node) =>
      node.closest<HTMLElement>("[data-toast-id]"),
    );
    expect(
      wrappers.filter((node) => node?.classList.contains("sr-only")),
    ).toHaveLength(2);
  });

  it("keeps the toast that owns keyboard focus in the visual set", async () => {
    const toasts = Array.from({ length: 5 }, (_, index) => ({
      id: `toast-${index + 1}`,
      variant: "success" as const,
      title: `Finished file ${index + 1}`,
      detail: undefined,
      outputPath: undefined,
      dismissAt: null,
      createdAt: Date.now() + index,
    }));
    useAppStore.setState({ toasts: toasts.slice(0, 3) });
    render(<ToastContainer />);

    const focusedAction = screen.getByRole("button", {
      name: "Dismiss: Finished file 1",
    });
    focusedAction.focus();
    expect(document.activeElement).toBe(focusedAction);

    act(() => {
      useAppStore.setState({ toasts });
    });

    const focusedWrapper = document.querySelector<HTMLElement>(
      '[data-toast-id="toast-1"]',
    );
    expect(focusedWrapper).not.toBeNull();
    await waitFor(() =>
      expect(within(focusedWrapper!).getByRole("status").textContent).toBe(
        "Finished file 1",
      ),
    );
    expect(focusedWrapper?.classList.contains("sr-only")).toBe(false);
    expect(document.activeElement).toBe(focusedAction);
    expect(screen.getAllByRole("button", { name: /^Dismiss:/ })).toHaveLength(3);
  });
});
