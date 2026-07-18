import { defineConfig, configDefaults } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
  test: {
    environment: "jsdom",
    globals: false,
    setupFiles: ["./src/test/setup.ts"],
    // A linked git worktree checked out below this directory carries a full
    // copy of src/, so the default glob picks up every test N+1 times and lets
    // an unrelated branch's failures block this checkout's run. Only ever test
    // the sources in this tree. (Spread the defaults — `exclude` replaces them
    // rather than adding to them.)
    exclude: [...configDefaults.exclude, "**/worktrees/**"],
  },
});
