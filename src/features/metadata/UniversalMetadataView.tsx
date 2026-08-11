import { useMemo } from "react";
import type { MetadataView, RawTag } from "@/types";
import { basename } from "./fields";

interface UniversalMetadataViewProps {
  view: MetadataView;
  /** Compact heading variant for use as an "all tags" expander under an editor. */
  title?: string;
}

function groupTags(raw: RawTag[]): [string, RawTag[]][] {
  const map = new Map<string, RawTag[]>();
  for (const t of raw) {
    const bucket = map.get(t.group);
    if (bucket) bucket.push(t);
    else map.set(t.group, [t]);
  }
  return [...map.entries()];
}

/**
 * Read-only grouped key/value table for any file's metadata. Backs the
 * universal viewer (image/video/PDF) and the "all tags" expander for audio.
 */
export default function UniversalMetadataView({ view, title }: UniversalMetadataViewProps) {
  const groups = useMemo(() => groupTags(view.raw), [view.raw]);

  return (
    <div className="flex flex-col gap-3 rounded-md border border-subtle bg-surface-1 p-4">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="font-display text-sm font-semibold text-fg">
          {title ?? basename(view.path)}
        </h3>
        <span className="text-xs uppercase tracking-wide text-fg-muted">{view.domain}</span>
      </div>

      {groups.length === 0 ? (
        <p className="text-xs text-fg-muted">No readable metadata.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {groups.map(([group, tags]) => (
            <div key={group} className="flex flex-col gap-1">
              <p className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
                {group}
              </p>
              <dl className="grid grid-cols-[minmax(8rem,12rem)_1fr] gap-x-3 gap-y-0.5 text-xs">
                {tags.map((t, i) => (
                  <div key={`${t.tag}-${t.value}-${i}`} className="contents">
                    <dt className="truncate text-fg-muted" title={t.tag}>
                      {t.tag}
                    </dt>
                    <dd className="break-words text-fg-secondary">{t.value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
