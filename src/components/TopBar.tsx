import { useEffect, useRef } from "react";
import { useAppStore } from "@/store/appStore";
import { useLocation } from "react-router-dom";
import { Link2 } from "lucide-react";
import { NAV_ITEMS } from "@/lib/navItems";
import { useWorkspaceDraftState, withWorkspaceDrafts } from "@/store/workspaceDrafts";
import {
  acknowledgeResponsivenessVisible,
  acknowledgeResponsivenessTopBarValue,
  claimResponsivenessAction,
  expectsResponsivenessAction,
  recordResponsivenessHandlerEnd,
  recordResponsivenessHandlerStart,
} from "@/performance/responsivenessRuntime";

type Props = { onSubmit: (url: string) => void };

function TopBar({ onSubmit }: Props) {
  const [url, setUrl] = useWorkspaceDraftState("TopBar.url", "");
  const location = useLocation();
  const title = NAV_ITEMS.find(item => location.pathname.startsWith(item.to))?.label ?? "Goop";
  const inputRef = useRef<HTMLInputElement>(null);
  const pendingAction = useRef<
    | { actionId: number; kind: "value"; committedValue: string | null }
    | { actionId: number; kind: "selection"; start: number; end: number }
    | null
  >(null);
  const focusToken = useAppStore((s) => s.pendingFocusUrlInput);
  // Phase H: Cmd+N increments `pendingFocusUrlInput`. Mirror that increment
  // into the URL input by focusing + selecting on every change > 0.
  useEffect(() => {
    if (focusToken > 0) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [focusToken]);
  useEffect(() => {
    acknowledgeResponsivenessTopBarValue(url);
    const pending = pendingAction.current;
    if (!pending || pending.kind !== "value" || pending.committedValue !== url) return;
    pendingAction.current = null;
    acknowledgeResponsivenessVisible(pending.actionId);
  }, [url]);

  const claimUrlAction = (
    eventType: "input" | "keydown",
    trusted: boolean,
  ): number | null => {
    const targetRole = "textbox";
    const accessibleName = "Paste URL to download";
    if (!expectsResponsivenessAction({ eventType, targetRole, accessibleName })) return null;
    return claimResponsivenessAction({
      eventType,
      targetRole,
      accessibleName,
      trusted,
      priorValue: url,
    });
  };
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
        data-responsiveness-role="textbox"
        data-responsiveness-name="Paste URL to download"
        onChange={(e) => {
          const nextValue = e.target.value;
          const pendingKeyAction = pendingAction.current;
          const actionId = pendingKeyAction === null
            ? claimUrlAction("input", e.nativeEvent.isTrusted)
            : null;
          if (actionId !== null) {
            recordResponsivenessHandlerStart(actionId);
            pendingAction.current = { actionId, kind: "value", committedValue: nextValue };
          } else if (pendingKeyAction?.kind === "value" && pendingKeyAction.committedValue === null) {
            pendingAction.current = { ...pendingKeyAction, committedValue: nextValue };
          }
          try {
            setUrl(nextValue);
          } finally {
            if (actionId !== null) recordResponsivenessHandlerEnd(actionId);
          }
        }}
        onKeyDown={(e) => {
          const actionId = claimUrlAction("keydown", e.nativeEvent.isTrusted);
          const commitsEmptyValue = e.key === "Enter" && Boolean(url.trim());
          if (actionId !== null) {
            recordResponsivenessHandlerStart(actionId);
            pendingAction.current = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a"
              ? { actionId, kind: "selection", start: 0, end: url.length }
              : e.key === "Backspace" || e.key === "Delete"
                ? { actionId, kind: "value", committedValue: null }
                : { actionId, kind: "value", committedValue: commitsEmptyValue ? "" : url };
          }
          try {
            if (commitsEmptyValue) {
              onSubmit(url.trim());
              setUrl("");
            }
          } finally {
            if (actionId !== null) {
              recordResponsivenessHandlerEnd(actionId);
            }
          }
        }}
        onSelect={(event) => {
          const pending = pendingAction.current;
          if (pending?.kind !== "selection") return;
          if (event.currentTarget.selectionStart !== pending.start
            || event.currentTarget.selectionEnd !== pending.end) return;
          pendingAction.current = null;
          acknowledgeResponsivenessVisible(pending.actionId);
        }}
        placeholder="Paste a link and press Enter..."
        className="min-w-0 flex-1 rounded bg-transparent py-1 text-sm text-fg placeholder:text-fg-muted focus:outline-none"
      />
      </div>
    </header>
  );
}

export default withWorkspaceDrafts(TopBar, "extract");
