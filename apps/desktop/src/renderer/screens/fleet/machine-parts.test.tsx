/**
 * Tests the buttons of a machine's need line, which the card and the list row
 * both draw. What a need says is decided by `@hercule/client-core/fleet`.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { summarizeMachine } from "@hercule/client-core/fleet";
import { BUSY_MACHINE, FULL_DISK_MACHINE, NOW, TIMEZONE } from "./fleet.testing";
import { NeedLine } from "./machine-parts";

const renderNeedLine = (machine: typeof BUSY_MACHINE, allowPending = false) => {
  const onAllow = vi.fn();
  render(
    <NeedLine
      runnerId={machine.runner.id}
      need={summarizeMachine(machine, TIMEZONE, NOW).need}
      allowPending={allowPending}
      onAllow={onAllow}
    />,
  );
  return onAllow;
};

describe("NeedLine", () => {
  it("calls onAllow with the machine and the cap that lets every waiting session start", async () => {
    const user = userEvent.setup();
    const onAllow = renderNeedLine(BUSY_MACHINE);

    await user.click(screen.getByRole("button", { name: "Allow 17" }));

    expect(onAllow).toHaveBeenCalledExactlyOnceWith("runner-busy", 17);
  });

  it("shows that Allow is saving and ignores presses meanwhile", async () => {
    const user = userEvent.setup();
    const onAllow = renderNeedLine(BUSY_MACHINE, true);

    const saving = screen.getByRole("button", { name: "Saving…" });
    expect(saving.getAttribute("aria-disabled")).toBe("true");
    await user.click(saving);

    expect(onAllow).not.toHaveBeenCalled();
  });

  it("draws Clean up inert while a disk is below its limit, because the cleanup is not built yet", async () => {
    const user = userEvent.setup();
    const onAllow = renderNeedLine(FULL_DISK_MACHINE);

    const cleanUp = screen.getByRole("button", { name: "Clean up…" });
    expect(cleanUp.getAttribute("aria-disabled")).toBe("true");
    expect(cleanUp.getAttribute("title")).toBe("Not built yet");
    await user.click(cleanUp);

    expect(onAllow).not.toHaveBeenCalled();
  });
});
