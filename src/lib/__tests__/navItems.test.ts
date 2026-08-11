import { describe, expect, it } from "vitest";
import { NAV_ITEMS, startsNewGroup } from "@/lib/navItems";

describe("NAV_ITEMS", () => {
  it("numbers shortcuts by display position", () => {
    // The defect this file exists to prevent: the nav used to read
    // ⌘1, ⌘2, ⌘3, ⌘7, ⌘8, ⌘4, ⌘5, ⌘6 top to bottom, because two routes were
    // added later and parked on the free digits.
    expect(NAV_ITEMS.map((i) => i.shortcut)).toEqual(
      NAV_ITEMS.map((_, idx) => String(idx + 1)),
    );
  });

  it("has no duplicate routes or shortcuts", () => {
    expect(new Set(NAV_ITEMS.map((i) => i.to)).size).toBe(NAV_ITEMS.length);
    expect(new Set(NAV_ITEMS.map((i) => i.shortcut)).size).toBe(NAV_ITEMS.length);
  });

  it("keeps routes mutually non-prefixing", () => {
    // LeftNav picks the active item with
    // `NAV_ITEMS.findIndex(i => pathname.startsWith(i.to))`. That is only
    // sound while no route is a prefix of another — add "/image" alongside an
    // "/images" and the pill would highlight whichever sits earlier in the
    // array, not the route you are actually on. Cheaper to forbid the shape
    // here than to make every consumer defensive.
    for (const a of NAV_ITEMS) {
      for (const b of NAV_ITEMS) {
        if (a.to === b.to) continue;
        expect(b.to.startsWith(a.to), `"${a.to}" is a prefix of "${b.to}"`).toBe(false);
      }
    }
  });

  it("keeps each group contiguous so one divider can separate them", () => {
    // Rendering draws a rule wherever the group changes. If a group were
    // interleaved the nav would sprout several dividers instead of one.
    const changes = NAV_ITEMS.filter((_, idx) => startsNewGroup(idx));
    expect(changes).toHaveLength(1);
    expect(changes[0]?.to).toBe("/history");
  });

  it("never reports a divider above the first item", () => {
    expect(startsNewGroup(0)).toBe(false);
  });

  it("gives every item a route and a label", () => {
    for (const item of NAV_ITEMS) {
      expect(item.to.startsWith("/"), item.to).toBe(true);
      expect(item.label.length).toBeGreaterThan(0);
    }
  });
});
