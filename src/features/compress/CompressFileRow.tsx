import { withWorkspaceDrafts } from "@/store/workspaceDrafts";
import type { CompressMode, CompressionCapabilities } from "@/types";
import CompressControls from "./CompressControls";

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
}

export function CompressSettingsPanel({
  state,
  mode,
  onChange,
}: {
  state: Extract<import("@/hooks/useProbe").ProbeState, { phase: "ready" }>;
  mode: CompressMode;
  onChange: (mode: CompressMode) => void;
}) {
  return (
    <CompressControls
      capabilities={state.capabilities.compression}
      probe={state.probe}
      mode={mode}
      onChange={onChange}
    />
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
      onChange={(mode) => onOptionsChange(_path, { mode })}
    />
  );
}
export default withWorkspaceDrafts(CompressFileRow, undefined, (props) => [
  "source",
  props.path,
]);
