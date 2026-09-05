import { useCallback } from "react";
import { create } from "zustand";
import { useWorkspaceTool, type WorkspaceTool } from "./workspaceDrafts";

// Secondary operations retain only a token, never editable state or a promise.
const useOperations = create<{ active: Partial<Record<WorkspaceTool, number>> }>(() => ({ active: {} }));
let nextToken = 0;
export function useWorkspaceOperation() {
  const tool = useWorkspaceTool();
  const busy = useOperations(state => state.active[tool] !== undefined);
  const begin = useCallback((): (() => void) | null => {
    if (useOperations.getState().active[tool] !== undefined) return null;
    const token = ++nextToken;
    useOperations.setState(state => ({ active: { ...state.active, [tool]: token } }));
    return () => {
      if (useOperations.getState().active[tool] !== token) return;
      useOperations.setState(state => {
        const active = { ...state.active };
        delete active[tool];
        return { active };
      });
    };
  }, [tool]);
  return { busy, begin };
}
