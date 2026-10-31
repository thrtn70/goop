import { useState } from "react";

export type Outcome = { text: string; seq: number; listKey: string };

/**
 * The success outcome of an Apply or preset. It describes the list it was
 * applied to, so it hides once files are added or removed.
 */
export function useOutcomeStatus(listKey: string): readonly [Outcome | null, (text: string | null) => void] {
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const announce = (text: string | null) =>
    setOutcome(previous => text === null ? null : { text, seq: (previous?.seq ?? 0) + 1, listKey });
  return [outcome?.listKey === listKey ? outcome : null, announce] as const;
}

/**
 * Always mounted, so VoiceOver hears the empty-to-text change. Each outcome is
 * a fresh node, so the same words after a second Apply are announced again.
 */
export function OutcomeStatus({ outcome }: { outcome: Outcome | null }) {
  return (
    <p role="status" className={outcome ? "mt-2 text-xs text-fg-secondary" : "text-xs"}>
      {outcome && <span key={outcome.seq}>{outcome.text}</span>}
    </p>
  );
}
