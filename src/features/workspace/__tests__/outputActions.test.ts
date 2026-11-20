import { describe, expect, it } from "vitest";
import type { Job } from "@/types";
import { completedOutput, handoffUnavailable, outputActionIds } from "../outputActions";

function job(state: Job["state"], path: string | null, resultKind: "file" | "folder" = "file"): Job {
  return {
    id: "source-job",
    kind: "extract",
    state,
    payload: null,
    result: path
      ? {
          output_path: path,
          result_kind: resultKind,
          file_count: resultKind === "folder" ? 3 : 1,
          bytes: 1n,
          duration_ms: 1n,
        }
      : null,
    priority: 0,
    attempts: 1,
    created_at: 1n,
    started_at: 1n,
    finished_at: 2n,
  } as Job;
}

describe("completed output actions", () => {
  it("offers path utilities and deliberate handoffs for a completed file", () => {
    const output = completedOutput(job("done", "/tmp/movie.mp4"));
    expect(output).toMatchObject({ path: "/tmp/movie.mp4", kind: "file" });
    expect(outputActionIds(output)).toEqual([
      "open",
      "reveal",
      "copy_path",
      "convert",
      "compress",
    ]);
  });

  it("offers handoffs for a downloaded album, but not for other folders", () => {
    const album = job("done", "/tmp/album", "folder");
    expect(outputActionIds(completedOutput(album))).toEqual(["open", "reveal", "copy_path", "convert", "compress"]);
    const split = { ...album, kind: "pdf" } as Job;
    expect(outputActionIds(completedOutput(split))).toEqual(["open", "reveal", "copy_path"]);
  });

  it("explains why an album without a saved file list can't be handed off", () => {
    const old = job("done", "/tmp/album", "folder");
    const listed = { ...old, result: { ...old.result!, files: ["1.jpg"] } } as Job;
    expect(handoffUnavailable(old)).toBe("No file list was saved for this album: use Show in Finder");
    expect(handoffUnavailable({ ...old, result: { ...old.result!, files: [] } } as Job)).toBe("No file list was saved for this album: use Show in Finder");
    expect(handoffUnavailable(listed)).toBeNull();
    expect(handoffUnavailable(job("done", "/tmp/movie.mp4"))).toBeNull();
  });

  it("offers no output actions without a done result and path", () => {
    expect(completedOutput(job("running", "/tmp/movie.mp4"))).toBeNull();
    expect(completedOutput(job("done", null))).toBeNull();
    expect(outputActionIds(null)).toEqual([]);
  });
});
