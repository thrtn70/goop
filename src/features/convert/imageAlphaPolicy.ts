import type { ImageAlphaCapabilities, ImageAlphaPolicy, ImageColorPolicy, SrgbColor, TargetFormat } from "@/types";

export function cloneImageAlphaPolicy(
  value: ImageAlphaPolicy | null | undefined,
): ImageAlphaPolicy | null {
  if (!value) return null;
  return {
    kind: "flatten",
    background: { ...value.background },
  };
}

export function validateImageAlphaPolicy(value: unknown): ImageAlphaPolicy | null {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("image_alpha_policy must be an object or null");
  }
  const policy = value as Record<string, unknown>;
  if (Object.keys(policy).length !== 2 || policy.kind !== "flatten") {
    throw new Error("image_alpha_policy must contain exactly kind and background");
  }
  if (typeof policy.background !== "object" || policy.background === null || Array.isArray(policy.background)) {
    throw new Error("image_alpha_policy background must be an sRGB color");
  }
  const background = policy.background as Record<string, unknown>;
  const keys = Object.keys(background).sort();
  if (keys.join(",") !== "blue,green,red") {
    throw new Error("image_alpha_policy background must contain exactly red, green and blue");
  }
  for (const channel of ["red", "green", "blue"] as const) {
    if (!Number.isInteger(background[channel]) || Number(background[channel]) < 0 || Number(background[channel]) > 255) {
      throw new Error(`image_alpha_policy background ${channel} must be a whole byte`);
    }
  }
  return {
    kind: "flatten",
    background: {
      red: Number(background.red),
      green: Number(background.green),
      blue: Number(background.blue),
    },
  };
}

export function imageAlphaPolicyProblem(
  policy: ImageAlphaPolicy | null | undefined,
  capabilities: ImageAlphaCapabilities | null | undefined,
  colorPolicy?: ImageColorPolicy | null,
  target?: TargetFormat,
): string | null {
  if (policy && target !== "jpeg") return "The saved transparency background applies only to JPEG output.";
  if (policy && !capabilities) return "Fresh source inspection is required for the saved transparency background.";
  if (capabilities && (policy || capabilities.source_has_alpha === true) && !capabilities.flatten.available) {
    return capabilities.flatten.reason ?? capabilities.flatten.summary;
  }
  if (policy && capabilities?.required_color_policy && colorPolicy !== capabilities.required_color_policy) {
    return capabilities.required_color_policy === "convert_to_srgb"
      ? "Convert this source to sRGB before flattening transparency."
      : "Confirm Assume sRGB before flattening transparency.";
  }
  if (policy && (!colorPolicy || colorPolicy === "preserve")) {
    return "Choose Convert to sRGB or Assume sRGB for the saved transparency background.";
  }
  if (!capabilities || capabilities.source_has_alpha !== true) return null;
  if (!policy) return "Choose a background before converting transparency to JPEG.";
  return null;
}

export function srgbHex(color: SrgbColor): string {
  return `#${[color.red, color.green, color.blue]
    .map((channel) => channel.toString(16).padStart(2, "0"))
    .join("")}`.toUpperCase();
}

export function parseSrgbHex(value: string): SrgbColor | null {
  if (!/^#[0-9a-f]{6}$/i.test(value)) return null;
  return {
    red: Number.parseInt(value.slice(1, 3), 16),
    green: Number.parseInt(value.slice(3, 5), 16),
    blue: Number.parseInt(value.slice(5, 7), 16),
  };
}
