/**
 * `buildModelMenu(catalogs, config, { kind, filter, recent })` is the shape the
 * rebuilt model selector renders: a filter box only past eight models, a
 * Recent lane, the current account's lane with its legacy models folded
 * away, and one row per other instance.
 */
import { describe, expect, it } from "vitest";
import type { ProviderInstance, Runner } from "@hercule/contract";
import { BARE, buildInstance, buildSnapshot } from "../providers.testing";
import type { ThreadConfig } from "./config";
import { buildModelMenu } from "./model-menu";

const buildRunner = (overrides: Partial<Runner> & { id: string }): Runner => ({
  ...BARE,
  ...overrides,
});

const LOCAL = buildRunner({ id: "r-local", name: "moss" });

const SONNET = { slug: "claude-sonnet-5", name: "Claude Sonnet 5", isDefault: true, options: [] };
const OPUS = { slug: "claude-opus-5", name: "Claude Opus 5", options: [] };
const LEGACY = { slug: "claude-sonnet-3", name: "Claude Sonnet 3", isLegacy: true, options: [] };
const GPT = { slug: "gpt-5", name: "GPT-5", options: [] };

const withModels = (
  base: ProviderInstance,
  id: string,
  name: string,
  models: ProviderInstance["snapshots"][number]["models"],
): ProviderInstance => ({
  ...base,
  id,
  name,
  snapshots: [buildSnapshot({ runnerId: LOCAL.id, models })],
});

/** The only instance of its provider; its own name differs from the provider's. */
const CLAUDE: ProviderInstance = {
  ...buildInstance("claude-code", "Claude Code", [
    buildSnapshot({ runnerId: LOCAL.id, models: [SONNET, OPUS, LEGACY] }),
  ]),
  name: "default",
};

const WORK = withModels(CLAUDE, "instance-claude-work", "work", [SONNET, OPUS, LEGACY]);
const PERSONAL = withModels(CLAUDE, "instance-claude-personal", "personal", [OPUS]);

const CODEX = buildInstance("codex", "Codex", [
  buildSnapshot({
    runnerId: LOCAL.id,
    auth: { status: "ok", identity: "rogier@example.com", planLabel: "Pro" },
    models: [GPT],
  }),
]);

const CODEX_OUT = buildInstance("codex", "Codex", [
  buildSnapshot({ runnerId: LOCAL.id, auth: { status: "unauthenticated" }, models: [] }),
]);

/** Found on no machine at all: no snapshot for any runner. */
const PI = buildInstance("pi", "pi", []);

const buildCatalogs = (instances: readonly ProviderInstance[]) => ({
  instances,
  runners: [LOCAL],
  localRunnerId: LOCAL.id,
});

/** The thread's config, of which this menu reads the account and the model. */
const buildConfig = (instanceId: string, model: string): ThreadConfig => ({
  instanceId,
  model,
  accessMode: "approval-required",
  runnerId: LOCAL.id,
  profileId: "p-unrestricted",
  options: {},
});

const DRAFT = { kind: "draft" as const, filter: "", recent: [] };

/** `count` models on one instance, so the filter threshold can be crossed. */
const buildCountedInstance = (id: string, name: string, count: number): ProviderInstance =>
  withModels(
    CLAUDE,
    id,
    name,
    Array.from({ length: count }, (_, index) => ({
      slug: `model-${id}-${index}`,
      name: `Model ${index}`,
      options: [],
    })),
  );

describe("buildModelMenu: filterable", () => {
  it("offers no filter at eight models across every instance", () => {
    const menu = buildModelMenu(
      buildCatalogs([
        buildCountedInstance("instance-a", "a", 5),
        buildCountedInstance("instance-b", "b", 3),
      ]),
      buildConfig("instance-a", "model-instance-a-0"),
      DRAFT,
    );

    expect(menu.filterable).toBe(false);
  });

  it("offers a filter at nine models across every instance", () => {
    const menu = buildModelMenu(
      buildCatalogs([
        buildCountedInstance("instance-a", "a", 5),
        buildCountedInstance("instance-b", "b", 4),
      ]),
      buildConfig("instance-a", "model-instance-a-0"),
      DRAFT,
    );

    expect(menu.filterable).toBe(true);
  });
});

