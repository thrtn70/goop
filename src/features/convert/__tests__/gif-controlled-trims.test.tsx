import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import GifOptionsPanel from "../GifOptionsPanel";
import type { GifOptions } from "@/types";

afterEach(cleanup);

it("resynchronizes batch trim changes without interrupting local draft edits", async () => {
  const options: GifOptions = { size_preset: "medium", trim_start_ms: 1000n, trim_end_ms: 9000n };
  const onChange = vi.fn();
  const { rerender } = render(<GifOptionsPanel gifOptions={options} onChange={onChange} maxDurationMs={60000} />);
  const start = screen.getByRole("textbox", { name: "Start" }) as HTMLInputElement;
  const end = screen.getByRole("textbox", { name: "End" }) as HTMLInputElement;
  await userEvent.clear(start);
  await userEvent.type(start, "00:0");
  rerender(<GifOptionsPanel gifOptions={{ ...options, size_preset: "small" }} onChange={onChange} maxDurationMs={60000} />);
  expect(start.value).toBe("00:0");
  rerender(<GifOptionsPanel gifOptions={{ ...options, trim_start_ms: 5000n, trim_end_ms: 12000n }} onChange={onChange} maxDurationMs={60000} />);
  expect(start.value).toBe("00:05");
  expect(end.value).toBe("00:12");
  await userEvent.tab();
  expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ trim_start_ms: 5000n, trim_end_ms: 12000n }));
});
