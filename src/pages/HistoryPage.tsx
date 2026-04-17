import { useEffect } from "react";
import type { Job } from "@/types";
import { useAppStore } from "@/store/appStore";
import HistoryToolbar from "@/features/history/HistoryToolbar";
import HistoryList from "@/features/history/HistoryList";
import HistoryGrid from "@/features/history/HistoryGrid";
import HistoryBulkActions from "@/features/history/HistoryBulkActions";
import PreviewPanel from "@/features/preview/PreviewPanel";
import QuickViewModal from "@/features/preview/QuickViewModal";
import { useQuickView } from "@/features/preview/useQuickView";

/**
 * Terminal-state jobs with search / filter / sort / grid-or-list /
 * batch actions / slide-out preview / Quick View overlay. See
 * docs/superpowers/specs/2026-04-17-v0.1.8-design.md for the UX notes.
 */
export default function HistoryPage() {
  const viewMode = useAppStore((s) => s.history.viewMode);
  const loadHistory = useAppStore((s) => s.loadHistory);
  const setPreview = useAppStore((s) => s.setHistoryPreview);
  const quick = useQuickView();

  // On mount, refresh — the bootstrap subscription keeps us roughly in
  // sync, but an explicit load makes the page snappy when arriving from
  // another route after an offline stretch.
  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  function openPreview(job: Job) {
    setPreview(job.id);
  }
  function openQuickView(job: Job) {
    quick.open(job.id);
  }

  return (
    <div className="flex h-full">
      <div className="flex flex-1 flex-col">
        <HistoryToolbar />
        {viewMode === "list" ? (
          <HistoryList onPreview={openPreview} onQuickView={openQuickView} />
        ) : (
          <HistoryGrid onPreview={openPreview} onQuickView={openQuickView} />
        )}
        <HistoryBulkActions />
      </div>
      <PreviewPanel />
      <QuickViewModal job={quick.currentJob} onClose={quick.close} />
    </div>
  );
}
