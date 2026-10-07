/**
 * Tests the Disallowed tools row: a chip per family with an × that removes
 * it, and Add, which offers only the families not chosen yet.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DisallowedTool } from "@hercule/contract";
import { DisallowedToolsRow } from "./disallowed-tools-row";

const renderRow = (tools: readonly DisallowedTool[], unenforced = false) => {
  const onChange = vi.fn<(family: DisallowedTool, disallowed: boolean) => void>();
  render(
    <DisallowedToolsRow
      assistantName="Ada"
      tools={tools}
      unenforced={unenforced}
      error={null}
      onChange={onChange}
    />,
  );
  return onChange;
};

describe("the Disallowed tools row", () => {
  it("removes a family with its ×", async () => {
    const onChange = renderRow(["edit", "shell"]);
    await userEvent.click(screen.getByRole("button", { name: "Remove edit" }));
    expect(onChange).toHaveBeenCalledWith("edit", false);
  });

  it("offers only the families not chosen yet, and adds the one picked", async () => {
    const onChange = renderRow(["edit", "shell"]);
    const add = screen.getByRole("combobox", { name: "Add a disallowed tool" });
    const offered = within(add)
      .getAllByRole("option", { hidden: true })
      .filter((option) => !(option as HTMLOptionElement).disabled)
      .map((option) => option.textContent);
    expect(offered).toEqual(["write", "web-search", "web-fetch"]);
    await userEvent.selectOptions(add, "web-fetch");
    expect(onChange).toHaveBeenCalledWith("web-fetch", true);
  });

  it("hides Add once every family is chosen", () => {
    renderRow(["edit", "write", "shell", "web-search", "web-fetch"]);
    expect(screen.queryByRole("combobox", { name: "Add a disallowed tool" })).toBeNull();
  });

  it("names the assistant in the hint, with a typographic apostrophe", () => {
    renderRow([]);
    expect(screen.getByText("Tools Ada’s sessions may never use.")).toBeTruthy();
  });

  it("says so when the provider does not enforce the list", () => {
    renderRow(["edit"], true);
    expect(screen.getByText(/does not enforce this list/)).toBeTruthy();
  });
});
