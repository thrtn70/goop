import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import DropZone from "@/features/convert/DropZone";

const callbacks: ((event: {
  payload: { type: string; paths?: string[] };
}) => void)[] = [];
const unlisten = vi.fn();
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onDragDropEvent: (
      callback: (event: {
        payload: { type: string; paths?: string[] };
      }) => void,
    ) => {
      callbacks.push(callback);
      return Promise.resolve(unlisten);
    },
  }),
}));
beforeEach(() => {
  callbacks.length = 0;
  unlisten.mockClear();
});

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
    expect(container.querySelector('[data-testid="child"]')?.textContent).toBe(
      "Hello",
    );
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

  // WebKit (the macOS webview) parses SVG geometry attributes as plain SVG
  // lengths and rejects calc(), logging "Invalid value for <rect> attribute"
  // on every mount and leaving the DOM length at 0. Current WebKit still drew
  // the perimeter through the attribute's CSS mapping; whether WebKit at the
  // macOS floor does too is unverified, so nothing should depend on it.
  it("perimeter geometry is plain SVG lengths every webview parses", () => {
    const svgLength = /^[+-]?(\d+(\.\d*)?|\.\d+)(e[+-]?\d+)?(px|%)?$/i;
    const { container } = render(
      <DropZone onFiles={() => {}}>
        <div />
      </DropZone>,
    );
    const rect = container.querySelector("rect");
    for (const name of ["x", "y", "width", "height", "rx", "ry"]) {
      const value = rect?.getAttribute(name);
      if (value !== null && value !== undefined) {
        expect(value, name).toMatch(svgLength);
      }
    }
    expect(rect?.getAttribute("width")).toBe("100%");
    expect(rect?.getAttribute("height")).toBe("100%");
    expect(rect?.getAttribute("style") ?? "").not.toContain("calc(");
  });

  it("perimeter svg sits 1px inside the zone and leaves the stroke unclipped", () => {
    const { container } = render(
      <DropZone onFiles={() => {}}>
        <div />
      </DropZone>,
    );
    // The rect fills the svg, so the svg box carries the 1px inset the rect
    // used to. Its 2px stroke straddles the svg edge, so the svg must not
    // clip the outer half.
    const svg = container.querySelector("svg");
    for (const cls of [
      "left-px",
      "top-px",
      "w-[calc(100%-2px)]",
      "h-[calc(100%-2px)]",
      "overflow-visible",
    ]) {
      expect(svg?.classList.contains(cls), cls).toBe(true);
    }
  });
});

for (const compact of [false, true]) {
  it(
    "delivers one drop and retires its listener in compact=" + compact,
    async () => {
      const receive = vi.fn();
      const view = render(
        <DropZone onFiles={receive} compact={compact}>
          <p>Drop here</p>
        </DropZone>,
      );
      await waitFor(() => expect(callbacks).toHaveLength(1));
      act(() =>
        callbacks[0]({ payload: { type: "drop", paths: ["/source.mp4"] } }),
      );
      expect(receive).toHaveBeenCalledExactlyOnceWith(["/source.mp4"]);
      view.unmount();
      await waitFor(() => expect(unlisten).toHaveBeenCalledOnce());
      act(() =>
        callbacks[0]({ payload: { type: "drop", paths: ["/retired.mp4"] } }),
      );
      expect(receive).toHaveBeenCalledTimes(1);
    },
  );
}
