import { Navigate, Route, Routes } from "react-router-dom";
import Layout from "@/components/Layout";
import ExtractPage from "@/pages/ExtractPage";
import HistoryPage from "@/pages/HistoryPage";
import SettingsPage from "@/pages/SettingsPage";

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Navigate to="/extract" replace />} />
        <Route path="/extract" element={<ExtractPage />} />
        <Route path="/history" element={<HistoryPage />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Route>
    </Routes>
  );
}
