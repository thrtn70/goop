import {
  forgetEarlierDrafts,
  recoverSavedDrafts,
  retryDraftPersistence,
  useDraftForgetAvailable,
  useDraftForgetFailure,
  useDraftPersistence,
  useDraftRecoveryAvailable,
  useDraftRecoveryFailed,
  useDraftSavedEditsTooLarge,
  type DraftForgetFailure,
} from "@/store/workspaceDrafts";
import { DRAFT_BYTE_LIMIT, DRAFT_ENTRY_LIMIT, type DraftLimitCounts } from "@/store/workspacePersistence";

const FORGET_FAILURES: Record<DraftForgetFailure, string> = {
  no_backup_room: " Nothing was forgotten: there's no room to back up the saved edits first.",
  failed: " Nothing was forgotten.",
};
const kilobytes = (bytes: number) => `${Math.ceil(bytes / 1024)} KB`;

function overLimit(counts: DraftLimitCounts, earlierEdits: boolean) {
  const whose = earlierEdits ? "" : " from this session";
  return counts.entries > DRAFT_ENTRY_LIMIT
    ? `Too many unfinished edits${whose} to keep after a restart (${counts.entries} of ${DRAFT_ENTRY_LIMIT}).`
    : `Unfinished edits${whose} are too large to keep after a restart (${kilobytes(counts.bytes)} of ${kilobytes(DRAFT_BYTE_LIMIT)}).`;
}

export default function DraftPersistenceAlert() {
  const persistence = useDraftPersistence();
  const savedEditsTooLarge = useDraftSavedEditsTooLarge();
  const forgetAvailable = useDraftForgetAvailable();
  const forgetFailure = useDraftForgetFailure();
  const recoveryAvailable = useDraftRecoveryAvailable();
  const recoveryFailed = useDraftRecoveryFailed();
  // The alert and its focused button go away on success; keep focus in the page.
  const keepFocus = (saved: boolean) => { if (saved) document.getElementById("main")?.focus(); };
  if (persistence.kind === "ok") return null;
  if (persistence.kind === "full" || savedEditsTooLarge) {
    const reason = persistence.kind === "full"
      ? overLimit(persistence, forgetAvailable)
      : "Unfinished edits from earlier sessions are too large to restore.";
    return (
      <div role="alert" className="px-4 py-2 text-sm text-warning">
        {reason} Your edits still work until you quit.{forgetAvailable && <> <button onClick={() => keepFocus(forgetEarlierDrafts())} className="underline">Forget edits from earlier sessions</button>{forgetFailure && FORGET_FAILURES[forgetFailure]}</>}
      </div>
    );
  }
  return (
    <div role="alert" className="px-4 py-2 text-sm text-warning">
      Unfinished edits could not be saved for restart. <button onClick={retryDraftPersistence} className="underline">Try again</button>{recoveryAvailable && <> Some saved edits can&apos;t be read. <button onClick={() => keepFocus(recoverSavedDrafts())} className="underline">Back up and recover what can be read</button>{recoveryFailed && " Nothing was recovered."}</>}
    </div>
  );
}
