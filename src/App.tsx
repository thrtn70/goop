import { lazy, Suspense, useEffect } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { markShellReady } from "@/performance/startup";
import Layout from "@/components/Layout";
import ToastContainer from "@/components/ToastContainer";
import UpdateBanner from "@/components/UpdateBanner";
import ExtractPage from "@/pages/ExtractPage";
import { useToastTriggers } from "@/hooks/useToastTriggers";
import { useWindowTitle } from "@/hooks/useWindowTitle";

// Phase M: lazy-load every page except Extract (the default landing).
// Each becomes its own chunk so the cold-start payload is just
// Extract + the shared Layout shell. Most users hit Extract first
// and never visit Settings; shipping it eagerly was wasted bytes.
const ConvertPage = lazy(() => import("@/pages/ConvertPage"));
const CompressPage = lazy(() => import("@/pages/CompressPage"));
const ImagePage = lazy(() => import("@/pages/ImagePage"));
const MetadataPage = lazy(() => import("@/pages/MetadataPage"));
const RecognizePage = lazy(() => import("@/pages/RecognizePage"));
const HistoryPage = lazy(() => import("@/pages/HistoryPage"));
const SettingsPage = lazy(() => import("@/pages/SettingsPage"));

function PageFallback() {
  // Visually quiet placeholder while a route chunk streams in. The
  // Layout shell (TopBar / LeftNav / QueueSidebar) is already painted,
  // so this only fills the <main> area.
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      className="flex h-full items-center justify-center text-xs text-fg-muted"
    >
      <span className="sr-only">Loading…</span>
    </div>
  );
}

export default function App() {
  useEffect(() => { markShellReady(); }, []);
  useToastTriggers();
  useWindowTitle();
  return (
    <div className="flex h-screen flex-col">
      <UpdateBanner />
      <div className="flex-1 overflow-hidden">
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<Navigate to="/extract" replace />} />
            <Route path="/extract" element={<ExtractPage />} />
            <Route
              path="/convert"
              element={
                <Suspense fallback={<PageFallback />}>
                  <ConvertPage />
                </Suspense>
              }
            />
            <Route
              path="/compress"
              element={
                <Suspense fallback={<PageFallback />}>
                  <CompressPage />
                </Suspense>
              }
            />
            <Route
              path="/image"
              element={
                <Suspense fallback={<PageFallback />}>
                  <ImagePage />
                </Suspense>
              }
            />
            <Route
              path="/metadata"
              element={
                <Suspense fallback={<PageFallback />}>
                  <MetadataPage />
                </Suspense>
              }
            />
            <Route
              path="/recognize"
              element={
                <Suspense fallback={<PageFallback />}>
                  <RecognizePage />
                </Suspense>
              }
            />
            <Route
              path="/history"
              element={
                <Suspense fallback={<PageFallback />}>
                  <HistoryPage />
                </Suspense>
              }
            />
            <Route
              path="/settings"
              element={
                <Suspense fallback={<PageFallback />}>
                  <SettingsPage />
                </Suspense>
              }
            />
          </Route>
        </Routes>
      </div>
      <ToastContainer />
    </div>
  );
}
