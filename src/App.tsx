import { Navigate, Route, Routes } from "react-router-dom";
import Layout from "@/components/Layout";
import ToastContainer from "@/components/ToastContainer";
import CompressPage from "@/pages/CompressPage";
import ConvertPage from "@/pages/ConvertPage";
import ExtractPage from "@/pages/ExtractPage";
import HistoryPage from "@/pages/HistoryPage";
import SettingsPage from "@/pages/SettingsPage";
import { useToastTriggers } from "@/hooks/useToastTriggers";

export default function App() {
  useToastTriggers();
  return (
    <>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Navigate to="/extract" replace />} />
          <Route path="/extract" element={<ExtractPage />} />
          <Route path="/convert" element={<ConvertPage />} />
          <Route path="/compress" element={<CompressPage />} />
          <Route path="/history" element={<HistoryPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Route>
      </Routes>
      <ToastContainer />
    </>
  );
}
