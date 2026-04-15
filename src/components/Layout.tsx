import { Outlet, useNavigate } from "react-router-dom";
import LeftNav from "./LeftNav";
import TopBar from "./TopBar";
import QueueSidebar from "@/features/queue/QueueSidebar";

export default function Layout() {
  const nav = useNavigate();
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
    </div>
  );
}
