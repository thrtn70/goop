import { create } from "zustand";
import { IDLE_START, nextStartState, type StartEvent, type StartState } from "@/features/extract/startState";

/** Runtime attempt ownership outlives the route that submitted it, not the app. */
export const useExtractSession = create<{ start: StartState; nextId: number; send: (event: StartEvent) => void }>((set) => ({
  start: IDLE_START,
  nextId: 0,
  send: event => set(state => ({ start: nextStartState(state.start, event) })),
}));

export function nextExtractAttemptId() {
  const id = useExtractSession.getState().nextId + 1;
  useExtractSession.setState({ nextId: id });
  return id;
}

export function resetExtractSession() {
  // Keep ids monotonic so a promise from before reset cannot settle a new attempt.
  useExtractSession.setState({ start: IDLE_START });
}
