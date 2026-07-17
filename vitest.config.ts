import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
  test: {
    environment: "jsdom",
    globals: false,
    setupFiles: ["./src/test/setup.ts"],
    // Anchor discovery to this checkout's sources: the default glob also
    // crawls nested checkouts (git worktrees, vendored copies) and runs
    // stale duplicates of every suite.
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
  },
});
