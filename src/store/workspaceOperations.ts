import { pinWorkspaceOutcomes } from "./workspaceOutcomes";
import { useCallback } from "react";
import { create } from "zustand";
import { useWorkspaceScope, type WorkspaceTool } from "./workspaceDrafts";

// Secondary operations retain only a token, never editable state or a promise.
const useOperations = create<{ active: Partial<Record<WorkspaceTool, number>> }>(() => ({ active: {} }));
let nextToken = 0;
export function useWorkspaceOperation() {
  const scope = useWorkspaceScope();
  const tool = scope.tool;
  const busy = useOperations(state => state.active[tool] !== undefined);
  const begin = useCallback((): (() => void) | null => {
    if (useOperations.getState().active[tool] !== undefined) return null;
    const token = ++nextToken;
    const unpin = pinWorkspaceOutcomes(scope);
    useOperations.setState(state => ({ active: { ...state.active, [tool]: token } }));
    return () => {
      if (useOperations.getState().active[tool] !== token) return;
      unpin();
      useOperations.setState(state => {
        const active = { ...state.active };
        delete active[tool];
        return { active };
      });
    };
  }, [tool, scope]);
  return { busy, begin };
}
