/**
 * Tests the access-mode menu: it lists the modes with their meaning, checks
 * the current one, and hands a picked mode to `onPick`.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AccessModeMenuItem } from "@hercule/client-core";
import type { AccessMode } from "@hercule/contract";
import { readMenuLines } from "../thread/testing";
import { AccessModeMenu } from "./access-mode-menu";

describe("the access-mode menu", () => {
  const ROWS: readonly AccessModeMenuItem[] = [
    {
      mode: "approval-required",
      label: "Approval required",
      meaning: "asks for every side-effecting action",
      dimmed: null,
    },
    {
      mode: "auto",
      label: "Auto",
      meaning: "lets a harness-side reviewer judge routine actions",
      dimmed: "runs as Approval required on Claude Code",
    },
  ];

  it("lists the modes with their meaning, checks the current one, and keeps a mode the provider lacks pickable", async () => {
    const onPick = vi.fn<(mode: AccessMode) => void>();
    render(<AccessModeMenu value="approval-required" rows={ROWS} onPick={onPick} />);

    expect(readMenuLines()).toEqual([
      ["Approval required" + "asks for every side-effecting action", true],
      [
        "Auto" +
          "lets a harness-side reviewer judge routine actions" +
          "runs as Approval required on Claude Code",
        false,
      ],
    ]);
    await userEvent.click(screen.getByRole("button", { name: /harness-side reviewer/ }));

    expect(onPick.mock.calls).toEqual([["auto"]]);
  });
});
