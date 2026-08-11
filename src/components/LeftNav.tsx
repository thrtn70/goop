import { Fragment, useEffect, useRef, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import clsx from "clsx";
import { NAV_ITEMS, startsNewGroup } from "@/lib/navItems";
import { modKeyLabel } from "@/lib/platform";

const items = NAV_ITEMS;

export default function LeftNav() {
  const location = useLocation();
  const navRef = useRef<HTMLElement>(null);
  const itemRefs = useRef<(HTMLAnchorElement | null)[]>([]);
  const [pill, setPill] = useState<{ top: number; height: number } | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const activeIdx = items.findIndex((it) => location.pathname.startsWith(it.to));
    const el = itemRefs.current[activeIdx];
    const nav = navRef.current;
    if (!el || !nav) return;

    const navRect = nav.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    setPill({
      top: elRect.top - navRect.top,
      height: elRect.height,
    });

    // Enable transition after first measurement to avoid flash on mount
    if (!ready) {
      requestAnimationFrame(() => setReady(true));
    }
  }, [location.pathname, ready]);

  const mod = modKeyLabel();

  return (
    <nav ref={navRef} className="relative flex w-48 flex-col border-r border-subtle bg-surface-1 py-3">
      {/* Sliding pill indicator. Inset by 12px (left-3 right-3) — 4px
       *  inside the item's outer edge, 8px outside the content edge —
       *  so the pill wraps the text and kbd snugly without bleeding to
       *  the row's hard outer extent. */}
      {pill && (
        <div
          className={clsx(
            // top-0 is load-bearing: without it the pill's static position
            // starts after the nav's py-3 padding, and the translateY below
            // (measured from the nav's border box) adds that 12px a second
            // time, leaving the pill one padding-step below its row.
            "absolute left-3 right-3 top-0 rounded-md bg-accent-strong",
            ready ? "transition-transform duration-normal ease-out" : "",
          )}
          style={{ transform: `translateY(${pill.top}px)`, height: pill.height }}
          aria-hidden="true"
        />
      )}

      {items.map((it, i) => (
        <Fragment key={it.to}>
          {/* One rule between the tools and the two places you go to look at
              what they produced. Purely visual — the labels already
              distinguish them for a screen reader. */}
          {startsNewGroup(i) && (
            <hr className="mx-5 my-2 border-t border-subtle" aria-hidden="true" />
          )}
        <NavLink
          to={it.to}
          ref={(el) => { itemRefs.current[i] = el; }}
          title={`${it.label} (${mod}${it.shortcut})`}
          className={({ isActive }) =>
            clsx(
              // Body face, not --font-display: this is a UI label, and the
              // product register keeps the display face for section headings
              // and empty-state headlines.
              "relative z-10 mx-2 flex items-center justify-between rounded-md px-3 py-2 text-sm font-medium transition duration-fast ease-out",
              isActive
                ? "text-accent-fg"
                : "text-fg-secondary hover:bg-surface-3 hover:text-fg"
            )
          }
        >
          {({ isActive }) => (
            <>
              <span>{it.label}</span>
              <kbd
                className={clsx(
                  "ml-2 rounded px-1 font-mono text-xs",
                  isActive
                    ? "bg-scrim/30 text-accent-fg"
                    // --fg-muted cannot clear AA on --surface-3 (4.00:1), so
                    // anything sitting on that surface steps up to secondary.
                    : "bg-surface-3 text-fg-secondary",
                )}
                aria-hidden="true"
              >
                {mod}
                {it.shortcut}
              </kbd>
            </>
          )}
        </NavLink>
        </Fragment>
      ))}
    </nav>
  );
}
