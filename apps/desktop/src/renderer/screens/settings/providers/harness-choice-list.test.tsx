/**
 * Tests `HarnessChoiceList`: a harness the account cannot run in is struck
 * through with its reason, only a usable harness can be picked, and an error
 * replaces the hint.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HarnessChoiceList, type HarnessChoice } from "./harness-choice-list";

const CHOICES: ReadonlyArray<HarnessChoice> = [
  {
    harnessId: "claude-code/claude-code",
    name: "Claude Code",
    mark: null,
    unavailableReason: null,
  },
  { harnessId: "pi/pi", name: "pi", mark: null, unavailableReason: null },
  {
    harnessId: "codex/codex",
    name: "Codex",
    mark: null,
    unavailableReason: "Anthropic allows a Claude subscription only in Claude Code and pi",
  },
];

const draw = (error: string | null = null, onPick = vi.fn()) => {
  render(
    <HarnessChoiceList
      choices={CHOICES}
      selectedId="claude-code/claude-code"
      onPick={onPick}
      error={error}
    />,
  );
  return onPick;
};

describe("HarnessChoiceList", () => {
  it("turns on the selected harness", () => {
    draw();

    expect(screen.getByRole<HTMLInputElement>("radio", { name: "Claude Code" }).checked).toBe(true);
    expect(screen.getByRole<HTMLInputElement>("radio", { name: "pi" }).checked).toBe(false);
  });

  it("calls onPick with the harness the user picks", async () => {
    const onPick = draw();

    await userEvent.click(screen.getByRole("radio", { name: "pi" }));

    expect(onPick).toHaveBeenCalledExactlyOnceWith("pi/pi");
  });

  it("strikes through a harness the account cannot run in, with its reason under it, and does not let it be picked", async () => {
    const onPick = draw();

    const codex = screen.getByRole<HTMLInputElement>("radio", { name: "Codex" });
    const reason = screen.getByText(
      "Anthropic allows a Claude subscription only in Claude Code and pi",
    );
    await userEvent.click(codex);

    expect(codex.disabled).toBe(true);
    expect(codex.closest("label")!.className).toContain("is-off");
    expect(codex.getAttribute("aria-describedby")).toBe(reason.id);
    expect(reason.previousElementSibling!.textContent).toBe("Codex");
    expect(onPick).not.toHaveBeenCalled();
  });

  it("shows the hint, and the error in its place", () => {
    const { unmount } = render(
      <HarnessChoiceList choices={CHOICES} selectedId="pi/pi" onPick={vi.fn()} error={null} />,
    );
    expect(screen.getByText(/Every profile runs this account/)).toBeTruthy();
    unmount();

    draw("Could not save: pi is on no machine");

    expect(screen.getByRole("alert").textContent).toBe("Could not save: pi is on no machine");
    expect(screen.queryByText(/Every profile runs this account/)).toBeNull();
  });
});
