/**
 * Tests the step parts where their markup decides what the user sees: a row
 * without steps draws no empty space under it, a field shows its error in
 * place of its hint, and Copy says whether the copy happened.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DeviceCodeSteps, FormField, MarkedRow } from ".";

describe("MarkedRow", () => {
  it("draws the steps under the head only when it is given some", () => {
    const { container, rerender } = render(
      <MarkedRow
        mark="C"
        name="Claude Code"
        detail="/opt/homebrew/bin/claude"
        detailMono
        end={null}
      >
        {null}
      </MarkedRow>,
    );
    expect(container.querySelector(".hx-more")).toBeNull();
    expect(screen.getByText("/opt/homebrew/bin/claude").className).toBe("mono");

    rerender(
      <MarkedRow mark="C" name="Claude Code" detail="not installed" end={null}>
        <p>Step one</p>
      </MarkedRow>,
    );
    expect(container.querySelector(".hx-more")?.textContent).toBe("Step one");
    expect(screen.getByText("not installed").className).toBe("");
  });
});

describe("FormField", () => {
  it("shows the hint, and the error in its place once there is one", () => {
    const { container, rerender } = render(
      <FormField label="Remote URL" hint="Where runners clone from.">
        <input />
      </FormField>,
    );
    expect(screen.getByText("Where runners clone from.")).toBeTruthy();
    expect(container.querySelector(".field")?.className).toBe("field");

    rerender(
      <FormField label="Remote URL" hint="Where runners clone from." error="Not a remote.">
        <input />
      </FormField>,
    );
    expect(screen.queryByText("Where runners clone from.")).toBeNull();
    expect(screen.getByRole("alert").textContent).toBe("Not a remote.");
    expect(screen.getByText("Not a remote.").className).toBe("fl-err");
    expect(container.querySelector(".field")?.className).toBe("field is-bad");
    // The input is named by its label alone, not by the error under it.
    expect(screen.getByLabelText("Remote URL")).toBe(container.querySelector("input"));
  });

  it("keeps the input's label when the aside holds a button", () => {
    // A label belongs to the first control inside it, so a button in the
    // label would take the label from the input.
    const { container } = render(
      <FormField label="Personal access token" aside={<button type="button">Create one</button>}>
        <input />
      </FormField>,
    );
    expect(screen.getByRole("textbox", { name: "Personal access token" })).toBe(
      container.querySelector("input"),
    );
    expect(screen.getByRole("button", { name: "Create one" })).toBeTruthy();
  });
});

describe("DeviceCodeSteps", () => {
  // jsdom has no clipboard and no copy command, so each test gives the
  // document a stand-in for the command. What the real one copies is what is
  // selected when it runs.
  const execCommand = vi.fn<(command: string) => boolean>();
  beforeEach(() => {
    execCommand.mockReset();
    document.execCommand = execCommand;
  });
  afterEach(() => {
    Reflect.deleteProperty(document, "execCommand");
  });

  /** Renders the steps for the code `K7QF-2MXD`, with `onOpen` as the open button's callback. */
  const renderSteps = (onOpen = vi.fn()) =>
    render(
      <DeviceCodeSteps
        code="K7QF-2MXD"
        openText="Open the sign-in page and enter it."
        openLabel="Open sign-in page"
        onOpen={onOpen}
      />,
    );

  it("copies the code it draws, and says so", async () => {
    let selected = "";
    execCommand.mockImplementation(() => {
      selected = window.getSelection()?.toString() ?? "";
      return true;
    });
    renderSteps();
    await userEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(selected).toBe("K7QF-2MXD");
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
    // The selection made for the copy does not stay on the screen.
    expect(window.getSelection()?.toString()).toBe("");
  });

  it("says when the copy did not happen", async () => {
    execCommand.mockReturnValue(false);
    renderSteps();
    await userEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(screen.getByRole("button", { name: "Copy failed" })).toBeTruthy();
  });

  it("opens the sign-in page from its button", async () => {
    const onOpen = vi.fn();
    renderSteps(onOpen);
    await userEvent.click(screen.getByRole("button", { name: "Open sign-in page" }));
    expect(onOpen).toHaveBeenCalledOnce();
  });
});