describe("buildModelMenu: filtering", () => {
  it("keeps the matching rows in every instance, case-insensitively, and omits instances with no match", () => {
    const menu = buildModelMenu(
      buildCatalogs([WORK, PERSONAL, CODEX]),
      buildConfig(WORK.id, SONNET.slug),
      {
        ...DRAFT,
        filter: "OPUS",
      },
    );

    expect(menu.current.rows.map((row) => row.slug)).toEqual([OPUS.slug]);
    expect(menu.others.map((row) => row.instanceId)).toEqual([PERSONAL.id]);
    expect(menu.others[0]!.rows.map((row) => row.slug)).toEqual([OPUS.slug]);
  });

  it("matches a model by its slug as well as by its display name", () => {
    const menu = buildModelMenu(buildCatalogs([WORK]), buildConfig(WORK.id, SONNET.slug), {
      ...DRAFT,
      filter: "sonnet-5",
    });

    expect(menu.current.rows.map((row) => row.slug)).toEqual([SONNET.slug]);
  });
});

describe("buildModelMenu: recent", () => {
  it("lists the given pairs in order, naming the account only for a provider with more than one instance", () => {
    const menu = buildModelMenu(
      buildCatalogs([WORK, PERSONAL, CODEX]),
      buildConfig(WORK.id, SONNET.slug),
      {
        ...DRAFT,
        recent: [
          { instanceId: CODEX.id, model: GPT.slug },
          { instanceId: PERSONAL.id, model: OPUS.slug },
        ],
      },
    );

    expect(menu.recent).toHaveLength(2);
    expect(menu.recent[0]).toMatchObject({
      instanceId: CODEX.id,
      model: GPT.slug,
      name: "GPT-5",
      providerId: "codex",
      account: null,
    });
    expect(menu.recent[1]).toMatchObject({
      instanceId: PERSONAL.id,
      model: OPUS.slug,
      name: "Claude Opus 5",
      providerId: "claude-code",
      account: "personal",
    });
  });

  it("holds at most three rows", () => {
    const menu = buildModelMenu(
      buildCatalogs([buildCountedInstance("instance-a", "a", 5)]),
      buildConfig("instance-a", "model-instance-a-0"),
      {
        ...DRAFT,
        recent: [0, 1, 2, 3].map((index) => ({
          instanceId: "instance-a",
          model: `model-instance-a-${index}`,
        })),
      },
    );

    expect(menu.recent).toHaveLength(3);
  });

  it("drops a pair whose instance or model is no longer in the catalog", () => {
    const menu = buildModelMenu(buildCatalogs([WORK, CODEX]), buildConfig(WORK.id, SONNET.slug), {
      ...DRAFT,
      recent: [
        { instanceId: "instance-that-went-away", model: SONNET.slug },
        { instanceId: WORK.id, model: "claude-model-that-went-away" },
        { instanceId: CODEX.id, model: GPT.slug },
      ],
    });

    expect(menu.recent.map((row) => row.model)).toEqual([GPT.slug]);
  });

  it("dims a recent row on another instance with account fixed on an active thread", () => {
    const menu = buildModelMenu(
      buildCatalogs([WORK, PERSONAL, CODEX]),
      buildConfig(WORK.id, SONNET.slug),
      {
        ...DRAFT,
        kind: "active",
        recent: [
          { instanceId: PERSONAL.id, model: OPUS.slug },
          { instanceId: WORK.id, model: OPUS.slug },
        ],
      },
    );

    expect(menu.recent[0]).toMatchObject({ instanceId: PERSONAL.id, dimmed: "account fixed" });
    expect(menu.recent[1]).toMatchObject({ instanceId: WORK.id, dimmed: null });
  });
});

