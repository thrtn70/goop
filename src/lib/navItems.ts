/**
 * The app's primary destinations, in the order they appear in the left nav.
 *
 * This is the single source of truth for three consumers that used to each
 * hold their own copy: the nav itself, the global hotkey map, and the command
 * palette. They drifted — the nav rendered ⌘1,⌘2,⌘3,⌘7,⌘8,⌘4,⌘5,⌘6 down the
 * list because two routes were appended later and parked on 7 and 8 to avoid
 * disturbing the existing bindings. Deriving all three from this array means
 * that class of drift can't come back: the shortcut is a property of the
 * destination, not something each consumer restates.
 *
 * Shortcuts are the array index + 1, which `navItems.test.ts` enforces.
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
  /** Digit pressed with the platform mod key. Matches display position. */
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
