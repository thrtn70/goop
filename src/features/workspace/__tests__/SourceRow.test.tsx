import type { ComponentProps } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { ProbeState } from "@/hooks/useProbe";
import SourceRow from "../SourceRow";

afterEach(cleanup);
const ready = { phase: "ready", probe: { image_format: "jpeg", width: 2, height: 2, file_size: 100 } } as unknown as ProbeState;
const renderRow = (props: Partial<ComponentProps<typeof SourceRow>>) => render(
  <ul><SourceRow path="/p/a.jpg" selected={false} state={ready} problem={null} onSelect={() => {}} onRemove={() => {}} onRetry={() => {}} {...props} /></ul>,
);

it("shows the settings line truncated with its full text in the title, and the tag", () => {
  renderRow({ summary: "→ JPEG · Quality 80", batchState: "batch" });
  const line = screen.getByText("→ JPEG · Quality 80");
  expect(line.className).toContain("truncate");
  expect(line.getAttribute("title")).toBe("→ JPEG · Quality 80");
  expect(screen.getByText("Batch")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Select a.jpg" })).toBeTruthy();
});

it("shows Edited, and nothing extra without the new props", () => {
  renderRow({ summary: "→ PNG", batchState: "edited" });
  expect(screen.getByText("Edited")).toBeTruthy();
  cleanup();
  renderRow({});
  expect(screen.queryByText(/^→/)).toBeNull();
  expect(screen.queryByText("Batch")).toBeNull();
  expect(screen.queryByText("Edited")).toBeNull();
});
