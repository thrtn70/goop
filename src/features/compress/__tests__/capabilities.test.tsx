import { render, screen, cleanup } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import CompressControls from "../CompressControls";
import type { ProbeResult } from "@/types";
afterEach(cleanup);
it("WebP offers only lossless reoptimization", () => {
 const probe = { source_kind: "image", image_format:"webp",file_size:1000,duration_ms:0 } as unknown as ProbeResult;
 render(<CompressControls capabilities={{quality:false,target_size:false,lossless:true,reason:"WebP supports lossless reoptimization only."}} probe={probe} mode={{kind:"quality",value:75}} onChange={vi.fn()} />);
 expect((screen.getByRole("button",{name:"Target size"}) as HTMLButtonElement).disabled).toBe(true);
 expect(screen.queryByRole("slider")).toBeNull();
 expect(screen.getByRole("button",{name:"Re-optimize losslessly"})).toBeTruthy();
});
