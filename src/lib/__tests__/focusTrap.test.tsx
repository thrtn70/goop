import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useRef, type KeyboardEvent } from "react";
import { trapTab } from "@/lib/focusTrap";

function Trap({ controls }: { controls: "none" | "two" | "disabled-first" }) {
  const ref = useRef<HTMLDivElement | null>(null);
  return (
    <div
      ref={ref}
      role="group"
      aria-label="trap"
      tabIndex={-1}
      onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => ref.current && trapTab(event, ref.current)}
    >
      {controls === "disabled-first" && <button disabled>skipped</button>}
      {controls !== "none" && <button>first</button>}
      {controls !== "none" && <button>last</button>}
      {controls !== "none" && <a>no href, not a stop</a>}
    </div>
  );
}

afterEach(cleanup);

describe("trapTab", () => {
  it("wraps forward from the last control and backward from the first", () => {
    render(<Trap controls="two" />);
    const first = screen.getByRole("button", { name: "first" });
    const last = screen.getByRole("button", { name: "last" });
    last.focus();
    expect(fireEvent.keyDown(last, { key: "Tab" })).toBe(false);
    expect(document.activeElement).toBe(first);
    expect(fireEvent.keyDown(first, { key: "Tab", shiftKey: true })).toBe(false);
    expect(document.activeElement).toBe(last);
  });

  it("lets Tab move on naturally from a control in the middle", () => {
    render(<Trap controls="two" />);
    const first = screen.getByRole("button", { name: "first" });
    first.focus();
    expect(fireEvent.keyDown(first, { key: "Tab" })).toBe(true);
    expect(document.activeElement).toBe(first);
  });

  it("sends focus to the first or last control when the container itself holds it", () => {
    render(<Trap controls="two" />);
    const group = screen.getByRole("group");
    group.focus();
    expect(fireEvent.keyDown(group, { key: "Tab" })).toBe(false);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "first" }));
    group.focus();
    expect(fireEvent.keyDown(group, { key: "Tab", shiftKey: true })).toBe(false);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "last" }));
  });

  it("keeps focus on the container when it has nothing focusable", () => {
    render(<Trap controls="none" />);
    const group = screen.getByRole("group");
    group.focus();
    expect(fireEvent.keyDown(group, { key: "Tab" })).toBe(false);
    expect(document.activeElement).toBe(group);
  });

  it("ignores disabled controls and keys other than Tab", () => {
    render(<Trap controls="disabled-first" />);
    const first = screen.getByRole("button", { name: "first" });
    first.focus();
    expect(fireEvent.keyDown(first, { key: "Tab", shiftKey: true })).toBe(false);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "last" }));
    expect(fireEvent.keyDown(first, { key: "Enter" })).toBe(true);
  });
});
