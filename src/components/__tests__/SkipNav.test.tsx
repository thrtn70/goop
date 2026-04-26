import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import SkipNav from "@/components/SkipNav";

afterEach(() => {
  cleanup();
});

describe("SkipNav", () => {
  it("renders an anchor pointing at #main", () => {
    render(<SkipNav />);
    const link = screen.getByRole("link", { name: /skip to main content/i }) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("#main");
  });

  it("is in the DOM but visually hidden by default (sr-only)", () => {
    render(<SkipNav />);
    const link = screen.getByRole("link", { name: /skip to main content/i });
    expect(link.className).toContain("sr-only");
  });

  it("becomes visible on focus via focus-visible:not-sr-only", () => {
    render(<SkipNav />);
    const link = screen.getByRole("link", { name: /skip to main content/i });
    // The class string should include the focus-visible escape so focus
    // reveals the link. We assert presence rather than computed style
    // because jsdom doesn't implement focus-visible matching.
    expect(link.className).toContain("focus-visible:not-sr-only");
  });
});
