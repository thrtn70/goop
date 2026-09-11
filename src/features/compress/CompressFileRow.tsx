import { withWorkspaceDrafts } from "@/store/workspaceDrafts";
import type { TargetFormat, CompressMode, CompressionCapabilities, MetadataPolicy, ImageMetadataCapabilities } from "@/types";
import CompressControls from "./CompressControls";
import MetadataPolicyControl from "@/features/metadata/MetadataPolicyControl";

/**
 * Default compression mode for a given source file.
 *
 * Lossless image formats start with reoptimization. Unsupported source
 * formats retain an editable draft and show an explicit unavailable warning.
 */
export function defaultMode(
  capabilities: CompressionCapabilities,
): CompressMode {
  if (capabilities.lossless && !capabilities.quality)
    return { kind: "lossless_reoptimize" };
  return { kind: "quality", value: 75 };
}

export interface CompressRowOptions {
  mode: CompressMode;
  metadataPolicy: MetadataPolicy;
}

export function CompressSettingsPanel({
  state,
  mode,
  target,
  onChange,
  onDraftEdit,
  metadataPolicy,
  onMetadataChange,
}: {
  state: Extract<import("@/hooks/useProbe").ProbeState, { phase: "ready" }>;
  mode: CompressMode;
  target?: TargetFormat;
  onChange: (mode: CompressMode) => void;
  onDraftEdit?: () => void;
  metadataPolicy?: MetadataPolicy;
  onMetadataChange?: (policy: MetadataPolicy) => void;
}) {
  const imageMetadata = state.capabilities.targets.find(c => c.target === target)?.image_metadata as ImageMetadataCapabilities | null | undefined;
  return (
    <>
      {state.probe.source_kind === "image" && metadataPolicy && onMetadataChange && (
        <MetadataPolicyControl value={metadataPolicy} capabilities={imageMetadata} onChange={onMetadataChange} onDraftEdit={onDraftEdit} />
      )}
      <CompressControls
        capabilities={state.capabilities.targets.find(c => c.target === target)?.compression ?? state.capabilities.compression}
        probe={state.probe}
        mode={mode}
        onChange={onChange}
        onDraftEdit={onDraftEdit}
      />
    </>
  );
}

function CompressFileRow({
  path: _path,
  state,
  selectedMode,
  onOptionsChange,
}: {
  path: string;
  state: Extract<import("@/hooks/useProbe").ProbeState, { phase: "ready" }>;
  selectedMode: CompressMode;
  onOptionsChange: (path: string, opts: CompressRowOptions) => void;
}) {
  return (
    <CompressSettingsPanel
      state={state}
      mode={selectedMode}
      onChange={(mode) => onOptionsChange(_path, { mode, metadataPolicy: "preserve" })}
    />
  );
}
export default withWorkspaceDrafts(CompressFileRow, undefined, (props) => [
  "source",
  props.path,
]);
