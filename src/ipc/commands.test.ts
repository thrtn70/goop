import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
import {
  imageAppIcon,
  imageCrop,
  imageRecompress,
  imageResize,
  imageRotate,
  imageWatermark,
  pdfCompress,
  pdfDeletePages,
  pdfExtractImages,
  pdfExtractPages,
  pdfExtractText,
  pdfImageOcr,
  pdfImagesToPdf,
  pdfInsertBlank,
  pdfMerge,
  pdfOcr,
  pdfReorder,
  pdfRotate,
  pdfSetMetadata,
  pdfSplit,
} from "./commands";
import { api } from "./commands";

// Lock the discriminator + field names emitted by each PdfOperation
// builder. The Rust side uses #[serde(tag = "kind", rename_all =
// "snake_case")]; if the wire shape ever drifts, the backend's
// `match` arms stop matching and PDF jobs silently fail at runtime.
// These tests are the canary.
describe("PdfOperation builders emit the correct discriminator", () => {
  it("pdfMerge → kind=merge with output_path", () => {
    expect(pdfMerge(["/a.pdf", "/b.pdf"], "/out.pdf")).toEqual({
      kind: "merge",
      inputs: ["/a.pdf", "/b.pdf"],
      output_path: "/out.pdf",
    });
  });

  it("pdfSplit → kind=split with output_dir", () => {
    expect(pdfSplit("/in.pdf", [{ start: 1, end: 3 }], "/out")).toEqual({
      kind: "split",
      input: "/in.pdf",
      ranges: [{ start: 1, end: 3 }],
      output_dir: "/out",
    });
  });

  it("pdfCompress → kind=compress with quality enum", () => {
    expect(pdfCompress("/in.pdf", "/out.pdf", "ebook")).toEqual({
      kind: "compress",
      input: "/in.pdf",
      output_path: "/out.pdf",
      quality: "ebook",
    });
  });

  it("pdfExtractPages → kind=extract_pages", () => {
    expect(
      pdfExtractPages("/in.pdf", [{ start: 1, end: 2 }], "/out.pdf"),
    ).toEqual({
      kind: "extract_pages",
      input: "/in.pdf",
      ranges: [{ start: 1, end: 2 }],
      output_path: "/out.pdf",
    });
  });

  it("pdfRotate → kind=rotate with cw90/cw180/cw270 rotations", () => {
    expect(
      pdfRotate(
        "/in.pdf",
        [
          { page: 1, rotation: "cw90" },
          { page: 2, rotation: "cw270" },
        ],
        "/out.pdf",
      ),
    ).toEqual({
      kind: "rotate",
      input: "/in.pdf",
      rotations: [
        { page: 1, rotation: "cw90" },
        { page: 2, rotation: "cw270" },
      ],
      output_path: "/out.pdf",
    });
  });

  it("pdfReorder → kind=reorder with permutation order", () => {
    expect(pdfReorder("/in.pdf", [3, 1, 2], "/out.pdf")).toEqual({
      kind: "reorder",
      input: "/in.pdf",
      order: [3, 1, 2],
      output_path: "/out.pdf",
    });
  });

  it("pdfDeletePages → kind=delete_pages", () => {
    expect(pdfDeletePages("/in.pdf", [2, 4], "/out.pdf")).toEqual({
      kind: "delete_pages",
      input: "/in.pdf",
      pages: [2, 4],
      output_path: "/out.pdf",
    });
  });

  it("pdfInsertBlank → kind=insert_blank", () => {
    expect(pdfInsertBlank("/in.pdf", [1, 4], "/out.pdf")).toEqual({
      kind: "insert_blank",
      input: "/in.pdf",
      positions: [1, 4],
      output_path: "/out.pdf",
    });
  });

  it("pdfSetMetadata → kind=set_metadata with optional fields", () => {
    expect(
      pdfSetMetadata(
        "/in.pdf",
        { title: "Hello", author: null, subject: "", keywords: null },
        "/out.pdf",
      ),
    ).toEqual({
      kind: "set_metadata",
      input: "/in.pdf",
      metadata: { title: "Hello", author: null, subject: "", keywords: null },
      output_path: "/out.pdf",
    });
  });

  it("pdfExtractText → kind=extract_text", () => {
    expect(pdfExtractText("/in.pdf", "/out.txt")).toEqual({
      kind: "extract_text",
      input: "/in.pdf",
      output_path: "/out.txt",
    });
  });

  it("pdfExtractImages → kind=extract_images with format and dpi", () => {
    expect(pdfExtractImages("/in.pdf", "/out", "png", 150)).toEqual({
      kind: "extract_images",
      input: "/in.pdf",
      output_dir: "/out",
      format: "png",
      dpi: 150,
    });
    // jpeg variant — wire value is "jpeg" even though mutool's CLI flag is
    // "jpg"; the Rust-side helper handles the translation.
    expect(pdfExtractImages("/in.pdf", "/out", "jpeg", 200)).toEqual({
      kind: "extract_images",
      input: "/in.pdf",
      output_dir: "/out",
      format: "jpeg",
      dpi: 200,
    });
  });

  it("pdfImagesToPdf → kind=images_to_pdf with ordered inputs", () => {
    expect(pdfImagesToPdf(["/a.png", "/b.jpg"], "/out.pdf")).toEqual({
      kind: "images_to_pdf",
      inputs: ["/a.png", "/b.jpg"],
      output_path: "/out.pdf",
    });
  });

  it("pdfOcr → kind=pdf_ocr with lang", () => {
    expect(pdfOcr("/scan.pdf", "/searchable.pdf", "eng")).toEqual({
      kind: "pdf_ocr",
      input: "/scan.pdf",
      output_path: "/searchable.pdf",
      lang: "eng",
    });
  });

  it("pdfImageOcr → kind=image_ocr with output_kind and lang", () => {
    expect(
      pdfImageOcr(["/photo.jpg"], "/words.txt", "text", "eng"),
    ).toEqual({
      kind: "image_ocr",
      inputs: ["/photo.jpg"],
      output_path: "/words.txt",
      output_kind: "text",
      lang: "eng",
    });
    expect(
      pdfImageOcr(["/a.png", "/b.png"], "/out.pdf", "searchable_pdf", "fra"),
    ).toEqual({
      kind: "image_ocr",
      inputs: ["/a.png", "/b.png"],
      output_path: "/out.pdf",
      output_kind: "searchable_pdf",
      lang: "fra",
    });
  });
});

