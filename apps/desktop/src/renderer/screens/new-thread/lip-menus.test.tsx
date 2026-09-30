/**
 * Tests the content of a Draft Thread's lip menus: the workspace, branch and
 * machine menus. Each draws its rows, checks the current one, draws a row
 * that cannot be picked as text rather than a button, and hands a picked
 * row's value to `onPick`.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { BranchField, MachineRow, WorkspaceMenu, WorkspacePick } from "@hercule/client-core";
import { BranchMenuContent, MachineMenuContent, WorkspaceMenuContent } from "./lip-menus";

/** Returns each row's text and whether it is marked current, in order. */
const readRows = (): readonly (readonly [string, boolean])[] =>
  [...document.querySelectorAll(".line")].map((row) => [
    row.textContent,
    row.getAttribute("aria-current") === "true",
  ]);

describe("the workspace menu", () => {
  const NEW_WORKSPACE: WorkspacePick = {
    kind: "ephemeral",
    checkouts: [{ resourceId: "webshop-repo" }],
  };
  const MENU: WorkspaceMenu = {
    label: "Main workspace",
    rows: [
      {
        key: "primary",
        pick: { kind: "primary", resourceId: "webshop-repo" },
        name: "Main workspace",
        mono: false,
        note: "moss",
        sub: "shared with you",
        current: true,
      },
      {
        key: "ephemeral",
        pick: NEW_WORKSPACE,
        name: "New workspace",
        mono: false,
        note: null,
        sub: "its own branch",
        current: false,
      },
    ],
  };

  it("lists the workspaces with their machine, and checks the current one", () => {
    render(<WorkspaceMenuContent menu={MENU} onPick={vi.fn()} />);

    expect(document.querySelector(".pop-h")?.textContent).toBe(
      "Workspace" + "locks when the thread starts",
    );
    expect(readRows()).toEqual([
      ["Main workspace" + "shared with you" + "moss", true],
      ["New workspace" + "its own branch", false],
    ]);
  });

  it("picks the row that is clicked", async () => {
    const onPick = vi.fn<(pick: WorkspacePick) => void>();
    render(<WorkspaceMenuContent menu={MENU} onPick={onPick} />);

    await userEvent.click(screen.getByRole("button", { name: /New workspace/ }));

    expect(onPick.mock.calls).toEqual([[NEW_WORKSPACE]]);
  });
});

describe("the branch menu", () => {
  const FIELD: BranchField = {
    header: "Branch",
    note: "the checkout switches to it",
    label: "main",
    value: "main",
    glyph: true,
    locked: null,
    rows: [
      { branch: "main", badge: "current", dimmed: null },
      { branch: "fix/cart", badge: null, dimmed: null },
      { branch: "feat/coupons", badge: null, dimmed: "in workspace hercule/thread-3f1" },
    ],
    foot: [{ text: "Uncommitted changes in " }, { text: "main", mono: true }, { text: " stay." }],
  };

  it("lists the branches, checks the current one, and draws a branch checked out elsewhere as text", () => {
    render(<BranchMenuContent field={FIELD} onPick={vi.fn()} />);

    expect(document.querySelector(".pop-h")?.textContent).toBe(
      "Branch" + "the checkout switches to it",
    );
    expect(readRows()).toEqual([
      ["main" + "current", true],
      ["fix/cart", false],
      ["feat/coupons" + "in workspace hercule/thread-3f1", false],
    ]);
    expect(screen.queryByRole("button", { name: /feat\/coupons/ })).toBeNull();
    expect(document.querySelector(".pop-foot")?.textContent).toBe(
      "Uncommitted changes in main stay.",
    );
  });

  it("picks the branch that is clicked", async () => {
    const onPick = vi.fn<(branch: string) => void>();
    render(<BranchMenuContent field={FIELD} onPick={onPick} />);

    await userEvent.click(screen.getByRole("button", { name: "fix/cart" }));

    expect(onPick.mock.calls).toEqual([["fix/cart"]]);
  });
});

describe("the machine menu", () => {
  const ROWS: readonly MachineRow[] = [
    {
      runnerId: "moss",
      name: "moss",
      state: "online",
      isLocal: true,
      reserved: false,
      identity: null,
      planLabel: null,
      dimmed: null,
      current: true,
      isDefault: true,
      capacity: "1/4",
      notCloned: null,
    },
    {
      runnerId: "fern",
      name: "fern",
      state: "online",
      isLocal: false,
      reserved: false,
      identity: null,
      planLabel: null,
      dimmed: null,
      current: false,
      isDefault: false,
      capacity: "0/4",
      notCloned: "webshop is not cloned there · clones on first use",
    },
    {
      runnerId: "birch",
      name: "birch",
      state: "offline",
      isLocal: false,
      reserved: false,
      identity: null,
      planLabel: null,
      dimmed: "offline",
      current: false,
      isDefault: false,
      capacity: "0/4",
      notCloned: null,
    },
  ];

  it("lists the machines with what kind they are, their state and their load, and draws an offline one as text", () => {
    render(<MachineMenuContent rows={ROWS} onPick={vi.fn()} />);

    expect(readRows()).toEqual([
      ["moss" + "this machine · default" + "online 1/4", true],
      ["fern" + "webshop is not cloned there · clones on first use" + "online 0/4", false],
      ["birch" + "offline" + "offline 0/4", false],
    ]);
    expect(screen.queryByRole("button", { name: /birch/ })).toBeNull();
    expect(document.querySelector(".pop-foot")?.textContent).toBe(
      "The thread runs where you say; nothing moves it later.",
    );
  });

  it("picks the machine that is clicked, even one that still has to clone the repo", async () => {
    const onPick = vi.fn<(runnerId: string) => void>();
    render(<MachineMenuContent rows={ROWS} onPick={onPick} />);

    await userEvent.click(screen.getByRole("button", { name: /fern/ }));

    expect(onPick.mock.calls).toEqual([["fern"]]);
  });
});
