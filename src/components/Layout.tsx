import { Outlet, useNavigate } from "react-router-dom";
import LeftNav from "./LeftNav";
import TopBar from "./TopBar";
import CommandPalette from "./CommandPalette";
import Onboarding from "./Onboarding";
import SkipNav from "./SkipNav";
import JobStateAnnouncer from "./JobStateAnnouncer";
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
    <div className="workspace-shell flex h-full min-h-0 flex-col bg-surface-0 text-fg">
      <SkipNav />
      <h1 className="sr-only">Goop</h1>
      <TopBar
        onSubmit={(url) => nav(`/extract?url=${encodeURIComponent(url)}`)}
      />
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <LeftNav />
        <div className="workspace-column">
          <main id="main" tabIndex={-1} className="workspace-main">
            <Outlet />
          </main>
          <QueueSidebar />
        </div>
      </div>
      <CommandPalette />
      <Onboarding />
      <JobStateAnnouncer />
    </div>
  );
}
