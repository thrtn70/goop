import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import WorkspaceFrame from "../workspace/WorkspaceFrame";
import WorkspaceList from "../workspace/WorkspaceList";
import WorkspaceInspector from "../workspace/WorkspaceInspector";
afterEach(cleanup);
it("keeps list, settings and output actions as labelled usable regions", () => {
  render(<WorkspaceFrame title="Convert" toolbar={<button>Add files</button>}
    inspector={<WorkspaceInspector title="File settings" actions={<button>Convert file</button>}><input aria-label="Quality" /></WorkspaceInspector>}
    outputSummary={<span>Save beside originals</span>}>
    <WorkspaceList label="Source files"><button>Photo.jpg</button></WorkspaceList>
  </WorkspaceFrame>);
  expect(screen.getByRole("region", {name: "Convert"})).toBeTruthy();
  expect(screen.getByRole("region", {name: "Source files"})).toBeTruthy();
  expect(screen.getByRole("complementary", {name: "File settings"})).toBeTruthy();
  expect(screen.getByRole("textbox", {name: "Quality"})).toBeTruthy();
  expect(screen.getByRole("button", {name: "Convert file"})).toBeTruthy();
  expect(screen.queryByRole("main")).toBeNull();
});
it("pins media above the scrolling settings, outside them, and only when media is given", () => {
  const { container, rerender } = render(<WorkspaceInspector title="File settings" media={<p>Player</p>}>
    <input aria-label="Quality" />
  </WorkspaceInspector>);
  const media = container.querySelector(".workspace-inspector-media");
  const scroll = container.querySelector(".workspace-inspector-scroll");
  expect(media).not.toBeNull();
  expect(scroll).not.toBeNull();
  expect(media?.textContent).toBe("Player");
  expect(media!.compareDocumentPosition(scroll!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(scroll!.contains(media)).toBe(false);

  rerender(<WorkspaceInspector title="File settings"><input aria-label="Quality" /></WorkspaceInspector>);
  expect(container.querySelector(".workspace-inspector-media")).toBeNull();
  expect(screen.getByRole("textbox", {name: "Quality"})).toBeTruthy();
});
