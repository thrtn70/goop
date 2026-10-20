import {
  useCallback,
  useEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import type { PlayablePlan } from "@/features/player/previewPlan";
import { releaseMedia } from "@/features/player/releaseMedia";
import { FOCUS_SENTINEL_ATTR, trapTab } from "@/lib/focusTrap";

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

// Both guards are invisible Tab stops that hand focus to Close; the trap leaves them out of its control list.
const SENTINEL_PROPS = { [FOCUS_SENTINEL_ATTR]: "", tabIndex: 0, "aria-hidden": true, className: "sr-only" } as const;

// The wrapper ignores the pointer so a click beside the media lands on the scrim; the media takes it back.
const MEDIA_CLASS = "pointer-events-auto max-h-full max-w-full rounded-md object-contain";

/**
 * Fills the Goop window with the selected source. Esc, the close button and a click on the scrim all leave;
 * the click has to start on the scrim too, so a scrub released beside the video stays open.
 * The media carries tabIndex 0 so it is a Tab stop of its own; the browser may add its native controls
 * after it, which is why the trap lets a forward Tab leave the media and the trailing sentinel brings
 * focus back to Close once Tab has carried it past them. The leading sentinel does the same for Shift+Tab
 * from the media when Close is not a tab stop and the browser's previous stop lies outside the dialog.
 */
export default function PlayerLightbox({ plan, src, name, startAt, playing, onClose }: PlayerLightboxProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const mediaRef = useRef<HTMLMediaElement | null>(null);
  // Where the last press began: a scrub that starts on the video and ends over the scrim clicks the scrim.
  // null when no press was seen, as with a click sent by assistive tech.
  const pressOnScrim = useRef<boolean | null>(null);
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
    if (plan.kind === "image") {
      onClose({ startAt: 0, playing: false });
    } else if (media === null || media.readyState < HTMLMediaElement.HAVE_METADATA) {
      // Not loaded yet, so it never seeked to startAt: hand the panel's own position straight back.
      onClose({ startAt, playing });
    } else {
      onClose({ startAt: media.currentTime, playing: !media.paused });
    }
  };

  const focusClose = () => closeRef.current?.focus();

  const handleScrimClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    const pressedHere = pressOnScrim.current !== false;
    pressOnScrim.current = null;
    if (pressedHere && event.target === event.currentTarget) close();
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
      onPointerDown={(event) => {
        pressOnScrim.current = event.target === event.currentTarget;
      }}
      onClick={handleScrimClick}
      className="fixed inset-0 z-50 bg-scrim/80 p-6"
    >
      <span {...SENTINEL_PROPS} onFocus={focusClose} />
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
      <span {...SENTINEL_PROPS} onFocus={focusClose} />
    </div>,
    document.body,
  );
}
