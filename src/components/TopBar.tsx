import { useRef, useState } from "react";

type Props = { onSubmit: (url: string) => void; onOpenSettings: () => void };

export default function TopBar({ onSubmit, onOpenSettings }: Props) {
  const [url, setUrl] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <header className="flex items-center gap-3 border-b border-neutral-800 bg-neutral-900 px-4 py-2">
      <button
        className="rounded p-2 text-neutral-400 hover:text-white"
        aria-label="Menu"
      >
        ≡
      </button>
      <div className="flex-1">
        <input
          ref={inputRef}
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && url.trim()) {
              onSubmit(url.trim());
              setUrl("");
            }
          }}
          placeholder="Paste link or drop file…"
          className="w-full rounded-md bg-neutral-800 px-3 py-2 text-sm text-white placeholder:text-neutral-500 focus:outline-none focus:ring-2 focus:ring-sky-500"
        />
      </div>
      <button
        onClick={onOpenSettings}
        className="rounded p-2 text-neutral-400 hover:text-white"
        aria-label="Settings"
      >
        ⚙
      </button>
    </header>
  );
}
