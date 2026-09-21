import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import LeftNav from "../LeftNav";
import TopBar from "../TopBar";
import { NAV_ITEMS } from "@/lib/navItems";
import { useAppStore } from "@/store/appStore";
import { resetWorkspaceDrafts } from "@/store/workspaceDrafts";

const responsiveness = vi.hoisted(() => ({
  expects: vi.fn<(_candidate: { targetRole: string; accessibleName: string; eventType: string }) => boolean>(() => false),
  claim: vi.fn<(_candidate: { targetRole: string; accessibleName: string; eventType: string; trusted: boolean; priorValue: string }) => number | null>(() => null),
  start: vi.fn(),
  end: vi.fn(),
  visible: vi.fn(),
  topBarValue: vi.fn(),
}));

vi.mock("@/performance/responsivenessRuntime", () => ({
  expectsResponsivenessAction: responsiveness.expects,
  claimResponsivenessAction: responsiveness.claim,
  recordResponsivenessHandlerStart: responsiveness.start,
  recordResponsivenessHandlerEnd: responsiveness.end,
  acknowledgeResponsivenessVisible: responsiveness.visible,
  acknowledgeResponsivenessTopBarValue: responsiveness.topBarValue,
}));

beforeEach(() => {
  vi.clearAllMocks();
  responsiveness.expects.mockReturnValue(false);
  responsiveness.claim.mockReturnValue(null);
  resetWorkspaceDrafts();
  useAppStore.setState({ pendingFocusUrlInput: 0 });
});
afterEach(cleanup);

describe("workspace navigation", () => {
  it("presents primary and Tools destinations without changing established shortcuts", () => {
    render(<MemoryRouter initialEntries={["/metadata"]}><LeftNav /></MemoryRouter>);
    const nav = screen.getByRole("navigation", { name: "Primary navigation" });
    expect(within(nav).getAllByRole("link").map(link => link.textContent?.replace(/(?:⌘|Ctrl\+)\d/g, ""))).toEqual([
      "Extract", "Convert", "Compress", "Image", "Metadata", "Recognize", "History", "Settings",
    ]);
    expect(within(nav).getByRole("group", { name: "Tools" })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Metadata/ }).getAttribute("aria-current")).toBe("page");
    expect(NAV_ITEMS.map(({to, shortcut}) => [to, shortcut])).toEqual([
      ["/extract", "1"], ["/convert", "2"], ["/image", "3"], ["/recognize", "4"],
      ["/metadata", "5"], ["/compress", "6"], ["/history", "7"], ["/settings", "8"],
    ]);
  });
  it("acknowledges measured navigation after the destination route commits", async () => {
    responsiveness.expects.mockReturnValue(true);
    responsiveness.claim.mockReturnValue(21);
    render(<MemoryRouter initialEntries={["/extract"]}><LeftNav /></MemoryRouter>);

    fireEvent.click(screen.getByRole("link", { name: /Convert/ }));

    expect(responsiveness.claim).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "click",
      targetRole: "link",
      accessibleName: "Convert",
      priorValue: "/extract",
    }));
    expect(responsiveness.start).toHaveBeenCalledExactlyOnceWith(21);
    expect(responsiveness.end).toHaveBeenCalledExactlyOnceWith(21);
    await vi.waitFor(() => expect(responsiveness.visible).toHaveBeenCalledExactlyOnceWith(21));
  });
  it("labels the current tool and retains URL typing across header remount", () => {
    const submit = vi.fn();
    const first = render(<MemoryRouter initialEntries={["/compress"]}><TopBar onSubmit={submit} /></MemoryRouter>);
    expect(screen.getByText("Compress")).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "  https://example.com/video  " } });
    first.unmount();
    render(<MemoryRouter initialEntries={["/convert"]}><TopBar onSubmit={submit} /></MemoryRouter>);
    const input = screen.getByRole("textbox") as HTMLInputElement;
    expect(input.value).toBe("  https://example.com/video  ");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(submit).toHaveBeenCalledExactlyOnceWith("https://example.com/video");
    expect(input.value).toBe("");
  });
  it("keeps the URL focus-and-select shortcut token working", () => {
    render(<MemoryRouter><TopBar onSubmit={vi.fn()} /></MemoryRouter>);
    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.change(input, {target: {value: "https://example.com"}});
    act(() => useAppStore.setState({pendingFocusUrlInput: 1}));
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);
  });

  it("records the trusted URL handler before acknowledging the committed value", () => {
    const order: string[] = [];
    responsiveness.expects.mockReturnValue(true);
    responsiveness.claim.mockImplementation(() => { order.push("claim"); return 7; });
    responsiveness.start.mockImplementation(() => { order.push("start"); });
    responsiveness.end.mockImplementation(() => { order.push("end"); });
    responsiveness.visible.mockImplementation(() => { order.push("visible"); });
    render(<MemoryRouter><TopBar onSubmit={vi.fn()} /></MemoryRouter>);

    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "h" } });

    expect(input.value).toBe("h");
    expect(order).toEqual(["claim", "start", "end", "visible"]);
    expect(responsiveness.claim).toHaveBeenCalledWith(expect.objectContaining({
      eventType: "input",
      targetRole: "textbox",
      accessibleName: "Paste URL to download",
      priorValue: "",
    }));
    expect(responsiveness.visible).toHaveBeenCalledExactlyOnceWith(7);
  });

  it("waits for Command-A selection and Delete value commit before visibility acknowledgement", () => {
    const order: string[] = [];
    render(<MemoryRouter><TopBar onSubmit={vi.fn()} /></MemoryRouter>);
    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "abc" } });

    responsiveness.expects.mockReturnValue(true);
    responsiveness.claim.mockImplementationOnce(() => { order.push("claim-select"); return 8; });
    responsiveness.start.mockImplementation((id) => { order.push(`start:${id}`); });
    responsiveness.end.mockImplementation((id) => { order.push(`end:${id}`); });
    responsiveness.visible.mockImplementation((id) => { order.push(`visible:${id}`); });
    fireEvent.keyDown(input, { key: "a", metaKey: true });
    expect(order).toEqual(["claim-select", "start:8", "end:8"]);
    input.setSelectionRange(0, input.value.length);
    fireEvent.select(input);
    expect(order).toEqual(["claim-select", "start:8", "end:8", "visible:8"]);

    responsiveness.claim.mockImplementationOnce(() => { order.push("claim-delete"); return 9; });
    fireEvent.keyDown(input, { key: "Delete" });
    expect(order.slice(-3)).toEqual(["claim-delete", "start:9", "end:9"]);
    fireEvent.change(input, { target: { value: "" } });
    expect(order.slice(-4)).toEqual(["claim-delete", "start:9", "end:9", "visible:9"]);
    expect(responsiveness.claim).toHaveBeenCalledTimes(2);
  });

});
