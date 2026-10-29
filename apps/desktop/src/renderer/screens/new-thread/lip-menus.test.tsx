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
import type { StartingRevision } from "@hercule/contract";
import { readMenuLines } from "../thread/testing";
import {
  BranchMenuContent,
  MachineMenuContent,
  WorkspaceMenuContent,
  type BranchMenuSearch,
} from "./lip-menus";

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
    expect(readMenuLines()).toEqual([
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
    header: "Starting revision",
    note: "the new workspace starts from it",
    label: "local branch fix/cart",
    value: "local:fix/cart",
    glyph: false,
    locked: null,
    rows: [
      {
        key: "current",
        label: "Current working copy",
        startingRevision: { kind: "current" },
        badge: "current",
        dimmed: null,
      },
      {
        key: "remote:",
        label: "Remote default",
        startingRevision: { kind: "remote" },
        badge: "default",
        dimmed: "Unavailable on this machine",
      },
    ],
    search: { resourceId: "webshop-repo", runnerId: "moss" },
    foot: [{ text: "Uncommitted changes in " }, { text: "main", mono: true }, { text: " stay." }],
  };
  const SEARCH: BranchMenuSearch = {
    text: "fix",
    listed: {
      rows: [
        {
          key: "local:fix/cart",
          label: "Local branch: fix/cart",
          startingRevision: { kind: "local", branch: "fix/cart" },
          badge: null,
          dimmed: null,
        },
      ],
      note: "More branches match. Type to narrow the list.",
    },
    onText: () => undefined,
  };

  it("lists the fixed choices, then the filter and the branches it found, and checks the current one", () => {
    render(<BranchMenuContent field={FIELD} search={SEARCH} onPick={vi.fn()} />);

    expect(document.querySelector(".pop-h")?.textContent).toBe(
      "Starting revision" + "the new workspace starts from it",
    );
    expect(readMenuLines()).toEqual([
      ["Current working copy" + "current", false],
      ["Remote default" + "default · Unavailable on this machine", false],
      ["Local branch: fix/cart", true],
    ]);
    expect(screen.queryByRole("button", { name: /Remote default/ })).toBeNull();
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Filter branches" }).value).toBe(
      "fix",
    );
    expect(document.querySelector(".branch-list-note")?.textContent).toBe(
      "More branches match. Type to narrow the list.",
    );
    expect(document.querySelector(".pop-foot")?.textContent).toBe(
      "Uncommitted changes in main stay.",
    );
  });

  it("draws no filter when the menu lists no branches", () => {
    render(<BranchMenuContent field={{ ...FIELD, search: null }} search={null} onPick={vi.fn()} />);

    expect(screen.queryByRole("textbox")).toBeNull();
    expect(readMenuLines()).toHaveLength(2);
  });

  it("hands typed text to onText and the clicked branch to onPick", async () => {
    const onPick = vi.fn<(revision: StartingRevision) => void>();
    const onText = vi.fn<(text: string) => void>();
    render(
      <BranchMenuContent field={FIELD} search={{ ...SEARCH, text: "", onText }} onPick={onPick} />,
    );

    await userEvent.type(screen.getByRole("textbox", { name: "Filter branches" }), "c");
    await userEvent.click(screen.getByRole("button", { name: "Local branch: fix/cart" }));

    expect(onText.mock.calls).toEqual([["c"]]);
    expect(onPick.mock.calls).toEqual([[{ kind: "local", branch: "fix/cart" }]]);
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

    expect(readMenuLines()).toEqual([
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
