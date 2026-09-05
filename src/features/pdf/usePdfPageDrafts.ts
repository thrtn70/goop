import { useCallback, useState, type Dispatch, type SetStateAction } from "react";
import { useWorkspaceDraftState } from "@/store/workspaceDrafts";
import type { PageState } from "./PdfPageCard";

type PageIntent = Omit<PageState, "thumbPath">;
const intentOf = ({ originalPage, deleted, rotation }: PageState): PageIntent => ({ originalPage, deleted, rotation });

/** Keep edits, not thumbnails, while the active route reloads page previews. */
export function usePdfPageDrafts(slot: string) {
  const [intent, setIntent] = useWorkspaceDraftState<PageIntent[]>(slot, []);
  const [thumbs, setThumbs] = useState<Record<number, string | null>>({});
  const pages = intent.map(page => ({ ...page, thumbPath: thumbs[page.originalPage] ?? null }));
  const setPages: Dispatch<SetStateAction<PageState[]>> = useCallback(next => {
    setIntent(current => {
      const withThumbs = current.map(page => ({ ...page, thumbPath: thumbs[page.originalPage] ?? null }));
      return (typeof next === "function" ? next(withThumbs) : next).map(intentOf);
    });
  }, [setIntent, thumbs]);
  const loadPages = useCallback((fresh: PageState[]) => {
    setThumbs(Object.fromEntries(fresh.map(page => [page.originalPage, page.thumbPath])));
    setIntent(current => {
      const valid = new Set(fresh.map(page => page.originalPage));
      const retained = current.filter(page => valid.has(page.originalPage));
      const seen = new Set(retained.map(page => page.originalPage));
      return [...retained, ...fresh.filter(page => !seen.has(page.originalPage)).map(intentOf)];
    });
  }, [setIntent]);
  return { pages, setPages, loadPages };
}
