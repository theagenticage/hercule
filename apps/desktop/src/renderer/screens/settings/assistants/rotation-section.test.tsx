/**
 * Tests the Rotation section: each select saves its limit, and the daily
 * time saves when it is a time and reverts with an error when it is not.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Rotation } from "@hercule/contract";
import { RotationSection } from "./rotation-section";

const ROTATION: Rotation = { contextFraction: 0.7, maxContextTokens: 200_000, dailyAt: "04:00" };

const renderSection = () => {
  const onSave = vi.fn<(change: Partial<Rotation>) => void>();
  render(<RotationSection assistantName="Ada" rotation={ROTATION} error={null} onSave={onSave} />);
  return onSave;
};

describe("the Rotation section", () => {
  it("saves the share of the context and the context size", async () => {
    const onSave = renderSection();
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Share of the context" }),
      "80%",
    );
    expect(onSave).toHaveBeenLastCalledWith({ contextFraction: 0.8 });
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Context size in tokens" }),
      "1M",
    );
    expect(onSave).toHaveBeenLastCalledWith({ maxContextTokens: 1_000_000 });
  });

  it("saves a new daily time on Enter", async () => {
    const onSave = renderSection();
    const field = screen.getByRole("textbox", { name: "Daily at" });
    await userEvent.clear(field);
    await userEvent.type(field, "05:30{Enter}");
    expect(onSave).toHaveBeenCalledWith({ dailyAt: "05:30" });
  });

  it("puts the saved daily time back on Esc", async () => {
    const onSave = renderSection();
    const field = screen.getByRole("textbox", { name: "Daily at" });
    await userEvent.clear(field);
    await userEvent.type(field, "05:30{Escape}");
    expect(field).toHaveProperty("value", "04:00");
    await userEvent.tab();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("says the rotation is saved but not run yet", () => {
    renderSection();
    expect(screen.getByText(/does not rotate contexts/)).toBeTruthy();
  });

  it("reverts a daily time that is not a time, with an error", async () => {
    const onSave = renderSection();
    const field = screen.getByRole("textbox", { name: "Daily at" });
    await userEvent.clear(field);
    await userEvent.type(field, "25:00");
    await userEvent.tab();
    expect(onSave).not.toHaveBeenCalled();
    expect(field).toHaveProperty("value", "04:00");
    expect(screen.getByRole("alert").textContent).toMatch(/"25:00" is not a time/);
  });
});
