import { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { JobId } from "@/types";
import { jobIdKey, useAppStore } from "@/store/appStore";

export type ThumbnailState =
  | { status: "loading" }
  | { status: "ready"; src: string }
  | { status: "unavailable" };

/**
 * Resolve a validated thumbnail URL for a job. The path is fetched from the
 * store (possibly from disk via IPC) and then pre-loaded in memory with
 * `new Image()` before we expose it. That way the caller can render `<img>`
 * without the browser's default broken-image icon ever flashing when the
 * backing file is missing or stale.
 *
 * If the first attempt fails, the store entry is invalidated and the backend
 * is asked to regenerate once. A second failure resolves to `"unavailable"`.
 *
 * Implementation note: we deliberately do NOT subscribe to the
 * `thumbnailsById[key]` store slice. The effect calls `invalidateThumbnail`
 * during the regen path, which would mutate that slice and re-fire the
 * effect mid-flight, racing two concurrent IPC calls. Instead, we read the
 * cached path once at effect entry via `getState()` and react only to
 * `jobId` / `skip` changes.
 */
export function useThumbnail(jobId: JobId, skip: boolean): ThumbnailState {
  const key = jobIdKey(jobId);
  const [state, setState] = useState<ThumbnailState>({ status: "loading" });

  useEffect(() => {
    if (skip) {
      setState({ status: "unavailable" });
      return;
    }

    let cancelled = false;
    setState({ status: "loading" });

    function verify(path: string): Promise<boolean> {
      return new Promise((resolve) => {
        const probe = new Image();
        probe.onload = () => resolve(true);
        probe.onerror = () => resolve(false);
        probe.src = convertFileSrc(path);
      });
    }

    (async () => {
      const store = useAppStore.getState();
      const initial = store.thumbnailsById[key] ?? null;
      let path: string | null = initial;
      if (!path) {
        path = await store.loadThumbnail(jobId);
      }
      if (cancelled) return;
      if (!path) {
        setState({ status: "unavailable" });
        return;
      }

      const ok = await verify(path);
      if (cancelled) return;
      if (ok) {
        setState({ status: "ready", src: convertFileSrc(path) });
        return;
      }

      // Path was stale; drop it, ask backend to regenerate, try once more.
      // This call mutates the store slice we deliberately don't subscribe
      // to — see the implementation note above.
      const latest = useAppStore.getState();
      latest.invalidateThumbnail(jobId);
      const fresh = await latest.loadThumbnail(jobId);
      if (cancelled) return;
      if (!fresh) {
        setState({ status: "unavailable" });
        return;
      }
      const freshOk = await verify(fresh);
      if (cancelled) return;
      setState(
        freshOk ? { status: "ready", src: convertFileSrc(fresh) } : { status: "unavailable" },
      );
    })();

    return () => {
      cancelled = true;
    };
  }, [jobId, key, skip]);

  return state;
}
