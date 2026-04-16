import { NavLink } from "react-router-dom";
import clsx from "clsx";

const items = [
  { to: "/extract", label: "Extract" },
  { to: "/convert", label: "Convert" },
  { to: "/history", label: "History" },
  { to: "/settings", label: "Settings" },
];

export default function LeftNav() {
  return (
    <nav className="flex w-48 flex-col border-r border-neutral-800 bg-neutral-950 py-3">
      {items.map((it) => (
        <NavLink
          key={it.to}
          to={it.to}
          className={({ isActive }) =>
            clsx(
              "mx-2 rounded px-3 py-2 text-sm transition",
              isActive
                ? "bg-sky-600 text-white"
                : "text-neutral-400 hover:bg-neutral-800 hover:text-white"
            )
          }
        >
          {it.label}
        </NavLink>
      ))}
    </nav>
  );
}
