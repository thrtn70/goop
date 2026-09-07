import { describe, expect, it } from "vitest";
import type { ImageConvertOptions, ImageSettingsCapabilities } from "@/types";
import { cloneImageOptions, imageOptionsProblem, validateImageOptions } from "../imageOptions";

const capability: ImageSettingsCapabilities = { available: true, reason: null, quality_min: 10,
  quality_max: 95, default_quality: 70, max_dimension: 4096, max_output_pixels: 10_000_000,
  fit_within: true, upscale: false, preview_original_available: false,
  preview_fit_within: false, preview_unavailable_reason: "No sample" };
const options: ImageConvertOptions = { jpeg_quality: 90,
  resize: { kind: "fit_within", width: 2048, height: 2048 } };

describe("image settings boundaries", () => {
  it("preserves legacy intent without requiring a capability", () => {
    for (const value of [undefined, null]) {
      expect(validateImageOptions(value)).toBeNull();
      expect(cloneImageOptions(value)).toBeNull();
      expect(imageOptionsProblem(value, null)).toBeNull();
    }
  });
  it("copies original and fit settings without sharing a mutable resize object", () => {
    for (const original of [options, { jpeg_quality: 75, resize: { kind: "original" as const } }]) {
      const clone = cloneImageOptions(original);
      expect(clone).toEqual(original);
      expect(clone?.resize).not.toBe(original.resize);
    }
  });
  it("uses engine availability reasons and fails closed before inspection", () => {
    expect(imageOptionsProblem(options, null)).toMatch(/unavailable/);
    expect(imageOptionsProblem(options, { ...capability, available: false, reason: "Opaque input required" }))
      .toBe("Opaque input required");
    expect(imageOptionsProblem(options, capability)).toBeNull();
  });
  it("uses engine quality and dimension bounds rather than duplicated defaults", () => {
    expect(imageOptionsProblem({ ...options, jpeg_quality: 96 }, capability)).toMatch(/10 and 95/);
    expect(imageOptionsProblem({ ...options, jpeg_quality: 9 }, capability)).toMatch(/10 and 95/);
    expect(imageOptionsProblem({ ...options, resize: { kind: "fit_within", width: 4097, height: 10 } }, capability))
      .toMatch(/1 and 4096/);
    expect(imageOptionsProblem({ ...options, resize: { kind: "fit_within", width: 0, height: 10 } }, capability))
      .toMatch(/1 and 4096/);
    expect(imageOptionsProblem(options, { ...capability, fit_within: false })).toMatch(/Fit within is unavailable/);
  });
  it("does not mistake a fit box for the actual aspect-preserving output raster", () => {
    expect(imageOptionsProblem({ ...options, resize: { kind: "fit_within", width: 4096, height: 4096 } }, capability))
      .toBeNull();
  });
  it.each([NaN, Infinity, -Infinity, 1.5, -1, 256])("rejects malformed quality %s before capability checks", jpeg_quality => {
    expect(() => validateImageOptions({ ...options, jpeg_quality })).toThrow(/image_options/);
    expect(imageOptionsProblem({ ...options, jpeg_quality }, capability)).toMatch(/image_options/);
  });
});
