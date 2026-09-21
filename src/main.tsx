import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "@/styles/index.css";
import { initializeResponsiveness } from "@/performance/responsivenessRuntime";

async function bootstrap() {
  // PERF-02 installs its page recorder before any scenario-owned store setup
  // or trusted action can run. A disabled/error reply seals the inert registry.
  await initializeResponsiveness();
  const [{ default: App }, { default: ErrorBoundary }, { bootstrapStoreSubscriptions }] = await Promise.all([
    import("@/App"),
    import("@/components/ErrorBoundary"),
    import("@/store/appStore"),
  ]);
  void bootstrapStoreSubscriptions();
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <ErrorBoundary>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </ErrorBoundary>
    </React.StrictMode>,
  );
}

void bootstrap();
