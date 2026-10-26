import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import BatchInspectorStatus from "../BatchInspectorStatus";

afterEach(cleanup);

it("does not take focus on a later render when a restore claimed success but changed nothing", () => {
  const view = render(<>
    <BatchInspectorStatus name="b.jpg" state="edited" label="a.jpg" onRestore={() => true} />
    <input aria-label="Elsewhere" />
  </>);
  fireEvent.click(screen.getByRole("button", { name: "Use batch settings" }));
  const elsewhere = screen.getByRole("textbox", { name: "Elsewhere" });
  elsewhere.focus();
  view.rerender(<>
    <BatchInspectorStatus name="c.jpg" state="edited" label="a.jpg" onRestore={() => true} />
    <input aria-label="Elsewhere" />
  </>);
  expect(document.activeElement).toBe(elsewhere);
});
