import { useEffect, useRef, useState } from "react";
import { useAppStore } from "@/store/appStore";

type Props = { onSubmit: (url: string) => void };

export default function TopBar({ onSubmit }: Props) {
  const [url, setUrl] = useState("");
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
    <header className="flex items-center border-b border-subtle bg-surface-1 px-4 py-2">
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
        className="w-full rounded-md bg-surface-2 px-3 py-2 text-sm text-fg placeholder:text-fg-muted transition duration-fast ease-out focus:outline-none focus:ring-2 focus:ring-accent"
      />
    </header>
  );
}
