/**
 * Tests the model menu's content: Recent, the thread's account with its older
 * models folded, the other accounts, the filter, and the picks each row makes,
 * on a thread that has started and on a Draft Thread.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  readThreadConfig,
  type ComposerPick,
  type RecentModel,
  type ThreadCatalogs,
  type ThreadConfig,
  type ThreadKind,
} from "@hercule/client-core";
import type { ProviderInstance } from "@hercule/contract";
import { FIXTURE_INSTANCE, SIDEBAR_FIXTURE, THREAD_FIXTURES } from "../../app/testing";
import { ModelMenu } from "./model-menu";

/** The fixture instance's one snapshot, from moss. */
const SNAPSHOT = FIXTURE_INSTANCE.snapshots[0]!;

/** A second Claude Code account on moss, which only a Draft Thread can switch to. */
const WORK_INSTANCE: ProviderInstance = {
  ...FIXTURE_INSTANCE,
  id: "01a06d02-7600-7000-8000-000000000002",
  name: "work",
  snapshots: [
    {
      ...SNAPSHOT,
      auth: { status: "ok", identity: "work@example.com", planLabel: "Claude Pro" },
      models: [{ slug: "claude-haiku-5", name: "Claude Haiku 5", isDefault: true, options: [] }],
    },
  ],
};

/** The fixture instance with five more models, so the accounts hold more than eight. */
const MANY_INSTANCE: ProviderInstance = {
  ...FIXTURE_INSTANCE,
  snapshots: [
    {
      ...SNAPSHOT,
      models: [
        ...SNAPSHOT.models,
        ...["4.1", "4.2", "4.3", "4.4", "4.5"].map((version) => ({
          slug: `claude-haiku-${version}`,
          name: `Claude Haiku ${version}`,
          options: [],
        })),
      ],
    },
  ],
};

/** The idle fixture thread's config: Claude Sonnet 5, on the fixture instance. */
const CONFIG = readThreadConfig({ kind: "active", session: THREAD_FIXTURES.finished.session });

/** Returns the catalogs with `instances` on moss. */
const buildCatalogs = (instances: readonly ProviderInstance[]): ThreadCatalogs => ({
  instances,
  runners: SIDEBAR_FIXTURE.runners,
  localRunnerId: null,
});

/** Renders the menu and returns the function that received each pick. */
const renderMenu = ({
  instances = [FIXTURE_INSTANCE, WORK_INSTANCE],
  config = CONFIG,
  kind = "active",
  recent = [],
}: {
  readonly instances?: readonly ProviderInstance[];
  readonly config?: ThreadConfig;
  readonly kind?: ThreadKind;
  readonly recent?: readonly RecentModel[];
} = {}) => {
  const onPick = vi.fn<(picks: readonly ComposerPick[]) => void>();
  render(
    <ModelMenu
      catalogs={buildCatalogs(instances)}
      config={config}
      kind={kind}
      recent={recent}
      onPick={onPick}
    />,
  );
  return onPick;
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
        { instanceId: WORK_INSTANCE.id, model: "claude-haiku-5" },
        { instanceId: FIXTURE_INSTANCE.id, model: "claude-opus-5" },
      ],
    });

    expect(readSections()).toEqual([
      ["Recent", "Claude Haiku 5 · workaccount fixed", "Claude Opus 5 · personal"],
      ["personal", "Claude Sonnet 5", "Claude Opus 5", "older models (1)"],
      ["work · work@example.com · Claude Proaccount fixed"],
    ]);
    expect(readPickable()).toEqual([
      "Claude Opus 5 · personal",
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

  it("shows the older models on request, and hands each row's model pick to onPick", async () => {
    const user = userEvent.setup();
    const onPick = renderMenu({
      recent: [{ instanceId: FIXTURE_INSTANCE.id, model: "claude-opus-5" }],
    });

    await user.click(screen.getByRole("button", { name: "older models (1)" }));
    expect(readSections()[1]).toEqual([
      "personal",
      "Claude Sonnet 5",
      "Claude Opus 5",
      "Claude Sonnet 4",
    ]);
    await user.click(screen.getByRole("button", { name: "Claude Opus 5 · personal" }));
    await user.click(screen.getByRole("button", { name: "Claude Sonnet 4" }));

    expect(onPick.mock.calls).toEqual([
      [[{ kind: "model", value: "claude-opus-5" }]],
      [[{ kind: "model", value: "claude-sonnet-4" }]],
    ]);
  });

  it("offers a filter once the accounts hold more than eight models, focused, which narrows every section", async () => {
    const user = userEvent.setup();
    renderMenu({ instances: [MANY_INSTANCE, WORK_INSTANCE] });

    const filter = screen.getByRole("textbox", { name: "Filter models" });
    expect(document.activeElement).toBe(filter);
    await user.type(filter, "haiku 4.2");

    expect(readSections().slice(1)).toEqual([["personal", "Claude Haiku 4.2"]]);
  });

  it("lets a Draft Thread switch to another account, which picks the account alone", async () => {
    const user = userEvent.setup();
    const onPick = renderMenu({ kind: "draft" });

    expect(readSections()[1]).toEqual(["work · work@example.com · Claude Pro1 model"]);
    await user.click(
      screen.getByRole("button", { name: "work · work@example.com · Claude Pro1 model" }),
    );

    expect(onPick.mock.calls).toEqual([[[{ kind: "instanceId", value: WORK_INSTANCE.id }]]]);
  });

  it("lists another account's matching models on a Draft Thread, each picking the account and the model", async () => {
    const user = userEvent.setup();
    const onPick = renderMenu({ kind: "draft", instances: [MANY_INSTANCE, WORK_INSTANCE] });

    await user.type(screen.getByRole("textbox", { name: "Filter models" }), "haiku 5");
    expect(readSections().slice(1)).toEqual([["work", "Claude Haiku 5 · default"]]);
    await user.click(screen.getByRole("button", { name: "Claude Haiku 5 · default" }));

    expect(onPick.mock.calls).toEqual([
      [
        [
          { kind: "instanceId", value: WORK_INSTANCE.id },
          { kind: "model", value: "claude-haiku-5" },
        ],
      ],
    ]);
  });
});
