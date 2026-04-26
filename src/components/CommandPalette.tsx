import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Command } from "cmdk";
import { formatError } from "@/ipc/error";
import { useAppStore } from "@/store/appStore";
import { isFilePickerRoute, isMacPlatform, modKeyLabel } from "@/lib/platform";

interface ActionItem {
  id: string;
  label: string;
  hint?: string;
  shortcut?: string;
  group: "Navigate" | "Actions" | "Queue" | "App";
  run: () => void | Promise<void>;
}

/**
 * Phase H command palette. Opens via Cmd+K / Ctrl+K. Renders a fuzzy-search
 * list of global actions (navigate, focus URL input, open file picker,
 * toggle queue, check for updates). Mounted at Layout level so it's
 * available on every page.
 */
export default function CommandPalette() {
  const open = useAppStore((s) => s.paletteOpen);
  const setOpen = useAppStore((s) => s.setPaletteOpen);
  const requestFocusUrlInput = useAppStore((s) => s.requestFocusUrlInput);
  const requestFilePicker = useAppStore((s) => s.requestFilePicker);
  const toggleQueueCollapsed = useAppStore((s) => s.toggleQueueCollapsed);
  const checkForUpdate = useAppStore((s) => s.checkForUpdate);
  const enqueueToast = useAppStore((s) => s.enqueueToast);
  const nav = useNavigate();
  const mod = modKeyLabel();
  // cmdk's input is uncontrolled by default; binding a controlled value
  // lets us reset the search on close idiomatically (no DOM querying).
  const [search, setSearch] = useState("");

  function close(): void {
    setOpen(false);
    setSearch("");
  }

  const actions: ActionItem[] = [
    {
      id: "nav-extract",
      label: "Go to Extract",
      shortcut: `${mod}1`,
      group: "Navigate",
      run: () => nav("/extract"),
    },
    {
      id: "nav-convert",
      label: "Go to Convert",
      shortcut: `${mod}2`,
      group: "Navigate",
      run: () => nav("/convert"),
    },
    {
      id: "nav-compress",
      label: "Go to Compress",
      shortcut: `${mod}3`,
      group: "Navigate",
      run: () => nav("/compress"),
    },
    {
      id: "nav-history",
      label: "Go to History",
      shortcut: `${mod}4`,
      group: "Navigate",
      run: () => nav("/history"),
    },
    {
      id: "nav-settings",
      label: "Go to Settings",
      shortcut: `${mod}5`,
      group: "Navigate",
      run: () => nav("/settings"),
    },
    {
      id: "act-paste-url",
      label: "Paste URL and download",
      hint: "Focus the URL input on Extract",
      shortcut: `${mod}N`,
      group: "Actions",
      run: () => {
        nav("/extract");
        requestFocusUrlInput();
      },
    },
    {
      id: "act-open-picker",
      label: "Open file picker",
      hint: "Convert or compress local files",
      shortcut: `${mod}O`,
      group: "Actions",
      run: () => {
        // Stay on a picker route if already there; otherwise route to /convert.
        if (!isFilePickerRoute(window.location.pathname)) {
          nav("/convert");
        }
        requestFilePicker();
      },
    },
    {
      id: "queue-toggle",
      label: "Toggle queue sidebar",
      shortcut: `${mod}⇧Q`,
      group: "Queue",
      run: () => toggleQueueCollapsed(),
    },
    {
      id: "app-check-update",
      label: "Check for updates",
      group: "App",
      run: async () => {
        try {
          await checkForUpdate();
          enqueueToast({
            variant: "info",
            title: "Update check complete",
          });
        } catch (e) {
          enqueueToast({
            variant: "error",
            title: "Update check failed",
            detail: formatError(e),
          });
        }
      },
    },
  ];

  function runAction(action: ActionItem): void {
    close();
    void Promise.resolve(action.run()).catch((err: unknown) => {
      enqueueToast({
        variant: "error",
        title: "Action failed",
        detail: formatError(err),
      });
    });
  }

  if (!open) return null;

  const groups: ActionItem["group"][] = ["Navigate", "Actions", "Queue", "App"];

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 px-4 pt-[12vh]"
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <Command
        label="Command palette"
        className="enter-up w-full max-w-lg overflow-hidden rounded-lg border border-subtle bg-surface-1 shadow-xl"
        loop
      >
        <Command.Input
          autoFocus
          value={search}
          onValueChange={setSearch}
          placeholder={`Type a command${isMacPlatform() ? " or search…" : "…"}`}
          className="w-full border-b border-subtle bg-transparent px-4 py-3 text-sm text-fg outline-none placeholder:text-fg-muted"
        />
        <Command.List className="max-h-80 overflow-auto p-2">
          <Command.Empty className="px-3 py-6 text-center text-xs text-fg-muted">
            No matching commands.
          </Command.Empty>
          {groups.map((group) => {
            const items = actions.filter((a) => a.group === group);
            if (items.length === 0) return null;
            return (
              <Command.Group
                key={group}
                heading={group}
                className="mb-1 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-fg-muted"
              >
                {items.map((a) => (
                  <Command.Item
                    key={a.id}
                    value={`${a.label} ${a.hint ?? ""}`}
                    onSelect={() => runAction(a)}
                    className="flex cursor-pointer items-center justify-between rounded-md px-3 py-2 text-sm text-fg transition duration-fast ease-out aria-selected:bg-accent-subtle aria-selected:text-accent"
                  >
                    <span className="flex flex-col">
                      <span>{a.label}</span>
                      {a.hint && (
                        <span className="text-[10px] text-fg-muted">
                          {a.hint}
                        </span>
                      )}
                    </span>
                    {a.shortcut && (
                      <kbd className="ml-3 rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-fg-muted">
                        {a.shortcut}
                      </kbd>
                    )}
                  </Command.Item>
                ))}
              </Command.Group>
            );
          })}
        </Command.List>
      </Command>
    </div>
  );
}
