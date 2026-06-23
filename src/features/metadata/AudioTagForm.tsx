import { useMemo, useState } from "react";
import { api, metadataWrite } from "@/ipc/commands";
import { formatError } from "@/ipc/error";
import { useAppStore } from "@/store/appStore";
import type { AudioTags, CoverArtOp, MetadataView, MetadataWriteItem } from "@/types";
import CoverArtField from "./CoverArtField";
import UniversalMetadataView from "./UniversalMetadataView";
import { basename, diff, TextField } from "./fields";

interface AudioTagFormProps {
  view: MetadataView;
  onDone: () => void;
}

const EMPTY: AudioTags = {
  title: null,
  artist: null,
  album: null,
  album_artist: null,
  track: null,
  disc: null,
  year: null,
  genre: null,
  comment: null,
  composer: null,
};

/** Single-file audio editor: every field is prefilled with the file's current
 * value and diffed on save, so unchanged fields are left untouched. */
export default function AudioTagForm({ view, onDone }: AudioTagFormProps) {
  const enqueueToast = useAppStore((s) => s.enqueueToast);
  const orig = useMemo(() => view.audio ?? EMPTY, [view.audio]);

  const [title, setTitle] = useState(orig.title ?? "");
  const [artist, setArtist] = useState(orig.artist ?? "");
  const [album, setAlbum] = useState(orig.album ?? "");
  const [albumArtist, setAlbumArtist] = useState(orig.album_artist ?? "");
  const [track, setTrack] = useState(orig.track ?? "");
  const [disc, setDisc] = useState(orig.disc ?? "");
  const [year, setYear] = useState(orig.year ?? "");
  const [genre, setGenre] = useState(orig.genre ?? "");
  const [composer, setComposer] = useState(orig.composer ?? "");
  const [comment, setComment] = useState(orig.comment ?? "");
  const [cover, setCover] = useState<CoverArtOp>({ kind: "keep" });
  const [backup, setBackup] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const audio = useMemo<AudioTags>(
    () => ({
      title: diff(title, orig.title),
      artist: diff(artist, orig.artist),
      album: diff(album, orig.album),
      album_artist: diff(albumArtist, orig.album_artist),
      track: diff(track, orig.track),
      disc: diff(disc, orig.disc),
      year: diff(year, orig.year),
      genre: diff(genre, orig.genre),
      composer: diff(composer, orig.composer),
      comment: diff(comment, orig.comment),
    }),
    [title, artist, album, albumArtist, track, disc, year, genre, composer, comment, orig],
  );

  const dirty =
    Object.values(audio).some((v) => v !== null) || cover.kind !== "keep";

  async function handleApply() {
    if (!dirty || busy) return;
    setBusy(true);
    setError(null);
    try {
      const item: MetadataWriteItem = { path: view.path, audio, cover_art: cover };
      await api.metadata.run(metadataWrite([item], backup));
      enqueueToast({ variant: "success", title: "Metadata update queued" });
      onDone();
    } catch (e) {
      setError(formatError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h3 className="font-display text-base font-semibold text-fg">{basename(view.path)}</h3>
        <p className="text-xs text-fg-muted">Edit tags, then save in place.</p>
      </div>

      <CoverArtField current={view.cover_art} op={cover} onChange={setCover} />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <TextField label="Title" value={title} onChange={setTitle} />
        <TextField label="Artist" value={artist} onChange={setArtist} />
        <TextField label="Album" value={album} onChange={setAlbum} />
        <TextField label="Album artist" value={albumArtist} onChange={setAlbumArtist} />
        <TextField label="Track" value={track} onChange={setTrack} inputMode="numeric" />
        <TextField label="Disc" value={disc} onChange={setDisc} inputMode="numeric" />
        <TextField label="Year" value={year} onChange={setYear} inputMode="numeric" />
        <TextField label="Genre" value={genre} onChange={setGenre} />
        <TextField label="Composer" value={composer} onChange={setComposer} />
        <TextField label="Comment" value={comment} onChange={setComment} />
      </div>

      <div className="flex flex-wrap items-center gap-4 border-t border-subtle pt-3">
        <button
          type="button"
          disabled={!dirty || busy}
          onClick={() => void handleApply()}
          className="btn-press rounded-md bg-accent px-4 py-2 text-sm font-semibold text-accent-fg transition duration-fast ease-out enabled:hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save in place"}
        </button>
        <label className="flex items-center gap-2 text-xs text-fg-muted">
          <input type="checkbox" checked={backup} onChange={(e) => setBackup(e.target.checked)} />
          Keep a .bak backup
        </label>
        {error && <span className="text-xs text-error">{error}</span>}
      </div>

      <details className="text-xs">
        <summary className="cursor-pointer text-fg-muted hover:text-fg">All tags</summary>
        <div className="mt-2">
          <UniversalMetadataView view={view} title="Raw tags" />
        </div>
      </details>
    </div>
  );
}
