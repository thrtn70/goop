import { useNavigate } from "react-router-dom";
import { ScanText } from "lucide-react";
import { isRecognizable } from "@/features/recognize/recognizable";

interface RecognizeChipProps {
  /** File to preload on the Recognize page when the chip is clicked. */
  path: string;
}

/**
 * Compact affordance that routes to the Recognize page with `path`
 * preloaded (via router state the page reads on mount). Surfaced on
 * Convert/Image when a single recognizable input is present, so users
 * discover the v0.2.7 "Recognize text" feature in the flow of their
 * existing work rather than only via the nav.
 *
 * Renders nothing for inputs the Recognize page wouldn't accept (e.g. a
 * GIF/AVIF/JXL open in the Image Workshop) — otherwise the chip would
 * route to a file the page silently discards.
 */
export default function RecognizeChip({ path }: RecognizeChipProps) {
  const navigate = useNavigate();
  if (!isRecognizable(path)) return null;
  return (
    <button
      type="button"
      onClick={() =>
        navigate("/recognize", { state: { recognizeInput: path } })
      }
      className="btn-press inline-flex items-center gap-1.5 rounded-full border border-subtle bg-surface-1 px-3 py-1 text-xs text-fg-secondary transition duration-fast ease-out hover:border-accent/60 hover:text-fg"
    >
      <ScanText size={13} />
      Recognize text?
    </button>
  );
}
