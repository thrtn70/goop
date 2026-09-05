import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import ConvertActionBar from "../ConvertActionBar";
import CompressActionBar from "@/features/compress/CompressActionBar";
const mocks = vi.hoisted(() => ({ save: vi.fn(), enqueue: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: mocks.save,
  open: vi.fn(),
}));
vi.mock("@/ipc/commands", () => ({
  api: { convert: { fromFile: mocks.enqueue } },
}));
vi.mock("@/features/presets/PresetSaveDialog", () => ({ default: () => null }));
afterEach(cleanup);
const file = {
  path: "/a.mp4",
  sourceDir: "/",
  target: "mp4" as const,
  gifOptions: null,
  metadataPolicy: "preserve" as const,
  subtitle: null,
  qualityPreset: null,
  resolutionCap: null,
};
for (const tool of ["convert", "compress"] as const) {
  it(`${tool} retains the pending dialog latch across remount and sends its original snapshot`, async () => {
    let resolve!: (path: string) => void;
    mocks.save.mockReset().mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    mocks.enqueue.mockReset().mockResolvedValue("job");
    const done = vi.fn();
    const view = () =>
      tool === "convert" ? (
        <ConvertActionBar files={[file]} disabled={false} onEnqueued={done} />
      ) : (
        <CompressActionBar
          files={[{ ...file, mode: { kind: "quality", value: 75 } }]}
          disabled={false}
          onEnqueued={done}
        />
      );
    const first = render(view());
    fireEvent.click(
      screen.getByRole("button", { name: /^(Convert|Compress) 1 file$/ }),
    );
    first.unmount();
    render(view());
    const button = screen.getByRole("button", {
      name: /Enqueuing|Choosing/,
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(mocks.save).toHaveBeenCalledTimes(1);
    await act(async () => resolve("/out.mp4"));
    await waitFor(() => expect(done).toHaveBeenCalledTimes(1));
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
    expect(mocks.enqueue.mock.calls[0][0].input_path).toBe("/a.mp4");
  });
}
