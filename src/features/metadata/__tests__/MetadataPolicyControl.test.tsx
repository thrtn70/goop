import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ImageMetadataCapabilities } from "@/types";
import MetadataPolicyControl, { metadataPolicyProblem } from "../MetadataPolicyControl";

afterEach(cleanup);

const capabilities: ImageMetadataCapabilities = {
  preserve: { available: true, reason: null, summary: "Metadata retained." },
  rgb_reencode_preserve: {
    available: false,
    reason: "RGB re-encoding requires an RGB ICC profile.",
    summary: "Unavailable",
  },
  remove_personal: {
    available: false,
    reason: "Remove personal data is currently available only for JPEG to JPEG processing.",
    summary: "Unavailable",
  },
  strip_all: { available: true, reason: null, summary: "All metadata removed." },
  source_has_exif: true,
  source_has_icc: true,
  orientation: "valid",
};

describe("MetadataPolicyControl", () => {
  it("keeps legacy preserve and remove-all choices usable when capabilities are absent", () => {
    expect(metadataPolicyProblem("preserve", undefined)).toBeNull();
    expect(metadataPolicyProblem("strip_all", undefined)).toBeNull();
    expect(metadataPolicyProblem("remove_personal", undefined)).toContain("inspection is required");
  });

  it("keeps remove-personal visible but disabled with the engine reason", () => {
    render(
      <MetadataPolicyControl
        value="preserve"
        capabilities={capabilities}
        onChange={vi.fn()}
      />,
    );
    const removePersonal = screen.getByRole("button", { name: "Remove personal data" });
    expect(removePersonal.getAttribute("aria-disabled")).toBe("true");
    const descriptionId = removePersonal.getAttribute("aria-describedby");
    expect(descriptionId).toBeTruthy();
    expect(document.getElementById(descriptionId!)?.textContent).toContain(capabilities.remove_personal.reason);
    expect(removePersonal.getAttribute("title")).toBe(capabilities.remove_personal.reason);
    expect(screen.getByText("Metadata retained.")).toBeTruthy();
  });

  it("warns that remove-all discards the color profile", () => {
    const onChange = vi.fn();
    render(
      <MetadataPolicyControl
        value="strip_all"
        capabilities={capabilities}
        onChange={onChange}
      />,
    );
    expect(screen.getByText(/output color may differ/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Preserve" }));
    expect(onChange).toHaveBeenCalledWith("preserve");
  });

  it("disables Preserve only for RGB re-encoding and ignores disabled clicks", () => {
    const onChange = vi.fn();
    render(
      <MetadataPolicyControl
        value="strip_all"
        capabilities={capabilities}
        preserveMode="rgb_reencode"
        onChange={onChange}
      />,
    );
    const preserve = screen.getByRole("button", { name: "Preserve" });
    expect(preserve.getAttribute("aria-disabled")).toBe("true");
    expect(metadataPolicyProblem("preserve", capabilities)).toBeNull();
    expect(metadataPolicyProblem("preserve", capabilities, "rgb_reencode")).toContain("RGB ICC");
    fireEvent.click(preserve);
    expect(onChange).not.toHaveBeenCalled();
  });
});
