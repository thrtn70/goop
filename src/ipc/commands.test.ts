import { describe, it, expect } from "vitest";
import {
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
