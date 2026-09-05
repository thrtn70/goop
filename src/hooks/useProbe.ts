import type { ProbeResult, ConversionCapabilities } from "@/types";

/** One coherent inspection result shared by source summaries and settings. */
export type ProbeState =
  | { phase: "probing" }
  | { phase: "ready"; probe: ProbeResult; capabilities: ConversionCapabilities }
  | { phase: "error"; message: string };
