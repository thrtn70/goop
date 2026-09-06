import { render, screen, cleanup } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import FileRow from "../FileRow";
import CompressFileRow from "@/features/compress/CompressFileRow";
import type { FileRowOptions } from "../FileRow";
const state = {
  phase: "ready",
  probe: {
    source_kind: "image",
    image_format: "jpeg",
    duration_ms: 0,
    file_size: 100,
    width: 2,
    height: 2,
  },
  capabilities: {
    targets: ["jpeg", "png", "webp"].map((target) => ({
      target,
      available: true,
      reason: null,
      metadata_warning: null,
    })),
    compression: {
      quality: true,
      target_size: true,
      lossless: false,
      reason: null,
    },
  },
} as unknown as Extract<
  import("@/hooks/useProbe").ProbeState,
  { phase: "ready" }
>;
afterEach(cleanup);
it("external options remain authoritative after a preset changes target", () => {
  const options: FileRowOptions = {
    target: "png",
    gifOptions: null,
    metadataPolicy: "preserve",
    subtitle: null,
  };
  const props = {
    state,
    path: "/in.jpg",
    onOptionsChange: vi.fn(),
    onRemove: vi.fn(),
  };
  const { rerender } = render(<FileRow {...props} options={options} />);
  expect(screen.getByRole("button", { name: "PNG" }).className).toContain(
    "bg-accent",
  );
  rerender(<FileRow {...props} options={{ ...options, target: "webp" }} />);
  expect(screen.getByRole("button", { name: "WebP" }).className).toContain(
    "bg-accent",
  );
});
it("external compression presets update displayed quality", () => {
  const props = {
    state,
    path: "/in.jpg",
    onOptionsChange: vi.fn(),
    onRemove: vi.fn(),
  };
  const { rerender } = render(
    <CompressFileRow
      {...props}
      selectedMode={{ kind: "quality", value: 30 }}
    />,
  );
  expect((screen.getByRole("slider") as HTMLInputElement).value).toBe("30");
  rerender(
    <CompressFileRow
      {...props}
      selectedMode={{ kind: "quality", value: 90 }}
    />,
  );
  expect((screen.getByRole("slider") as HTMLInputElement).value).toBe("90");
});

it("keeps every compatible engine output visible and explains unavailability", async () => {
  const { default: TargetPicker, smartDefault } = await import(
    "../TargetPicker"
  );
  const probe = {
    source_kind: "image",
    image_format: "RAW",
  } as import("@/types").ProbeResult;
  const capabilities: import("@/types").ConversionCapabilities = {
    targets: [
      {
        target: "jpeg",
        available: false,
        reason: "Requires macOS",
        preserves_metadata: false,
        metadata_warning: "SDR sRGB",
      },
      {
        target: "avif",
        available: true,
        reason: null,
        preserves_metadata: false,
        metadata_warning: null,
      },
    ],
    compression: {
      quality: false,
      target_size: false,
      lossless: false,
      reason: null,
    },
  };
  render(
    <TargetPicker
      probe={probe}
      selected="jpeg"
      onChange={vi.fn()}
      capabilities={capabilities}
    />,
  );
  expect(
    (
      screen.getByRole("button", {
        name: "JPEG, unavailable: Requires macOS",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(screen.getByRole("button", { name: "AVIF" })).toBeTruthy();
  expect(smartDefault(probe)).toBe("jpeg");
});

it("keeps the selected recommendation visible and exposes target selection", async () => {
  const { default: TargetPicker } = await import("../TargetPicker");
  const probe = {
    source_kind: "image",
    image_format: "RAW",
  } as import("@/types").ProbeResult;
  const props = { probe, capabilities: state.capabilities, onChange: vi.fn() };
  const view = render(<TargetPicker {...props} selected="jpeg" />);
  const recommended = screen.getByRole("button", { name: "JPEG" });
  expect(recommended.textContent).toContain("*");
  expect(recommended.getAttribute("aria-pressed")).toBe("true");
  view.rerender(<TargetPicker {...props} selected="png" />);
  expect(
    screen.getByRole("button", { name: "JPEG" }).getAttribute("aria-pressed"),
  ).toBe("false");
  expect(
    screen.getByRole("button", { name: "PNG" }).getAttribute("aria-pressed"),
  ).toBe("true");
});
it("omits the recommendation legend when that output is unavailable", async () => {
  const { default: TargetPicker } = await import("../TargetPicker");
  const probe = {
    source_kind: "image",
    image_format: "RAW",
  } as import("@/types").ProbeResult;
  const capabilities = {
    ...state.capabilities,
    targets: state.capabilities.targets.map((target) => ({
      ...target,
      available: target.target !== "jpeg",
    })),
  };
  render(
    <TargetPicker
      probe={probe}
      capabilities={capabilities}
      selected="jpeg"
      onChange={vi.fn()}
    />,
  );
  expect(screen.queryByText(/recommended for this file/)).toBeNull();
});

it("does not coerce unsupported subtitle intent to another mode", async () => {
  const { subtitleForTarget } = await import("../FileRow");
  expect(subtitleForTarget({source_path:"/captions.srt",mode:"soft"},"avi")).toBeNull();
});
it("keeps subtitle removal available for an incompatible output", () => {
  render(<FileRow path="/in.jpg" state={state} options={{target:"png",gifOptions:null,metadataPolicy:"preserve",subtitle:{source_path:"/captions.srt",mode:"soft"}}} onOptionsChange={vi.fn()} />);
  expect(screen.getByRole("button", {name:/remove subtitle/i})).toBeTruthy();
});
