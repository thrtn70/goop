import { useCallback, useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import type { PlayablePlan } from "@/features/player/previewPlan";
import { releaseMedia } from "@/features/player/releaseMedia";
import { trapTab } from "@/lib/focusTrap";

export type PlayerLightboxProps = {
  plan: PlayablePlan;
  /** The asset URL the panel player already built; used as given. */
  src: string;
  name: string;
  /** Where the panel player was, in seconds, and whether it was playing. */
  startAt: number;
  playing: boolean;
  onClose: (state: { startAt: number; playing: boolean }) => void;
};

// The wrapper ignores the pointer so a click beside the media lands on the scrim; the media takes it back.
const MEDIA_CLASS = "pointer-events-auto max-h-full max-w-full rounded-md object-contain";

/**
 * Fills the Goop window with the selected source. Esc, the close button and a click on the scrim all leave.
 * The media carries tabIndex 0 so Tab can reach its native controls and the focus trap counts it as a stop.
 */
export default function PlayerLightbox({ plan, src, name, startAt, playing, onClose }: PlayerLightboxProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const mediaRef = useRef<HTMLMediaElement | null>(null);
  // One callback for both element kinds: a RefObject<HTMLMediaElement> is not assignable to a <video> ref.
  // Closing reads the position first (close below), then the unmount releases the element.
  const setMedia = useCallback((element: HTMLMediaElement | null) => {
    const previous = mediaRef.current;
    if (previous !== null && previous !== element) releaseMedia(previous);
    mediaRef.current = element;
  }, []);

  useEffect(() => {
    const opener = document.activeElement;
    closeRef.current?.focus();
    return () => {
      if (opener instanceof HTMLElement && document.contains(opener)) opener.focus();
    };
  }, []);

  const close = () => {
    const media = mediaRef.current;
    onClose({ startAt: media?.currentTime ?? 0, playing: media !== null && !media.paused });
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      close();
      return;
    }
    if (dialogRef.current) trapTab(event, dialogRef.current);
  };

  const handleLoadedMetadata = () => {
    const media = mediaRef.current;
    if (media === null) return;
    media.currentTime = startAt;
    if (playing) {
      // play() can reject (autoplay policy, element gone) and may return nothing in older webviews.
      void Promise.resolve(media.play()).catch(() => {});
    }
  };

  return createPortal(
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={"Preview of " + name}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
      className="fixed inset-0 z-50 bg-scrim/80 p-6"
    >
      <button
        ref={closeRef}
        type="button"
        aria-label="Close preview"
        onClick={close}
        className="absolute right-4 top-4 z-10 rounded-full bg-surface-1 p-2 text-fg-secondary hover:text-fg focus-visible:outline-accent"
      >
        <X size={18} aria-hidden="true" />
      </button>
      <div className="enter-up pointer-events-none flex h-full w-full items-center justify-center">
        {plan.kind === "image" && <img src={src} alt={"Preview of " + name} decoding="async" className={MEDIA_CLASS} />}
        {plan.kind === "video" && (
          <video
            ref={setMedia}
            src={src}
            controls
            preload="metadata"
            playsInline
            tabIndex={0}
            onLoadedMetadata={handleLoadedMetadata}
            className={MEDIA_CLASS}
          />
        )}
        {plan.kind === "audio" && (
          <audio
            ref={setMedia}
            src={src}
            controls
            preload="metadata"
            tabIndex={0}
            onLoadedMetadata={handleLoadedMetadata}
            className="pointer-events-auto w-full max-w-xl"
          />
        )}
      </div>
    </div>,
    document.body,
  );
}
