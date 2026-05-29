// File types the Recognize feature accepts: PDFs plus the raster image
// formats tesseract reads. Shared between RecognizePage (input filter)
// and RecognizeChip (which hides itself for inputs the page would reject,
// avoiding a dead-end where a chip routes to a file the page discards).
//
// Note this is intentionally narrower than the Image Workshop's accepted
// set — GIF/AVIF/JXL are editable images but not OCR inputs here.
export const RECOGNIZE_EXTENSIONS = [
  "pdf",
  "png",
  "jpg",
  "jpeg",
  "webp",
  "bmp",
  "tiff",
  "tif",
];

export function isRecognizable(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return false;
  return RECOGNIZE_EXTENSIONS.includes(path.slice(dot + 1).toLowerCase());
}
