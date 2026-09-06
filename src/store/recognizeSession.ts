import { create } from "zustand";
import { api, pdfRecognizeText } from "@/ipc/commands";
import { formatError } from "@/ipc/error";
import type { ImageOcrOutput, JobId } from "@/types";
import { jobIdKey, useAppStore } from "./appStore";
import { subscribeWorkspaceRetirement } from "./workspaceDrafts";

type Submission = {input: string; outputKind: ImageOcrOutput; lang: string};
type Session = {
  attempt: number;
  submitted: Submission | null;
  jobId: JobId | null;
  phase: "idle" | "submitting" | "running" | "peeking" | "done" | "error";
  error: string | null;
  recovery: "preview" | "queue" | null;
  outputPath: string | null;
  result: {text: string; outputPath: string} | null;
  acknowledgedGeneration: number;
};
let nextAttempt = 0;
const empty = (): Session => ({attempt: ++nextAttempt, submitted: null, jobId: null, phase: "idle", error: null, recovery: null, outputPath: null, result: null, acknowledgedGeneration: 0});
export const useRecognizeSession = create<Session>(() => empty());
export function clearRecognizeSession() { useRecognizeSession.setState(empty()); }
subscribeWorkspaceRetirement(event => {
  if (!event.tool || event.tool === "recognize") clearRecognizeSession();
});
const current = (attempt: number) => useRecognizeSession.getState().attempt === attempt;
export function beginRecognizeSession(submitted: Submission) {
  const state = {...empty(), submitted, phase: "submitting" as const};
  useRecognizeSession.setState(state);
  return state.attempt;
}
export function cancelRecognizeSubmission(attempt: number) {
  if (current(attempt)) useRecognizeSession.setState({phase: "idle"});
}
export function failRecognizeSubmission(attempt: number, error: unknown) {
  if (current(attempt)) useRecognizeSession.setState({phase: "error", error: formatError(error).slice(0, 8192)});
}
export async function enqueueRecognize(attempt: number, outputPath: string) {
  const state = useRecognizeSession.getState();
  if (!current(attempt) || !state.submitted) return;
  const {input, outputKind, lang} = state.submitted;
  const jobId = await api.pdf.run(pdfRecognizeText(input, outputPath, outputKind, lang));
  if (!current(attempt)) return;
  // A list started before acknowledgement cannot establish job absence.
  useRecognizeSession.setState({jobId, phase: "running", acknowledgedGeneration: useAppStore.getState().queueRequestGeneration});
  reconcileRecognize();
  void refreshRecognizeQueue();
}
async function peek(attempt: number, outputPath: string) {
  if (!current(attempt)) return;
  useRecognizeSession.setState({phase: "peeking", error: null, recovery: null, outputPath});
  try {
    const text = await api.pdf.recognizePeekText(outputPath);
    if (current(attempt)) useRecognizeSession.setState({phase: "done", result: {text: Array.from(text).slice(0, 100_000).join(""), outputPath}});
  } catch (error) {
    if (current(attempt)) useRecognizeSession.setState({phase: "error", error: formatError(error).slice(0, 8192), recovery: "preview"});
  }
}
export function retryRecognizePreview() {
  const state = useRecognizeSession.getState();
  if (state.recovery === "preview" && state.outputPath) void peek(state.attempt, state.outputPath);
}
export async function refreshRecognizeQueue() {
  try { await useAppStore.getState().refreshJobs(); }
  catch { /* A failed refresh cannot prove a submitted job disappeared. */ }
}
function reconcileRecognize() {
  const state = useRecognizeSession.getState();
  if (!state.jobId || (state.phase !== "running" && state.recovery !== "queue")) return;
  const queue = useAppStore.getState();
  const submittedId = jobIdKey(state.jobId);
  const job = queue.jobs.find(job => jobIdKey(job.id) === submittedId);
  if (!job) {
    if (queue.queueSnapshotGeneration > state.acknowledgedGeneration) {
      useRecognizeSession.setState({phase: "error", error: "Recognition job is no longer in the queue. Refresh the queue or recognize again.", recovery: "queue"});
    }
  } else if (job.state === "done") {
    if (job.result?.output_path) void peek(state.attempt, job.result.output_path);
    else useRecognizeSession.setState({phase: "error", error: "Recognition finished without an output file.", recovery: null});
  } else if (job.state === "cancelled") {
    useRecognizeSession.setState({phase: "error", error: "Recognition cancelled.", recovery: null});
  } else if (typeof job.state === "object" && "error" in job.state) {
    useRecognizeSession.setState({phase: "error", error: job.state.error.message.slice(0, 8192), recovery: null});
  } else if (state.recovery === "queue") {
    useRecognizeSession.setState({phase: "running", error: null, recovery: null});
  }
}
useAppStore.subscribe((state, previous) => {
  if (state.jobs !== previous.jobs || state.queueSnapshotGeneration !== previous.queueSnapshotGeneration) reconcileRecognize();
});
