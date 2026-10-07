/**
 * Tests the stacked text row: when its text saves, how Esc puts the stored
 * text back, and its error.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SettingTextRow } from "./setting-text-row";

const renderRow = (error: string | null = null) => {
  const onCommit = vi.fn<(text: string) => void>();
  render(
    <SettingTextRow
      label="Persona"
      hint="Instructions added to every session."
      value="Be brief."
      error={error}
      onCommit={onCommit}
    />,
  );
  return { onCommit, area: screen.getByRole("textbox", { name: "Persona" }) };
};

describe("SettingTextRow", () => {
  it("saves the text when it loses focus, only when it changed", async () => {
    const { onCommit, area } = renderRow();
    await userEvent.click(area);
    await userEvent.tab();
    expect(onCommit).not.toHaveBeenCalled();
    await userEvent.type(area, " Be kind.");
    await userEvent.tab();
    expect(onCommit).toHaveBeenCalledExactlyOnceWith("Be brief. Be kind.");
  });

  it("starts a new line on Enter, and saves once on Cmd+Enter", async () => {
    const { onCommit, area } = renderRow();
    await userEvent.type(area, "{Enter}Be kind.");
    expect(onCommit).not.toHaveBeenCalled();
    await userEvent.keyboard("{Meta>}{Enter}{/Meta}");
    expect(onCommit).toHaveBeenCalledExactlyOnceWith("Be brief.\nBe kind.");
    expect(document.activeElement).not.toBe(area);
  });

  it("puts the stored text back on Esc", async () => {
    const { onCommit, area } = renderRow();
    await userEvent.type(area, " Be kind.{Escape}");
    expect(area).toHaveProperty("value", "Be brief.");
    await userEvent.tab();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("shows the error under the row", () => {
    renderRow("Could not save: The database is locked.");
    expect(screen.getByRole("alert").textContent).toBe("Could not save: The database is locked.");
  });
});
