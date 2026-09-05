import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    environment: "jsdom",
    globals: false,
    setupFiles: ["./src/test/setup.ts"],
    // Without this, vitest stubs every `.css` import to an empty string —
    // including `?raw` — and the token contrast test silently parses nothing.
    // Only tokens.css is ever imported by a test, so no component suite pays
    // for PostCSS/Tailwind here.
    css: true,
    // Anchor discovery to this checkout's sources: the default glob also
    // crawls nested checkouts (git worktrees, vendored copies) and runs
    // stale duplicates of every suite.
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
  },
});
