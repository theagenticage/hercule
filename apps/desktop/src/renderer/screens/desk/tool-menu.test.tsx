/**
 * Tests that the rows of a tool menu say what they are to assistive
 * technology: a value to switch on is a checkbox, a choice from a group is a
 * radio, and each tells whether it is on.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { JSX } from "react";
import { usePopoverMenu } from "../use-popover-menu";
import { MenuPick, ToolMenu } from "./tool-menu";

/** A menu with a choice that is on and a value that is off, each calling `onPick`. */
function TestMenu({ onPick }: { readonly onPick: (name: string) => void }): JSX.Element {
  const { menuProps, buildItemProps } = usePopoverMenu();
  return (
    <ToolMenu menuProps={menuProps} label="Filter" edge="start">
      <MenuPick
        itemProps={buildItemProps("project", { checked: true })}
        kind="choice"
        name="Project"
        isOn
        onPick={() => {
          onPick("Project");
        }}
      />
      <MenuPick
        itemProps={buildItemProps("failed", { checked: false })}
        kind="toggle"
        name="Failed"
        isOn={false}
        count={3}
        onPick={() => {
          onPick("Failed");
        }}
      />
    </ToolMenu>
  );
}

describe("MenuPick", () => {
  it("is a radio for a choice and a checkbox for a value, each saying whether it is on", () => {
    render(<TestMenu onPick={vi.fn()} />, { container: document.body });

    const choice = screen.getByRole("menuitemradio", { name: "Project", hidden: true });
    expect(choice.getAttribute("aria-checked")).toBe("true");
    const value = screen.getByRole("menuitemcheckbox", { name: /Failed/, hidden: true });
    expect(value.getAttribute("aria-checked")).toBe("false");
  });

  it("calls onPick with the row that was pressed", async () => {
    const onPick = vi.fn();
    render(<TestMenu onPick={onPick} />);

    await userEvent.click(screen.getByRole("menuitemcheckbox", { name: /Failed/, hidden: true }));

    expect(onPick).toHaveBeenCalledExactlyOnceWith("Failed");
  });
});
