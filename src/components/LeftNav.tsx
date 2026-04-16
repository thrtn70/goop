import { useEffect, useRef, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import clsx from "clsx";

const items = [
  { to: "/extract", label: "Extract" },
  { to: "/convert", label: "Convert" },
  { to: "/history", label: "History" },
  { to: "/settings", label: "Settings" },
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

  return (
    <nav ref={navRef} className="relative flex w-48 flex-col border-r border-subtle bg-surface-1 py-3">
      {/* Sliding pill indicator */}
      {pill && (
        <div
          className={clsx(
            "absolute left-2 right-2 rounded-md bg-accent",
            ready ? "transition-transform duration-normal ease-out" : "",
          )}
          style={{ transform: `translateY(${pill.top}px)`, height: pill.height }}
          aria-hidden
        />
      )}

      {items.map((it, i) => (
        <NavLink
          key={it.to}
          to={it.to}
          ref={(el) => { itemRefs.current[i] = el; }}
          className={({ isActive }) =>
            clsx(
              "relative z-10 mx-2 rounded-md px-3 py-2 font-display text-sm font-medium transition duration-fast ease-out",
              isActive
                ? "text-accent-fg"
                : "text-fg-secondary hover:bg-surface-3 hover:text-fg"
            )
          }
        >
          {it.label}
        </NavLink>
      ))}
    </nav>
  );
}