// Mirror the canary tests for ImageOperation builders. Same justification:
// the Rust side uses #[serde(tag = "kind", rename_all = "snake_case")] in
// crates/goop-core/src/image.rs; drift here means image jobs silently fail
// at runtime.
describe("ImageOperation builders emit the correct discriminator", () => {
  it("imageRotate → kind=rotate with cw90/cw180/cw270 degrees", () => {
    expect(imageRotate("/in.png", "cw90", "/out.png")).toEqual({
      kind: "rotate",
      input: "/in.png",
      degrees: "cw90",
      output_path: "/out.png",
    });
    expect(imageRotate("/in.jpg", "cw180", "/out.jpg")).toEqual({
      kind: "rotate",
      input: "/in.jpg",
      degrees: "cw180",
      output_path: "/out.jpg",
    });
    expect(imageRotate("/in.jpg", "cw270", "/out.jpg")).toEqual({
      kind: "rotate",
      input: "/in.jpg",
      degrees: "cw270",
      output_path: "/out.jpg",
    });
  });

  it("imageResize → kind=resize covering all three modes", () => {
    expect(imageResize("/in.png", 800, 600, "fit_within", "/out.png")).toEqual({
      kind: "resize",
      input: "/in.png",
      width: 800,
      height: 600,
      mode: "fit_within",
      output_path: "/out.png",
    });
    expect(imageResize("/in.png", 800, 600, "fit_exact", "/out.png")).toEqual({
      kind: "resize",
      input: "/in.png",
      width: 800,
      height: 600,
      mode: "fit_exact",
      output_path: "/out.png",
    });
    expect(imageResize("/in.png", 50, 0, "scale", "/out.png")).toEqual({
      kind: "resize",
      input: "/in.png",
      width: 50,
      height: 0,
      mode: "scale",
      output_path: "/out.png",
    });
  });

  it("imageCrop → kind=crop with pixel-coord rect", () => {
    expect(
      imageCrop(
        "/in.png",
        { x: 10, y: 20, width: 100, height: 200 },
        "/out.png",
      ),
    ).toEqual({
      kind: "crop",
      input: "/in.png",
      rect: { x: 10, y: 20, width: 100, height: 200 },
      output_path: "/out.png",
    });
  });

  it("imageWatermark → kind=watermark with text-only spec", () => {
    expect(
      imageWatermark(
        "/in.png",
        { text: "© 2026", position: "bottom_right", opacity: 80 },
        "/out.png",
      ),
    ).toEqual({
      kind: "watermark",
      input: "/in.png",
      spec: { text: "© 2026", position: "bottom_right", opacity: 80 },
      output_path: "/out.png",
    });
  });

  it("imageRecompress → kind=recompress with ordered inputs + output_dir + quality", () => {
    expect(imageRecompress(["/a.jpg", "/b.jpg"], "/out", 75)).toEqual({
      kind: "recompress",
      inputs: ["/a.jpg", "/b.jpg"],
      output_dir: "/out",
      quality: 75,
    });
  });

  it("imageAppIcon → kind=app_icon with platform list", () => {
    expect(
      imageAppIcon("/logo.png", "/icons", ["macos", "windows", "web"]),
    ).toEqual({
      kind: "app_icon",
      input: "/logo.png",
      output_dir: "/icons",
      platforms: ["macos", "windows", "web"],
    });
  });
});

