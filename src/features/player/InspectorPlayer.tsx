import { useState } from "react";
import PlayerBoundary from "@/features/player/PlayerBoundary";
import PlayerLightbox from "@/features/player/PlayerLightbox";
import SourcePlayer, { type SourcePlayerProps } from "@/features/player/SourcePlayer";
import { sourceName } from "@/features/workspace/SourceRow";
import { useHomeDir } from "@/hooks/useHomeDir";
import type { ProbeState } from "@/hooks/useProbe";
import { useAppStore } from "@/store/appStore";

export type InspectorPlayerProps = { path: string | null; state: ProbeState };

type Handoff = Parameters<SourcePlayerProps["onEnlarge"]>[0];
type Resume = { startAt: number; playing: boolean };

/** Pages ask this before passing the player to the inspector, so a disabled player leaves no empty slot behind. */
export function useMediaPlayerEnabled(): boolean {
  return useAppStore((s) => s.settings?.media_player_enabled === true);
}

function SelectedSourcePlayer({ path, state }: { path: string; state: ProbeState }) {
  const home = useHomeDir();
  const collapsed = useAppStore((s) => s.ui.playerCollapsed);
  const togglePlayerCollapsed = useAppStore((s) => s.togglePlayerCollapsed);
  const [lightbox, setLightbox] = useState<Handoff | null>(null);
  const [resume, setResume] = useState<Resume | null>(null);

  const closeLightbox = (position: Resume) => {
    setLightbox(null);
    // A fresh object each time: the panel player restores the position whenever this identity changes.
    setResume({ startAt: position.startAt, playing: position.playing });
  };

  return (
    <>
      <SourcePlayer
        path={path}
        state={state}
        homeDir={home.status === "ready" ? home.dir : null}
        homeReady={home.status !== "loading"}
        collapsed={collapsed}
        onToggleCollapsed={togglePlayerCollapsed}
        onEnlarge={setLightbox}
        resume={resume}
      />
      {lightbox !== null && (
        <PlayerLightbox
          plan={lightbox.plan}
          src={lightbox.src}
          name={sourceName(path)}
          startAt={lightbox.startAt}
          playing={lightbox.playing}
          onClose={closeLightbox}
        />
      )}
    </>
  );
}

/** The selected source, shown at the top of the settings panel. Nothing here may reach the settings below it. */
export default function InspectorPlayer({ path, state }: InspectorPlayerProps) {
  const enabled = useMediaPlayerEnabled();
  if (!enabled || path === null) return null;
  // The boundary sits outside everything the player owns, so no failure in it can reach the page around it.
  // Keyed by source: a new one starts with no open lightbox and no position left over from the last.
  return (
    <PlayerBoundary resetKey={path}>
      <SelectedSourcePlayer key={path} path={path} state={state} />
    </PlayerBoundary>
  );
}
