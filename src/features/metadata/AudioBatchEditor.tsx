import { useWorkspaceOutcomeState } from "@/store/workspaceOutcomes";
import { useWorkspaceOperation } from "@/store/workspaceOperations";
import { withWorkspaceDrafts } from "@/store/workspaceDrafts";
import { useWorkspaceDraftState } from "@/store/workspaceDrafts";
import { api, metadataWrite } from "@/ipc/commands";
import { formatError } from "@/ipc/error";
import { useAppStore } from "@/store/appStore";
import type { AudioTags, CoverArtOp, MetadataView, MetadataWriteItem } from "@/types";
import CoverArtField from "./CoverArtField";
import { basename, diff, TextField } from "./fields";

interface AudioBatchEditorProps {
  views: MetadataView[];
  onDone: () => void;
}

/** Placeholder showing the shared value across the selection, or "Multiple
 * values" when they differ — so the user sees current state without the field
 * being pre-filled (which would re-write it). */
function sharedPlaceholder(views: MetadataView[], get: (a: AudioTags) => string | null): string {
  const vals = new Set(views.map((v) => (v.audio ? get(v.audio) ?? "" : "")));
  if (vals.size === 1) {
    const only = [...vals][0];
    return only === "" ? "—" : only;
  }
  return "Multiple values";
}

/**
 * Multi-file album tagger. Shared fields (artist/album/year/…) apply to every
 * selected file when filled, and are left untouched when blank. Title and track
 * are edited per file in the table. "Apply" fans out into a single batch job.
 */
