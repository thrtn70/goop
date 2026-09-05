import { useEffect, useRef } from "react";
import { useAppStore } from "@/store/appStore";
import { useLocation } from "react-router-dom";
import { Link2 } from "lucide-react";
import { NAV_ITEMS } from "@/lib/navItems";
import { useWorkspaceDraftState, withWorkspaceDrafts } from "@/store/workspaceDrafts";

type Props = { onSubmit: (url: string) => void };

function TopBar({ onSubmit }: Props) {
  const [url, setUrl] = useWorkspaceDraftState("TopBar.url", "");
  const location = useLocation();
  const title = NAV_ITEMS.find(item => location.pathname.startsWith(item.to))?.label ?? "Goop";
  const inputRef = useRef<HTMLInputElement>(null);
  const focusToken = useAppStore((s) => s.pendingFocusUrlInput);
  // Phase H: Cmd+N increments `pendingFocusUrlInput`. Mirror that increment
  // into the URL input by focusing + selecting on every change > 0.
  useEffect(() => {
    if (focusToken > 0) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [focusToken]);
  return (
    <header className="workspace-topbar">
      <span className="workspace-tool-title">{title}</span>
      <div className="workspace-url">
      <Link2 size={15} aria-hidden="true" className="shrink-0 text-fg-muted" />
      <input
        ref={inputRef}
        type="text"
        value={url}
        aria-label="Paste URL to download"
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && url.trim()) {
            onSubmit(url.trim());
            setUrl("");
          }
        }}
        placeholder="Paste a link and press Enter..."
        className="min-w-0 flex-1 rounded bg-transparent py-1 text-sm text-fg placeholder:text-fg-muted focus:outline-none"
      />
      </div>
    </header>
  );
}

export default withWorkspaceDrafts(TopBar, "extract");
