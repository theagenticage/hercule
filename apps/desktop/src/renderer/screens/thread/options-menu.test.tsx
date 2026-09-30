/**
 * Tests the model options menu's content: the header, one row of choices per
 * option with the one in use pressed, and the value each choice picks.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ModelOption } from "@hercule/contract";
import { EFFORT_OPTION } from "../../app/testing";
import { OptionsMenu } from "./options-menu";

/** An off/on option, whose pick the provider expects as a boolean. */
const FAST_MODE: ModelOption = {
  id: "fastMode",
  label: "Fast mode",
  kind: "boolean",
  default: false,
};

/** Renders the menu and returns the function that received each pick. */
const renderMenu = (modelName: string | null = "Claude Sonnet 5") => {
  const onPick = vi.fn<(id: string, value: string | boolean) => void>();
  render(
    <OptionsMenu
      descriptors={[EFFORT_OPTION, FAST_MODE]}
      selected={{ effort: "high" }}
      modelName={modelName}
      onPick={onPick}
    />,
  );
  return onPick;
};

/** Returns each choice of the option labelled `label`, and whether it is pressed. */
const readChoices = (label: string): readonly (readonly [string, string | null])[] =>
  within(screen.getByRole("group", { name: label }))
    .getAllByRole("button")
    .map((button) => [button.textContent, button.getAttribute("aria-pressed")]);

describe("the model options menu", () => {
  it("names the model, and presses the value in use of each option, or else its default", () => {
    renderMenu();

    expect(document.querySelector(".pop-h")?.textContent).toBe("Model optionsClaude Sonnet 5");
    expect(readChoices("Reasoning effort")).toEqual([
      ["Low", "false"],
      ["Medium", "false"],
      ["High", "true"],
    ]);
    expect(readChoices("Fast mode")).toEqual([
      ["off", "true"],
      ["on", "false"],
    ]);
  });

  it("leaves the model's name out when there is none", () => {
    renderMenu(null);

    expect(document.querySelector(".pop-h")?.textContent).toBe("Model options");
  });

  it("hands onPick a choice's value, and a boolean for an off/on option", async () => {
    const user = userEvent.setup();
    const onPick = renderMenu();

    await user.click(screen.getByRole("button", { name: "Low" }));
    await user.click(screen.getByRole("button", { name: "on" }));
    await user.click(screen.getByRole("button", { name: "off" }));

    expect(onPick.mock.calls).toEqual([
      ["effort", "low"],
      ["fastMode", true],
      ["fastMode", false],
    ]);
  });
});
