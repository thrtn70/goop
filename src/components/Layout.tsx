import { Outlet, useNavigate } from "react-router-dom";
import LeftNav from "./LeftNav";
import TopBar from "./TopBar";
import DropOverlay from "./DropOverlay";
import QueueSidebar from "@/features/queue/QueueSidebar";
import { useDropTarget } from "@/hooks/useDropTarget";

export default function Layout() {
  const nav = useNavigate();
  const dragging = useDropTarget();
  return (
    <div className="flex h-screen flex-col">
      <TopBar
        onSubmit={(url) => nav(`/extract?url=${encodeURIComponent(url)}`)}
        onOpenSettings={() => nav("/settings")}
      />
      <div className="flex flex-1 overflow-hidden">
        <LeftNav />
        <main className="flex-1 overflow-auto">
          <Outlet />
        </main>
        <QueueSidebar />
      </div>
      <DropOverlay active={dragging} />
    </div>
  );
}
