import { Outlet, useNavigate } from "react-router-dom";
import LeftNav from "./LeftNav";
import TopBar from "./TopBar";
import CommandPalette from "./CommandPalette";
import QueueSidebar from "@/features/queue/QueueSidebar";
import { useTheme } from "@/hooks/useTheme";
import { useQueueHotkey } from "@/hooks/useQueueHotkey";
import { useHotkeys } from "@/hooks/useHotkeys";

export default function Layout() {
  const nav = useNavigate();
  useTheme();
  useQueueHotkey();
  useHotkeys();
  return (
    <div className="flex h-screen flex-col bg-surface-0 text-fg">
      <h1 className="sr-only">Goop</h1>
      <TopBar
        onSubmit={(url) => nav(`/extract?url=${encodeURIComponent(url)}`)}
      />
      <div className="flex flex-1 overflow-hidden">
        <LeftNav />
        <main className="flex-1 overflow-auto bg-surface-0">
          <Outlet />
        </main>
        <QueueSidebar />
      </div>
      <CommandPalette />
    </div>
  );
}
