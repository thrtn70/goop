import type { ConversionInspection } from "@/types";

/** One coherent inspection result shared by source summaries and settings. */
export type ProbeState =
  | { phase: "probing" }
  | ({ phase: "ready" } & ConversionInspection)
  | { phase: "error"; message: string };
