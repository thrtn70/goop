import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import DropZone from "@/features/convert/DropZone";

// Tauri's window.onDragDropEvent isn't available in jsdom. Mock it to
// a no-op subscribe so DropZone mounts without trying to reach the
// platform layer. Component-level state transitions are out of scope
// for this test — we only verify the static structural elements that
// the empty/idle render produces (perimeter SVG, child slot).
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onDragDropEvent: vi.fn().mockResolvedValue(() => {}),
  }),
}));

afterEach(() => {
  cleanup();
});

describe("DropZone", () => {
  it("renders the perimeter SVG and the children slot", () => {
    const { container } = render(
      <DropZone onFiles={() => {}}>
        <div data-testid="child">Hello</div>
      </DropZone>,
    );
    expect(container.querySelector("svg")).not.toBeNull();
    expect(container.querySelector('[data-testid="child"]')?.textContent).toBe("Hello");
  });

  it("idle perimeter uses the static stroke class (no flow)", () => {
    const { container } = render(
      <DropZone onFiles={() => {}}>
        <div />
      </DropZone>,
    );
    const rect = container.querySelector("rect");
    expect(rect?.getAttribute("class")).toContain("dropzone-stroke-static");
    expect(rect?.getAttribute("class")).not.toContain("dropzone-stroke-flow");
  });
});
