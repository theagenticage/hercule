/**
 * Tests the model menu's content: Recent, the thread's account with its older
 * models folded, the other accounts, the filter, and the choice each row makes,
 * on a thread that has started and on a Draft Thread.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  readThreadConfig,
  type RecentModel,
  type ThreadCatalogs,
  type ThreadChoice,
  type ThreadConfig,
  type ThreadKind,
} from "@hercule/client-core";
import type { ProviderAccount } from "@hercule/contract";
import { HARNESSES, PROVIDERS } from "@hercule/client-core/testing";
import { FIXTURE_ACCOUNT, SIDEBAR_FIXTURE, THREAD_FIXTURES } from "../../app/testing";
import { ModelMenu } from "./model-menu";

/** The fixture account's one snapshot, from moss. */
const SNAPSHOT = FIXTURE_ACCOUNT.snapshots[0]!;

/** A second Claude Code account on moss, which only a Draft Thread can switch to. */
const WORK_ACCOUNT: ProviderAccount = {
  ...FIXTURE_ACCOUNT,
  id: "01a06d02-7600-7000-8000-000000000002",
  label: "work",
  identity: "work@example.com",
  planLabel: "Claude Pro",
  snapshots: [
    {
      ...SNAPSHOT,
      auth: { status: "ok", identity: "work@example.com", planLabel: "Claude Pro" },
      models: [
        {
          slug: "claude-haiku-5",
          name: "Claude Haiku 5",
          imageInput: { maxBytes: null },
          isDefault: true,
          options: [],
        },
      ],
    },
  ],
};

/** The fixture account with five more models, so the accounts hold more than eight. */
const MANY_ACCOUNT: ProviderAccount = {
  ...FIXTURE_ACCOUNT,
  snapshots: [
    {
      ...SNAPSHOT,
      models: [
        ...SNAPSHOT.models,
        ...["4.1", "4.2", "4.3", "4.4", "4.5"].map((version) => ({
          slug: `claude-haiku-${version}`,
          name: `Claude Haiku ${version}`,
          imageInput: { maxBytes: null },
          options: [],
        })),
      ],
    },
  ],
};

/** The idle fixture thread's config: Claude Sonnet 5, on the fixture account. */
const CONFIG = readThreadConfig({ kind: "active", session: THREAD_FIXTURES.finished.session });

/** Returns the catalogs with `accounts` on moss. */
const buildCatalogs = (accounts: readonly ProviderAccount[]): ThreadCatalogs => ({
  accounts,
  providers: PROVIDERS,
  harnesses: HARNESSES,
  runners: SIDEBAR_FIXTURE.runners,
  thisMacRunnerId: null,
});

/** Renders the menu and returns the function that received each choice. */
const renderMenu = ({
  accounts = [FIXTURE_ACCOUNT, WORK_ACCOUNT],
  config = CONFIG,
  kind = "active",
  recent = [],
}: {
  readonly accounts?: readonly ProviderAccount[];
  readonly config?: ThreadConfig;
  readonly kind?: ThreadKind;
  readonly recent?: readonly RecentModel[];
} = {}) => {
  const onChoose = vi.fn<(choice: ThreadChoice) => void>();
  render(
    <ModelMenu
      catalogs={buildCatalogs(accounts)}
      config={config}
      kind={kind}
      readRecent={() => recent}
      onChoose={onChoose}
    />,
  );
  return onChoose;
};

/** Returns the text of each row of each section, in order. A section's label is its first row. */
const readSections = (): readonly (readonly string[])[] =>
  [...document.querySelectorAll(".pop-sec")].map((section) =>
    [...section.children].map((row) => row.textContent),
  );

/** Returns the text of each row that can be picked, in order. */
const readPickable = (): readonly string[] =>
  screen.getAllByRole("button").map((button) => button.textContent);

