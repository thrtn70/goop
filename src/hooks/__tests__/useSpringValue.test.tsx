import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { useSpringValue } from "@/hooks/useSpringValue";

function Probe({ target }: { target: number | null }) {
  const v = useSpringValue(target, 0.18);
  return <span data-testid="value">{v == null ? "null" : v.toFixed(3)}</span>;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

function readValue(container: HTMLElement): string {
  return container.querySelector('[data-testid="value"]')?.textContent ?? "";
}

describe("useSpringValue", () => {
  it("snaps immediately when initial target is provided", () => {
    const { container } = render(<Probe target={42} />);
    expect(readValue(container)).toBe("42.000");
  });

  it("snaps to null when target becomes null", () => {
    const { container, rerender } = render(<Probe target={10} />);
    rerender(<Probe target={null} />);
    expect(readValue(container)).toBe("null");
  });

  it("snaps from null to a number rather than interpolating from 'unknown'", () => {
    const { container, rerender } = render(<Probe target={null} />);
    rerender(<Probe target={20} />);
    expect(readValue(container)).toBe("20.000");
  });

  it("does not snap to the new target on the first render after a change", () => {
    // The settle is asynchronous via requestAnimationFrame. We can't
    // reliably advance rAF + flush React updates under fake timers in
    // this environment, so this test verifies the synchronous-render
    // contract: when transitioning between two real numbers, the
    // visible value is NOT immediately the new target — it's still
    // the old one until at least one rAF tick lands.
    const { container, rerender } = render(<Probe target={0} />);
    expect(readValue(container)).toBe("0.000");
    rerender(<Probe target={100} />);
    // Without rAF having run, value is still the previous one.
    expect(readValue(container)).toBe("0.000");
  });
});
