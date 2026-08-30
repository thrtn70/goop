import type { FormatOption } from "@/types";

/**
 * What a start was asked to download.
 *
 * Lives here rather than in `ProbeCard` because `ProbeCard` imports this
 * module for the state it renders from — leaving the type there would make
 * a cycle. A type-only cycle survives `tsc` and Vite, which is worse than
 * failing: it sits quiet until someone adds the first value export.
 */
export interface StartOptions {
  format: FormatOption | null;
  audioOnly: boolean;
}
