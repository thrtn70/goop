let failNextDraftWrite = false;

export function armNextDraftWriteFailure(): void {
  failNextDraftWrite = true;
}

export function consumeNextDraftWriteFailure(): boolean {
  if (!failNextDraftWrite) return false;
  failNextDraftWrite = false;
  return true;
}
