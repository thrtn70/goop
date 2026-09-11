import type { ImageMetadataCapabilities, MetadataPolicy } from "@/types";
import { useId } from "react";

type PolicyAvailability = { available: boolean; reason: string | null; summary: string };
export type MetadataPreserveMode = "channel_aware" | "rgb_reencode";

export interface MetadataPolicyControlProps {
  value: MetadataPolicy;
  capabilities?: ImageMetadataCapabilities | null;
  onChange: (value: MetadataPolicy) => void;
  onDraftEdit?: () => void;
  label?: string;
  preserveMode?: MetadataPreserveMode;
}

const choices: Array<{ value: MetadataPolicy; label: string }> = [
  { value: "preserve", label: "Preserve" },
  { value: "remove_personal", label: "Remove personal data" },
  { value: "strip_all", label: "Remove all" },
];

function availabilityFor(
  capabilities: ImageMetadataCapabilities | null | undefined,
  policy: MetadataPolicy,
  preserveMode: MetadataPreserveMode,
): PolicyAvailability {
  if (capabilities) {
    if (policy === "preserve" && preserveMode === "rgb_reencode") {
      return capabilities.rgb_reencode_preserve;
    }
    return capabilities[policy];
  }
  if (policy === "remove_personal") {
    return {
      available: false,
      reason: "Fresh metadata capability inspection is required before personal data can be removed.",
      summary: "Unavailable",
    };
  }
  return {
    available: true,
    reason: null,
    summary: policy === "preserve" ? "Preserve metadata." : "Remove all metadata.",
  };
}

export function metadataPolicyProblem(
  policy: MetadataPolicy,
  capabilities: ImageMetadataCapabilities | null | undefined,
  preserveMode: MetadataPreserveMode = "channel_aware",
): string | null {
  const availability = availabilityFor(capabilities, policy, preserveMode);
  return availability.available ? null : availability.reason || `${policy} is unavailable for this source and target.`;
}

export default function MetadataPolicyControl({
  value,
  capabilities,
  onChange,
  onDraftEdit,
  label = "Metadata",
  preserveMode = "channel_aware",
}: MetadataPolicyControlProps) {
  const reasonIdPrefix = useId();
  return (
    <div className="mt-2 flex flex-col gap-2 text-xs" aria-label={label} role="group">
      <span className="text-fg-muted">{label}</span>
      <div className="flex flex-wrap gap-2">
        {choices.map((choice) => {
          const availability = availabilityFor(capabilities, choice.value, preserveMode);
          const disabled = !availability.available;
          const reasonId = `${reasonIdPrefix}-${choice.value}-reason`;
          return (
            <button
              key={choice.value}
              type="button"
              aria-pressed={value === choice.value}
              aria-disabled={disabled}
              aria-describedby={disabled ? reasonId : undefined}
              onClick={() => {
                if (disabled) return;
                onDraftEdit?.();
                onChange(choice.value);
              }}
              className={`btn-press rounded-md px-2 py-1 transition duration-fast ease-out ${
                value === choice.value
                  ? "bg-accent text-accent-fg"
                  : "bg-surface-2 text-fg-secondary hover:bg-surface-3 hover:text-fg"
              } ${disabled ? "cursor-not-allowed opacity-50" : ""}`}
              title={disabled ? availability.reason || availability.summary : availability.summary}
            >
              {choice.label}
            </button>
          );
        })}
      </div>
      {choices.map((choice) => {
        const availability = availabilityFor(capabilities, choice.value, preserveMode);
        if (availability.available) return null;
        return (
          <p
            key={`${choice.value}-reason`}
            id={`${reasonIdPrefix}-${choice.value}-reason`}
            className="text-warning"
          >
            {choice.label}: {availability.reason || availability.summary}
          </p>
        );
      })}
      <p className="text-fg-secondary" role="status">
        {availabilityFor(capabilities, value, preserveMode).summary}
      </p>
      {value === "strip_all" && (
        <p className="text-warning" role="status">
          Removes ICC color data; output color may differ.
        </p>
      )}
      {metadataPolicyProblem(value, capabilities, preserveMode) && (
        <p className="text-warning" role="alert">
          {metadataPolicyProblem(value, capabilities, preserveMode)}
        </p>
      )}
    </div>
  );
}
