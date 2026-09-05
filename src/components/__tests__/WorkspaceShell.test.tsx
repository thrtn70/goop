import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import LeftNav from "../LeftNav";
import TopBar from "../TopBar";
import { NAV_ITEMS } from "@/lib/navItems";
import { useAppStore } from "@/store/appStore";
import { resetWorkspaceDrafts } from "@/store/workspaceDrafts";

beforeEach(() => { resetWorkspaceDrafts(); useAppStore.setState({ pendingFocusUrlInput: 0 }); });
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

});
