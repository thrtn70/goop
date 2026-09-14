import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import ImageAlphaPolicyControl from "../ImageAlphaPolicyControl";
import type { ImageAlphaCapabilities } from "@/types";

afterEach(cleanup);

const available: ImageAlphaCapabilities = {
  source_has_alpha: true,
  flatten: { available: true, reason: null, summary: "Flatten transparency in linear sRGB." },
  required_color_policy: "assume_srgb" as const,
  suggested_background: { red: 255, green: 255, blue: 255 },
};

it("shows White as a suggestion without selecting it", () => {
  const change = vi.fn();
  render(<ImageAlphaPolicyControl value={null} capabilities={available} onChange={change} />);
  expect(screen.getByText(/JPEG removes transparency/i)).toBeTruthy();
  expect(screen.getByText(/suggested/i).textContent).toContain("#FFFFFF");
  expect(screen.getByRole("button", { name: "White" }).getAttribute("aria-pressed")).toBe("false");
  expect(change).not.toHaveBeenCalled();
});

it("commits White, Black and a valid custom sRGB color deliberately", () => {
  const change = vi.fn();
  const { rerender } = render(<ImageAlphaPolicyControl value={null} capabilities={available} onChange={change} />);
  fireEvent.click(screen.getByRole("button", { name: "White" }));
  expect(change).toHaveBeenLastCalledWith({kind:"flatten",background:{red:255,green:255,blue:255}});
  fireEvent.click(screen.getByRole("button", { name: "Black" }));
  expect(change).toHaveBeenLastCalledWith({kind:"flatten",background:{red:0,green:0,blue:0}});

  rerender(<ImageAlphaPolicyControl value={null} capabilities={available} onChange={change} />);
  const custom = screen.getByRole("textbox", { name: /custom background/i });
  fireEvent.change(custom, { target: { value: "#112233" } });
  fireEvent.keyDown(custom, { key: "Enter" });
  expect(change).toHaveBeenLastCalledWith({kind:"flatten",background:{red:17,green:34,blue:51}});
});

it("visually distinguishes the committed quick background", () => {
  render(<ImageAlphaPolicyControl
    value={{ kind: "flatten", background: { red: 255, green: 255, blue: 255 } }}
    capabilities={available}
    onChange={vi.fn()}
  />);
  const white = screen.getByRole("button", { name: "White" });
  const black = screen.getByRole("button", { name: "Black" });
  expect(white.getAttribute("aria-pressed")).toBe("true");
  expect(white.className).toContain("bg-accent");
  expect(white.className).toContain("text-accent-fg");
  expect(black.className).toContain("bg-surface-2");
});

it("keeps invalid custom text editable without committing it", () => {
  const change = vi.fn();
  render(<ImageAlphaPolicyControl value={null} capabilities={available} onChange={change} />);
  const custom = screen.getByRole("textbox", { name: /custom background/i });
  fireEvent.change(custom, { target: { value: "#12zz34" } });
  fireEvent.keyDown(custom, { key: "Enter" });
  expect(screen.getByRole("alert").textContent).toMatch(/six hexadecimal/i);
  expect(change).not.toHaveBeenCalled();
});

it("keeps an uncommitted custom draft across equal-value parent snapshots", () => {
  const change = vi.fn();
  const policy = {kind:"flatten" as const,background:{red:255,green:255,blue:255}};
  const { rerender } = render(<ImageAlphaPolicyControl value={policy} capabilities={available} onChange={change} />);
  const custom = screen.getByRole("textbox", { name: /custom background/i });
  fireEvent.change(custom, { target: { value: "#112233" } });
  rerender(<ImageAlphaPolicyControl value={{kind:"flatten",background:{red:255,green:255,blue:255}}} capabilities={available} onChange={change} />);
  expect((custom as HTMLInputElement).value).toBe("#112233");
  expect(change).not.toHaveBeenCalled();
});

it("describes saved opaque and inactive intent without claiming flattening or inventing a suggestion", () => {
  const policy = {kind:"flatten" as const,background:{red:17,green:34,blue:51}};
  const first = render(<ImageAlphaPolicyControl
    value={policy}
    capabilities={{...available,source_has_alpha:false}}
    onChange={vi.fn()}
  />);
  expect(screen.getByRole("status").textContent).toMatch(/Background #112233 saved.*no transparency found/i);
  expect(screen.getByRole("status").textContent).not.toContain("Transparency over");

  first.unmount();
  render(<ImageAlphaPolicyControl value={policy} capabilities={null} target="png" onChange={vi.fn()} />);
  expect(screen.getByRole("status").textContent).toMatch(/Background #112233 saved.*inactive/i);
  expect(screen.queryByText(/Suggested:/)).toBeNull();
});

it("surfaces the engine refusal and disables all choices", () => {
  render(<ImageAlphaPolicyControl
    value={null}
    capabilities={{...available,flatten:{available:false,reason:"Transparent WebP is not supported yet.",summary:"Unavailable."}}}
    onChange={vi.fn()}
  />);
  expect(screen.getByText("Transparent WebP is not supported yet.")).toBeTruthy();
  expect((screen.getByRole("button", { name: "White" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("textbox", { name: /custom background/i }) as HTMLInputElement).disabled).toBe(true);
});
