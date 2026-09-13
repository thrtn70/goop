import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import ImageColorPolicyControl, { imageColorPolicyProblem } from "../ImageColorPolicyControl";
import type { ImageColorCapabilities } from "@/types";

const capabilities: ImageColorCapabilities = {
  preserve: { available: true, reason: null, summary: "Keep existing behavior." },
  convert_to_srgb: { available: true, reason: null, summary: "Convert tagged pixels." },
  assume_srgb: { available: false, reason: "The source already has a profile.", summary: "Untagged only." },
};

test("renders engine-owned availability and refuses disabled choices", () => {
  const onChange = vi.fn();
  render(<ImageColorPolicyControl value="preserve" capabilities={capabilities} onChange={onChange} />);
  expect(screen.getByText(/source already has a profile/i)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Assume sRGB" }));
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Convert to sRGB" }));
  expect(onChange).toHaveBeenCalledWith("convert_to_srgb");
});

test("requires fresh capability evidence for explicit choices", () => {
  expect(imageColorPolicyProblem("preserve", undefined)).toBeNull();
  expect(imageColorPolicyProblem("convert_to_srgb", undefined)).toContain("inspection");
  expect(imageColorPolicyProblem("assume_srgb", capabilities)).toContain("already has a profile");
});
