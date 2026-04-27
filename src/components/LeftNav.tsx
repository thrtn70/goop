import { useEffect, useRef, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import clsx from "clsx";
import { modKeyLabel } from "@/lib/platform";

const items = [
  { to: "/extract", label: "Extract", shortcut: "1" },
  { to: "/convert", label: "Convert", shortcut: "2" },
  { to: "/compress", label: "Compress", shortcut: "3" },
  { to: "/history", label: "History", shortcut: "4" },
  { to: "/settings", label: "Settings", shortcut: "5" },
];

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
            "absolute left-3 right-3 rounded-md bg-accent-strong",
            ready ? "transition-transform duration-normal ease-out" : "",
          )}
          style={{ transform: `translateY(${pill.top}px)`, height: pill.height }}
          aria-hidden="true"
        />
      )}

      {items.map((it, i) => (
        <NavLink
          key={it.to}
          to={it.to}
          ref={(el) => { itemRefs.current[i] = el; }}
          title={`${it.label} (${mod}${it.shortcut})`}
          className={({ isActive }) =>
            clsx(
              "relative z-10 mx-2 flex items-center justify-between rounded-md px-3 py-2 font-display text-sm font-medium transition duration-fast ease-out",
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
                  "ml-2 rounded px-1 font-mono text-[10px]",
                  isActive
                    ? "bg-scrim/30 text-accent-fg"
                    : "bg-surface-3 text-fg-muted",
                )}
                aria-hidden="true"
              >
                {mod}
                {it.shortcut}
              </kbd>
            </>
          )}
        </NavLink>
      ))}
    </nav>
  );
}
