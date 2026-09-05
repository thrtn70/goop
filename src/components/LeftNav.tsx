import { NavLink } from "react-router-dom";
import clsx from "clsx";
import { ArrowDownToLine, ArrowLeftRight, Minimize2, Image, ScanText, Tags, History, Settings, type LucideIcon } from "lucide-react";
import { NAV_SECTIONS } from "@/lib/navItems";
import { modKeyLabel } from "@/lib/platform";
import BrandMark from "./BrandMark";

const icons: Record<string, LucideIcon> = {
  "/extract": ArrowDownToLine, "/convert": ArrowLeftRight, "/compress": Minimize2,
  "/image": Image, "/recognize": ScanText, "/metadata": Tags, "/history": History, "/settings": Settings,
};

export default function LeftNav() {
  const mod = modKeyLabel();
  return (
    <nav aria-label="Primary navigation" className="workspace-nav">
      <div className="workspace-brand"><BrandMark size={23} /><span>goop</span></div>
      {NAV_SECTIONS.map(section => (
        <div key={section.label} role="group" aria-label={section.label}
          className={clsx("workspace-nav-group", section.label === "Manage" && "workspace-nav-manage")}>
          {section.label === "Tools" && <div className="workspace-nav-label">Tools</div>}
          {section.items.map(item => {
            const Icon = icons[item.to];
            return <NavLink key={item.to} to={item.to} title={`${item.label} (${mod}${item.shortcut})`}
              className={({isActive}) => clsx("workspace-nav-link", isActive && "is-active")}>
              {Icon && <Icon size={16} strokeWidth={1.75} aria-hidden="true" />}
              <span>{item.label}</span>
              <kbd className="workspace-nav-key" aria-hidden="true">{mod}{item.shortcut}</kbd>
            </NavLink>;
          })}
        </div>
      ))}
    </nav>
  );
}
