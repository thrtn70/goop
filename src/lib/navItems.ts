/**
 * Stable destination registry shared by keyboard bindings and the palette.
 * Shortcuts preserve their established mapping; NAV_SECTIONS controls the
 * workspace's visual grouping without changing those bindings.
 */

/** Which band of the nav an item belongs to. Tools do work; manage looks at
 *  what the work produced. The nav draws a divider between the two. */
export type NavGroup = "tool" | "manage";

/**
 * Deliberately a digit union rather than `string`. `useHotkeys` turns this
 * into a `$mod+<shortcut>` binding alongside hand-written ones for k, comma,
 * n and o — so a nav item typed loosely enough to hold `"k"` could silently
 * shadow the command palette. Widening this past `"9"` is also a real
 * decision, not a typo: there is no ⌘10.
 */
export type NavShortcut = "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9";

export interface NavItem {
  readonly to: string;
  readonly label: string;
  /** Established digit pressed with the platform modifier key. */
  readonly shortcut: NavShortcut;
  readonly group: NavGroup;
  /** Extra context, shown in the command palette only. */
  readonly hint?: string;
}

export const NAV_ITEMS: readonly NavItem[] = [
  { to: "/extract", label: "Extract", shortcut: "1", group: "tool" },
  { to: "/convert", label: "Convert", shortcut: "2", group: "tool" },
  { to: "/image", label: "Image", shortcut: "3", group: "tool" },
  {
    to: "/recognize",
    label: "Recognize",
    shortcut: "4",
    group: "tool",
    hint: "Pull text out of a PDF or image",
  },
  {
    to: "/metadata",
    label: "Metadata",
    shortcut: "5",
    group: "tool",
    hint: "Edit audio tags & cover art, view EXIF/PDF info",
  },
  { to: "/compress", label: "Compress", shortcut: "6", group: "tool" },
  { to: "/history", label: "History", shortcut: "7", group: "manage" },
  { to: "/settings", label: "Settings", shortcut: "8", group: "manage" },
];

/** True when this item starts a new band and the nav should rule above it. */
export function startsNewGroup(index: number): boolean {
  if (index === 0) return false;
  return NAV_ITEMS[index].group !== NAV_ITEMS[index - 1].group;
}

/** Presentation order references registry entries so labels and shortcuts stay shared. */
export const NAV_SECTIONS = [
  { label: "Main tools", routes: ["/extract", "/convert", "/compress"] },
  { label: "Tools", routes: ["/image", "/metadata", "/recognize"] },
  { label: "Manage", routes: ["/history", "/settings"] },
].map(section => ({
  label: section.label,
  items: section.routes.flatMap(route => NAV_ITEMS.filter(item => item.to === route)),
}));