describe("the model menu", () => {
  it("lists Recent, the thread's account, then the other accounts, dimmed because the account is fixed", () => {
    renderMenu({
      recent: [
        { providerAccountId: WORK_ACCOUNT.id, model: "claude-haiku-5" },
        { providerAccountId: FIXTURE_ACCOUNT.id, model: "claude-opus-5" },
      ],
    });

    expect(readSections()).toEqual([
      ["Recent", "Claude Haiku 5 · Anthropic · workaccount fixed", "Claude Opus 5 · Anthropic"],
      ["Anthropic", "Claude Sonnet 5", "Claude Opus 5", "older models (1)"],
      ["Anthropic · work · work@example.com · Claude Proaccount fixed"],
    ]);
    expect(readPickable()).toEqual([
      "Claude Opus 5 · Anthropic",
      "Claude Sonnet 5",
      "Claude Opus 5",
      "older models (1)",
    ]);
    // Four models are too few to need a filter.
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("checks the model in use, and marks the default model when it is another", () => {
    renderMenu({ config: { ...CONFIG, model: "claude-opus-5" } });

    const current = screen.getByRole("button", { current: true });
    expect(current.textContent).toBe("Claude Opus 5");
    expect(current.querySelector("svg:last-child")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Claude Sonnet 5 · default" })).toBeTruthy();
  });

  it("shows the older models on request, and hands each row's model choice to onChoose", async () => {
    const user = userEvent.setup();
    const onChoose = renderMenu({
      recent: [{ providerAccountId: FIXTURE_ACCOUNT.id, model: "claude-opus-5" }],
    });

    await user.click(screen.getByRole("button", { name: "older models (1)" }));
    expect(readSections()[1]).toEqual([
      "Anthropic",
      "Claude Sonnet 5",
      "Claude Opus 5",
      "Claude Sonnet 4",
    ]);
    await user.click(screen.getByRole("button", { name: "Claude Opus 5 · Anthropic" }));
    await user.click(screen.getByRole("button", { name: "Claude Sonnet 4" }));

    expect(onChoose.mock.calls).toEqual([
      [{ kind: "model", providerAccountId: FIXTURE_ACCOUNT.id, model: "claude-opus-5" }],
      [{ kind: "model", providerAccountId: FIXTURE_ACCOUNT.id, model: "claude-sonnet-4" }],
    ]);
  });

  it("offers a filter once the accounts hold more than eight models, focused, which narrows every section", async () => {
    const user = userEvent.setup();
    renderMenu({ accounts: [MANY_ACCOUNT, WORK_ACCOUNT] });

    const filter = screen.getByRole("textbox", { name: "Filter models" });
    expect(document.activeElement).toBe(filter);
    await user.type(filter, "haiku 4.2");

    expect(readSections().slice(1)).toEqual([["Anthropic", "Claude Haiku 4.2"]]);
  });

  it("lets a Draft Thread switch to another account, which chooses the account alone", async () => {
    const user = userEvent.setup();
    const onChoose = renderMenu({ kind: "draft" });

    expect(readSections()[1]).toEqual(["Anthropic · work · work@example.com · Claude Pro1 model"]);
    await user.click(
      screen.getByRole("button", { name: "Anthropic · work · work@example.com · Claude Pro1 model" }),
    );

    expect(onChoose.mock.calls).toEqual([[{ kind: "account", providerAccountId: WORK_ACCOUNT.id }]]);
  });

  it("lists another account's matching models on a Draft Thread, each choosing the account and the model together", async () => {
    const user = userEvent.setup();
    const onChoose = renderMenu({ kind: "draft", accounts: [MANY_ACCOUNT, WORK_ACCOUNT] });

    await user.type(screen.getByRole("textbox", { name: "Filter models" }), "haiku 5");
    expect(readSections().slice(1)).toEqual([["Anthropic · work", "Claude Haiku 5 · default"]]);
    await user.click(screen.getByRole("button", { name: "Claude Haiku 5 · default" }));

    expect(onChoose.mock.calls).toEqual([
      [{ kind: "model", providerAccountId: WORK_ACCOUNT.id, model: "claude-haiku-5" }],
    ]);
  });
});
