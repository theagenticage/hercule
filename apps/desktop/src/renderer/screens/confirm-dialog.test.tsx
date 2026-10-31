/**
 * Tests the keyboard of the dialog that asks before something changes: Enter
 * in a field presses the action, Enter on Cancel presses Cancel, and the
 * button the dialog focuses when it opens.
 */
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConfirmDialog } from "./confirm-dialog";

/**
 * Renders an open dialog with one radio in its body, focusing `initialFocus`
 * when it opens, and returns its callbacks.
 */
const renderDialogWithRadio = (initialFocus?: "close" | "action") => {
  const onConfirm = vi.fn<() => void>();
  const onClose = vi.fn<() => void>();
  render(
    <ConfirmDialog
      dialogRef={createRef<HTMLDialogElement>()}
      title="Re-run with the same inputs?"
      actionLabel="Re-run"
      actionClass="accent"
      initialFocus={initialFocus}
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

  it("focuses the button `initialFocus` names when it opens", () => {
    renderDialogWithRadio("action");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Re-run" }));
  });

  it("names the closing button with `closeLabel` and focuses it for `close`", () => {
    render(
      <ConfirmDialog
        dialogRef={createRef<HTMLDialogElement>()}
        title="Cancel this run?"
        actionLabel="Cancel run"
        actionClass="danger"
        closeLabel="Keep running"
        initialFocus="close"
        onConfirm={() => {}}
        onClose={() => {}}
      >
        <label>
          <input type="checkbox" defaultChecked />
          Delete workspace
        </label>
      </ConfirmDialog>,
    );
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Keep running" }));
  });

  it("offers only the closing button, with the reason, after a refusal", async () => {
    const onConfirm = vi.fn<() => void>();
    const onClose = vi.fn<() => void>();
    render(
      <ConfirmDialog
        dialogRef={createRef<HTMLDialogElement>()}
        title="Delete Anthropic?"
        actionLabel="Delete"
        actionClass="danger"
        refusal="Anthropic is still used by the assistant Ada."
        onConfirm={onConfirm}
        onClose={onClose}
      >
        <input aria-label="Name" />
      </ConfirmDialog>,
    );

    expect(screen.getByRole("alert").textContent).toBe(
      "Anthropic is still used by the assistant Ada.",
    );
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    // Enter in a field has no action to press.
    await userEvent.click(screen.getByRole("textbox", { name: "Name" }));
    await userEvent.keyboard("{Enter}");
    expect(onConfirm).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
