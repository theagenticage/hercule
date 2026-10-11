/**
 * Tests the keyboard of the dialog that asks before something changes: Enter
 * in a field presses the action, and Enter on Cancel presses Cancel.
 */
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConfirmDialog } from "./confirm-dialog";

/** Renders an open dialog with one radio in its body, and returns its callbacks. */
const renderDialogWithRadio = () => {
  const onConfirm = vi.fn<() => void>();
  const onClose = vi.fn<() => void>();
  render(
    <ConfirmDialog
      dialogRef={createRef<HTMLDialogElement>()}
      title="Re-run with the same inputs?"
      actionLabel="Re-run"
      actionClass="accent"
      onConfirm={onConfirm}
      onClose={onClose}
    >
      <label>
        <input type="radio" name="mode" />
        As it ran
      </label>
    </ConfirmDialog>,
  );
  return { onConfirm, onClose };
};

describe("the confirm dialog", () => {
  it("presses the action on Enter in a field, as a macOS dialog presses its default button", async () => {
    const { onConfirm, onClose } = renderDialogWithRadio();

    await userEvent.click(screen.getByRole("radio", { name: "As it ran" }));
    await userEvent.keyboard("{Enter}");

    expect(onConfirm).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("presses Cancel on Enter on Cancel, and closes without confirming", async () => {
    const { onConfirm, onClose } = renderDialogWithRadio();

    screen.getByRole("button", { name: "Cancel" }).focus();
    await userEvent.keyboard("{Enter}");

    expect(onConfirm).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
  });
});
