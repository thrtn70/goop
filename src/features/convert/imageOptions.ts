import type { ImageConvertOptions, ImageSettingsCapabilities } from "@/types";

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const unsigned = (value: unknown, maximum: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
const onlyKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).every(key => keys.includes(key));

/** Validate the persisted wire shape. Supported bounds come from the engine at use. */
export function validateImageOptions(value: unknown): ImageConvertOptions | null {
  if (value == null) return null;
  if (!object(value) || !onlyKeys(value, ["jpeg_quality", "resize"]) ||
      !unsigned(value.jpeg_quality, 255) || !object(value.resize)) {
    throw new Error("image_options requires a whole-byte JPEG quality and resize settings");
  }
  const resize = value.resize;
  if (resize.kind === "original" && onlyKeys(resize, ["kind"])) {
    return { jpeg_quality: value.jpeg_quality, resize: { kind: "original" } };
  }
  if (resize.kind === "fit_within" && onlyKeys(resize, ["kind", "width", "height"]) &&
      unsigned(resize.width, 0xffff_ffff) && unsigned(resize.height, 0xffff_ffff)) {
    return { jpeg_quality: value.jpeg_quality, resize: { kind: "fit_within", width: resize.width, height: resize.height } };
  }
  throw new Error("image_options resize must be original or fit_within with unsigned whole dimensions");
}

/** Copy exact setting fields; source identity belongs to the owning draft. */
export function cloneImageOptions(options: ImageConvertOptions | null | undefined): ImageConvertOptions | null {
  if (!options) return null;
  return { jpeg_quality: options.jpeg_quality, resize: options.resize.kind === "original"
    ? { kind: "original" }
    : { kind: "fit_within", width: options.resize.width, height: options.resize.height } };
}

/** Legacy null options never block a target. Explicit options require engine support. */
export function imageOptionsProblem(
  options: ImageConvertOptions | null | undefined,
  capability: ImageSettingsCapabilities | null | undefined,
): string | null {
  if (options == null) return null;
  try { validateImageOptions(options); }
  catch (error) { return error instanceof Error ? error.message : "Invalid image settings"; }
  if (!capability?.available) return capability?.reason ?? "Image settings are unavailable for this source and target";
  if (options.jpeg_quality < capability.quality_min || options.jpeg_quality > capability.quality_max) {
    return `JPEG quality must be between ${capability.quality_min} and ${capability.quality_max}`;
  }
  if (options.resize.kind === "fit_within") {
    if (!capability.fit_within) return "Fit within is unavailable for this source and target";
    const { width, height } = options.resize;
    if (width < 1 || height < 1 || width > capability.max_dimension || height > capability.max_dimension) {
      return `Image dimensions must be between 1 and ${capability.max_dimension} pixels`;
    }
  }
  // A fit box is not the output raster: no-upscale/aspect fitting may produce far
  // fewer pixels. The engine validates max_output_pixels against actual dimensions.
  return null;
}
