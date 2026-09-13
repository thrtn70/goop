import type { ColorPolicyAvailability, ImageColorCapabilities, ImageColorPolicy } from "@/types";
import { useId } from "react";

const choices: Array<{ value: ImageColorPolicy; label: string }> = [
  { value: "preserve", label: "Preserve" },
  { value: "convert_to_srgb", label: "Convert to sRGB" },
  { value: "assume_srgb", label: "Assume sRGB" },
];

function availabilityFor(
  capabilities: ImageColorCapabilities | null | undefined,
  policy: ImageColorPolicy,
): ColorPolicyAvailability {
  if (capabilities) return capabilities[policy];
  if (policy === "preserve") {
    return { available: true, reason: null, summary: "Keep existing color behavior." };
  }
  return {
    available: false,
    reason: "Fresh color-profile inspection is required before choosing explicit color handling.",
    summary: "Inspection required.",
  };
}

export function imageColorPolicyProblem(
  policy: ImageColorPolicy,
  capabilities: ImageColorCapabilities | null | undefined,
): string | null {
  const availability = availabilityFor(capabilities, policy);
  return availability.available
    ? null
    : availability.reason || `${policy} is unavailable for this source and target.`;
}

export default function ImageColorPolicyControl({
  value,
  capabilities,
  onChange,
  onDraftEdit,
}: {
  value: ImageColorPolicy;
  capabilities?: ImageColorCapabilities | null;
  onChange: (value: ImageColorPolicy) => void;
  onDraftEdit?: () => void;
}) {
  const reasonPrefix = useId();
  return (
    <div className="mt-2 flex flex-col gap-2 text-xs" aria-label="Color handling" role="group">
      <span className="text-fg-muted">Color</span>
      <div className="flex flex-wrap gap-2">
        {choices.map((choice) => {
          const availability = availabilityFor(capabilities, choice.value);
          const reasonId = `${reasonPrefix}-${choice.value}-reason`;
          return (
            <button
              key={choice.value}
              type="button"
              aria-pressed={value === choice.value}
              aria-disabled={!availability.available}
              aria-describedby={!availability.available ? reasonId : undefined}
              onClick={() => {
                if (!availability.available) return;
                onDraftEdit?.();
                onChange(choice.value);
              }}
              className={`btn-press rounded-md px-2 py-1 transition duration-fast ease-out ${
                value === choice.value
                  ? "bg-accent text-accent-fg"
                  : "bg-surface-2 text-fg-secondary hover:bg-surface-3 hover:text-fg"
              } ${!availability.available ? "cursor-not-allowed opacity-50" : ""}`}
              title={!availability.available ? availability.reason || availability.summary : availability.summary}
            >
              {choice.label}
            </button>
          );
        })}
      </div>
      {choices.map((choice) => {
        const availability = availabilityFor(capabilities, choice.value);
        if (availability.available) return null;
        return (
          <p key={choice.value} id={`${reasonPrefix}-${choice.value}-reason`} className="text-warning">
            {choice.label}: {availability.reason || availability.summary}
          </p>
        );
      })}
      <p className="text-fg-secondary" role="status">
        {availabilityFor(capabilities, value).summary}
      </p>
      {value !== "preserve" && (
        <p className="text-warning" role="status">
          Source EXIF and ICC are removed; a canonical sRGB profile describes the output pixels.
        </p>
      )}
    </div>
  );
}