describe("buildModelMenu: the current lane", () => {
  it("labels the lane with the account name when the provider has more than one instance", () => {
    const menu = buildModelMenu(
      buildCatalogs([WORK, PERSONAL]),
      buildConfig(WORK.id, SONNET.slug),
      DRAFT,
    );

    expect(menu.current.label).toBe("work");
  });

  it("labels the lane with the provider's display name when it has one instance", () => {
    const menu = buildModelMenu(
      buildCatalogs([CLAUDE, CODEX]),
      buildConfig(CLAUDE.id, SONNET.slug),
      DRAFT,
    );

    expect(menu.current.label).toBe("Claude Code");
  });

  it("marks which row is the default and which is current", () => {
    const menu = buildModelMenu(buildCatalogs([CLAUDE]), buildConfig(CLAUDE.id, OPUS.slug), DRAFT);

    expect(menu.current.rows.find((row) => row.slug === SONNET.slug)).toMatchObject({
      isDefault: true,
      current: false,
    });
    expect(menu.current.rows.find((row) => row.slug === OPUS.slug)).toMatchObject({
      isDefault: false,
      current: true,
    });
  });

  it("folds legacy models into older, out of the rows", () => {
    const menu = buildModelMenu(
      buildCatalogs([CLAUDE]),
      buildConfig(CLAUDE.id, SONNET.slug),
      DRAFT,
    );

    expect(menu.current.rows.map((row) => row.slug)).toEqual([SONNET.slug, OPUS.slug]);
    expect(menu.current.older.map((row) => row.slug)).toEqual([LEGACY.slug]);
  });

  it("unfolds the legacy models into the rows while filtering", () => {
    const menu = buildModelMenu(buildCatalogs([CLAUDE]), buildConfig(CLAUDE.id, SONNET.slug), {
      ...DRAFT,
      filter: "sonnet",
    });

    expect(menu.current.rows.map((row) => row.slug)).toEqual([SONNET.slug, LEGACY.slug]);
    expect(menu.current.older).toEqual([]);
  });
});

describe("buildModelMenu: the other instances", () => {
  it("gives one row per remaining instance with its model count and identity", () => {
    const menu = buildModelMenu(
      buildCatalogs([CLAUDE, CODEX]),
      buildConfig(CLAUDE.id, SONNET.slug),
      DRAFT,
    );

    expect(menu.others).toHaveLength(1);
    expect(menu.others[0]).toMatchObject({
      instanceId: CODEX.id,
      modelCount: 1,
      identity: "rogier@example.com",
      planLabel: "Pro",
      dimmed: null,
    });
  });

  it("dims an instance the runner has not logged in to, and carries the login it needs", () => {
    const menu = buildModelMenu(
      buildCatalogs([CLAUDE, CODEX_OUT]),
      buildConfig(CLAUDE.id, SONNET.slug),
      DRAFT,
    );

    expect(menu.others[0]).toMatchObject({
      dimmed: "not logged in",
      login: { instanceId: CODEX_OUT.id, runnerId: LOCAL.id, subject: "Codex on moss" },
    });
  });

  it("dims an instance the runner has no snapshot for, naming the machine", () => {
    const menu = buildModelMenu(
      buildCatalogs([CLAUDE, PI]),
      buildConfig(CLAUDE.id, SONNET.slug),
      DRAFT,
    );

    expect(menu.others[0]).toMatchObject({ instanceId: PI.id, dimmed: "not on moss" });
  });

  it("lists every other instance, however many there are - only Recent is capped", () => {
    const others = [1, 2, 3, 4].map((n) =>
      buildCountedInstance(`instance-${String(n)}`, `account ${String(n)}`, 1),
    );
    const menu = buildModelMenu(
      buildCatalogs([CLAUDE, ...others]),
      buildConfig(CLAUDE.id, SONNET.slug),
      DRAFT,
    );

    expect(menu.others.map((row) => row.instanceId)).toEqual(others.map((each) => each.id));
  });

  it("offers no rows of another account while filtering on an active thread, whose account is fixed", () => {
    const menu = buildModelMenu(
      buildCatalogs([CLAUDE, CODEX]),
      buildConfig(CLAUDE.id, SONNET.slug),
      {
        ...DRAFT,
        kind: "active",
        filter: "gpt",
      },
    );

    expect(menu.others[0]).toMatchObject({ instanceId: CODEX.id, dimmed: "account fixed" });
    expect(menu.others[0]?.rows).toEqual([]);
  });

  it("dims every other instance with account fixed on an active thread", () => {
    const menu = buildModelMenu(
      buildCatalogs([CLAUDE, CODEX]),
      buildConfig(CLAUDE.id, SONNET.slug),
      {
        ...DRAFT,
        kind: "active",
      },
    );

    expect(menu.others[0]).toMatchObject({
      instanceId: CODEX.id,
      dimmed: "account fixed",
      login: null,
    });
  });
});