// Wire-name canaries for the queue job-control commands: the invoke name
// and argument key must match the #[tauri::command] fn name and parameter
// (camelCased) on the Rust side, or the call fails only at runtime.
describe("queue job-control wire canaries", () => {
  beforeEach(() => {
    invokeMock.mockClear();
  });

  it("api.queue.retry invokes queue_retry with { jobId }", async () => {
    await api.queue.retry("abc");
    expect(invokeMock).toHaveBeenCalledWith("queue_retry", { jobId: "abc" });
  });

  it("api.queue.pause invokes queue_pause with { jobId }", async () => {
    await api.queue.pause("abc");
    expect(invokeMock).toHaveBeenCalledWith("queue_pause", { jobId: "abc" });
  });

  it("api.queue.resume invokes queue_resume with { jobId }", async () => {
    await api.queue.resume("abc");
    expect(invokeMock).toHaveBeenCalledWith("queue_resume", { jobId: "abc" });
  });
});

// The subtitle payload crosses the IPC boundary as a nested object whose
// field names must match the serde shape of `SubtitleOptions` exactly —
// a rename on either side would only surface at runtime.
describe("convert subtitle wire canary", () => {
  beforeEach(() => {
    invokeMock.mockClear();
  });

  it("passes subtitle options through untouched", async () => {
    const req = {
      input_path: "/in.mp4",
      output_path: "/out.mp4",
      target: "mp4",
      quality_preset: null,
      resolution_cap: null,
      gif_options: null,
      compress_mode: null,
      batch_id: null,
      metadata_policy: null,
      subtitle: { source_path: "/subs.srt", mode: "burn_in" },
    } as const;

    await api.convert.fromFile(req);

    expect(invokeMock).toHaveBeenCalledWith("convert_from_file", { req });
  });
});

describe("conversion inspection", () => {
  it("requests one engine inspection for the probe and capability pair", async () => {
    invokeMock.mockClear();
    await api.convert.inspect("/tmp/photo.dng");
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("convert_inspect", { path: "/tmp/photo.dng" });
  });
});
