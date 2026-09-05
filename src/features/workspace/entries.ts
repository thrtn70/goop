export type EntryIdentity = {
  id?: string;
  revision?: number;
  submittedEdit?: boolean;
};
export type SubmissionReceipt = {
  id?: string;
  revision?: number;
  path: string;
};
let nextEntry = 0;
export function newIdentity() {
  return { id: `source-${++nextEntry}`, revision: 0 };
}
export function reconcileSubmitted<T extends EntryIdentity & { path: string }>(
  current: T[],
  success: SubmissionReceipt[],
): T[] {
  return current.flatMap((entry) => {
    const sent = success.find(
      (item) => item.id === entry.id && item.path === entry.path,
    );
    if (!sent) return [entry];
    if (sent.revision === entry.revision) return [];
    return [{ ...entry, submittedEdit: true }];
  });
}
