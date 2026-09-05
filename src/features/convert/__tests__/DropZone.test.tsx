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
