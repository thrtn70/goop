import { create } from "zustand";
export type SubmissionTool = "convert" | "compress";
type Phase = "choosing_destination" | "enqueuing";
type Slot = {
  active: { id: number; phase: Phase } | null;
  error: string | null;
};
export const useWorkspaceSubmissions = create<{
  convert: Slot;
  compress: Slot;
}>(() => ({
  convert: { active: null, error: null },
  compress: { active: null, error: null },
}));
let nextId = 0;
export function tryBegin(tool: SubmissionTool): number | null {
  if (useWorkspaceSubmissions.getState()[tool].active) return null;
  const id = ++nextId;
  useWorkspaceSubmissions.setState({
    [tool]: { active: { id, phase: "choosing_destination" }, error: null },
  });
  return id;
}
export function setSubmissionPhase(
  tool: SubmissionTool,
  id: number,
  phase: Phase,
) {
  if (useWorkspaceSubmissions.getState()[tool].active?.id !== id) return;
  useWorkspaceSubmissions.setState({
    [tool]: { active: { id, phase }, error: null },
  });
}
export function finishSubmission(
  tool: SubmissionTool,
  id: number,
  error: string | null,
) {
  if (useWorkspaceSubmissions.getState()[tool].active?.id !== id) return;
  useWorkspaceSubmissions.setState({ [tool]: { active: null, error } });
}

const destinationTokens: Record<SubmissionTool, number> = {
  convert: 0,
  compress: 0,
};
export function beginDestinationChoice(tool: SubmissionTool): number {
  const token = ++nextId;
  destinationTokens[tool] = token;
  return token;
}
export function isCurrentDestinationChoice(
  tool: SubmissionTool,
  token: number,
): boolean {
  return destinationTokens[tool] === token;
}
