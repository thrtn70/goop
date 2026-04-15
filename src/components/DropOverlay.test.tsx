import { render } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import DropOverlay from "./DropOverlay";

describe("DropOverlay", () => {
  it("shows label only when dragging", () => {
    const { queryByText, rerender } = render(<DropOverlay active={false} />);
    expect(queryByText(/drop files/i)).toBeNull();
    rerender(<DropOverlay active={true} />);
    expect(queryByText(/drop files/i)).not.toBeNull();
  });
});