function AudioBatchEditor({ views, onDone }: AudioBatchEditorProps) {
  const enqueueToast = useAppStore((s) => s.enqueueToast);

  // Shared fields start blank: blank = leave each file's value untouched.
  const [artist, setArtist] = useWorkspaceDraftState("AudioBatchEditor.artist", "");
  const [album, setAlbum] = useWorkspaceDraftState("AudioBatchEditor.album", "");
  const [albumArtist, setAlbumArtist] = useWorkspaceDraftState("AudioBatchEditor.albumArtist", "");
  const [year, setYear] = useWorkspaceDraftState("AudioBatchEditor.year", "");
  const [genre, setGenre] = useWorkspaceDraftState("AudioBatchEditor.genre", "");
  const [disc, setDisc] = useWorkspaceDraftState("AudioBatchEditor.disc", "");
  const [composer, setComposer] = useWorkspaceDraftState("AudioBatchEditor.composer", "");
  const [comment, setComment] = useWorkspaceDraftState("AudioBatchEditor.comment", "");

  // Per-file fields prefilled with current values.
  const [titles, setTitles] = useWorkspaceDraftState<Record<string, string>>("AudioBatchEditor.titles", () =>
    Object.fromEntries(views.map((v) => [v.path, v.audio?.title ?? ""])),
  );
  const [tracks, setTracks] = useWorkspaceDraftState<Record<string, string>>("AudioBatchEditor.tracks", () =>
    Object.fromEntries(views.map((v) => [v.path, v.audio?.track ?? ""])),
  );

  const [cover, setCover] = useWorkspaceDraftState<CoverArtOp>("AudioBatchEditor.cover", { kind: "keep" });
  const [backup, setBackup] = useWorkspaceDraftState("AudioBatchEditor.backup", false);
  const { busy, begin } = useWorkspaceOperation();
  const [error, setError] = useWorkspaceOutcomeState<string | null>("AudioBatchEditor.error", null);

  const shared = (s: string): string | null => (s.trim() === "" ? null : s);

  // Something to write iff a shared field is filled, a per-track value changed,
  // or the cover op isn't "keep". Avoids enqueueing a no-op that just touches mtimes.
  const dirty =
    [artist, album, albumArtist, year, genre, disc, composer, comment].some(
      (s) => s.trim() !== "",
    ) ||
    views.some(
      (v) =>
        (titles[v.path] ?? "") !== (v.audio?.title ?? "") ||
        (tracks[v.path] ?? "") !== (v.audio?.track ?? ""),
    ) ||
    cover.kind !== "keep";

  async function handleApply() {
    if (busy || !dirty) return;
    const finish = begin();
    if (!finish) return;
    setError(null);
    try {
      const items: MetadataWriteItem[] = views.map((v) => {
        const orig = v.audio;
        const audio: AudioTags = {
          title: diff(titles[v.path] ?? "", orig?.title ?? null),
          artist: shared(artist),
          album: shared(album),
          album_artist: shared(albumArtist),
          track: diff(tracks[v.path] ?? "", orig?.track ?? null),
          disc: shared(disc),
          year: shared(year),
          genre: shared(genre),
          comment: shared(comment),
          composer: shared(composer),
        };
        return { path: v.path, audio, cover_art: cover };
      });
      await api.metadata.run(metadataWrite(items, backup));
      enqueueToast({
        variant: "success",
        title: `Tagging ${items.length} files queued`,
      });
      onDone();
    } catch (e) {
      setError(formatError(e));
    } finally {
      finish();
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h3 className="font-display text-base font-semibold text-fg">
          Tag {views.length} tracks
        </h3>
        <p className="text-xs text-fg-muted">
          Shared fields below apply to every track when filled, and are left
          untouched when blank. Edit titles and track numbers per file.
        </p>
      </div>

      <CoverArtField current={views[0]?.cover_art ?? null} op={cover} onChange={setCover} batch />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <TextField label="Artist" value={artist} onChange={setArtist} placeholder={sharedPlaceholder(views, (a) => a.artist)} />
        <TextField label="Album" value={album} onChange={setAlbum} placeholder={sharedPlaceholder(views, (a) => a.album)} />
        <TextField label="Album artist" value={albumArtist} onChange={setAlbumArtist} placeholder={sharedPlaceholder(views, (a) => a.album_artist)} />
        <TextField label="Year" value={year} onChange={setYear} inputMode="numeric" placeholder={sharedPlaceholder(views, (a) => a.year)} />
        <TextField label="Genre" value={genre} onChange={setGenre} placeholder={sharedPlaceholder(views, (a) => a.genre)} />
        <TextField label="Disc" value={disc} onChange={setDisc} inputMode="numeric" placeholder={sharedPlaceholder(views, (a) => a.disc)} />
        <TextField label="Composer" value={composer} onChange={setComposer} placeholder={sharedPlaceholder(views, (a) => a.composer)} />
        <TextField label="Comment" value={comment} onChange={setComment} placeholder={sharedPlaceholder(views, (a) => a.comment)} />
      </div>

      <div className="flex flex-col gap-1">
        <p className="text-xs uppercase tracking-wide text-fg-muted">Per-track</p>
        <div className="flex flex-col gap-1.5 rounded-md border border-subtle bg-surface-1 p-2">
          {views.map((v) => (
            <div key={v.path} className="grid grid-cols-[1fr_minmax(0,2fr)_5rem] items-center gap-2">
              <span className="truncate text-xs text-fg-muted" title={v.path}>
                {basename(v.path)}
              </span>
              <input
                type="text"
                value={titles[v.path] ?? ""}
                placeholder="Title"
                aria-label={`Title for ${basename(v.path)}`}
                onChange={(e) => setTitles((t) => ({ ...t, [v.path]: e.target.value }))}
                className="rounded-md bg-surface-2 px-2 py-1.5 text-sm text-fg focus:outline-none focus:ring-2 focus:ring-accent"
              />
              <input
                type="text"
                inputMode="numeric"
                value={tracks[v.path] ?? ""}
                placeholder="#"
                aria-label={`Track number for ${basename(v.path)}`}
                onChange={(e) => setTracks((t) => ({ ...t, [v.path]: e.target.value }))}
                className="rounded-md bg-surface-2 px-2 py-1.5 text-sm text-fg focus:outline-none focus:ring-2 focus:ring-accent"
              />
            </div>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-4 border-t border-subtle pt-3">
        <button
          type="button"
          disabled={busy || !dirty}
          onClick={() => void handleApply()}
          className="btn-press rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-fg transition duration-fast ease-out enabled:hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? "Saving…" : `Apply to ${views.length} tracks`}
        </button>
        <label className="flex items-center gap-2 text-xs text-fg-muted">
          <input type="checkbox" checked={backup} onChange={(e) => setBackup(e.target.checked)} />
          Keep .bak backups
        </label>
        {error && <span className="text-xs text-error">{error}</span>}
      </div>
    </div>
  );
}

export default withWorkspaceDrafts(AudioBatchEditor, undefined, props => ["batch", ...props.views.map(v => v.path).sort()]);
