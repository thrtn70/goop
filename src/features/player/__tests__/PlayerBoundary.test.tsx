import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PlayerBoundary from "@/features/player/PlayerBoundary";

function Boom({ explode }: { explode: boolean }) {
  if (explode) throw new Error("player exploded");
  return <p>fine</p>;
}

// jsdom prints a render error as "Uncaught" before React hands it to the boundary; claim the expected one.
const claimExpectedError = (event: ErrorEvent) => {
  if (event.error?.message === "player exploded") event.preventDefault();
};

beforeEach(() => {
  // React and the boundary both report the caught error; the output is expected here.
  vi.spyOn(console, "error").mockImplementation(() => {});
  window.addEventListener("error", claimExpectedError);
});

afterEach(() => {
  window.removeEventListener("error", claimExpectedError);
  cleanup();
  vi.restoreAllMocks();
});

describe("PlayerBoundary", () => {
  it("renders its children when nothing throws", () => {
    render(<PlayerBoundary resetKey="a"><Boom explode={false} /></PlayerBoundary>);
    expect(screen.getByText("fine")).toBeTruthy();
  });

  it("shows a quiet status in place of a child that throws, and does not rethrow", () => {
    expect(() => render(<PlayerBoundary resetKey="a"><Boom explode /></PlayerBoundary>)).not.toThrow();
    expect(screen.getByRole("status").textContent).toBe("Preview unavailable.");
  });

  it("keeps the fallback while the key is unchanged", () => {
    const { rerender } = render(<PlayerBoundary resetKey="a"><Boom explode /></PlayerBoundary>);
    rerender(<PlayerBoundary resetKey="a"><Boom explode={false} /></PlayerBoundary>);
    expect(screen.getByRole("status").textContent).toBe("Preview unavailable.");
  });

  it("tries its children again when the key changes", () => {
    const { rerender } = render(<PlayerBoundary resetKey="a"><Boom explode /></PlayerBoundary>);
    rerender(<PlayerBoundary resetKey="b"><Boom explode={false} /></PlayerBoundary>);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByText("fine")).toBeTruthy();
  });

  it("logs the caught error so the failure leaves a trace", () => {
    render(<PlayerBoundary resetKey="a"><Boom explode /></PlayerBoundary>);
    expect(console.error).toHaveBeenCalledWith("Source player failed", expect.objectContaining({ message: "player exploded" }));
  });
});
