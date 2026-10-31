/**
 * Tests `buildModelMenu(catalogs, config, { kind, filter, recent })`, which
 * builds what the model selector renders: a filter field only when there are
 * more than eight models, the recent models, the current account's models
 * with its legacy models collapsed, and one row per other account.
 */
import { describe, expect, it } from "vitest";
import type { ProviderAccount, Runner } from "@hercule/contract";
import {
  BARE,
  buildProviderAccount,
  buildSnapshot,
  ANTHROPIC_IDENTITY,
  OPENAI_IDENTITY,
  ZAI_IDENTITY,
  HARNESSES,
  PROVIDERS,
} from "../providers.testing";
import type { ThreadConfig } from "./config";
import { buildModelMenu } from "./model-menu";

const buildRunner = (overrides: Partial<Runner> & { id: string }): Runner => ({
  ...BARE,
  ...overrides,
});

const LOCAL = buildRunner({ id: "r-local", name: "moss" });

const SONNET = {
  slug: "claude-sonnet-5",
  name: "Claude Sonnet 5",
  imageInput: { maxBytes: null },
  isDefault: true,
  options: [],
};
const OPUS = {
  slug: "claude-opus-5",
  name: "Claude Opus 5",
  imageInput: { maxBytes: null },
  options: [],
};
const LEGACY = {
  slug: "claude-sonnet-3",
  name: "Claude Sonnet 3",
  imageInput: { maxBytes: null },
  isLegacy: true,
  options: [],
};
const GPT = { slug: "gpt-5", name: "GPT-5", imageInput: { maxBytes: null }, options: [] };

const withModels = (
  base: ProviderAccount,
  id: string,
  label: string | null,
  models: ProviderAccount["snapshots"][number]["models"],
): ProviderAccount => ({
  ...base,
  id,
  label,
  snapshots: [buildSnapshot({ runnerId: LOCAL.id, models })],
});

/** An unlabelled Anthropic account. */
const CLAUDE: ProviderAccount = buildProviderAccount(ANTHROPIC_IDENTITY, [
  buildSnapshot({ runnerId: LOCAL.id, models: [SONNET, OPUS, LEGACY] }),
]);

const WORK = withModels(CLAUDE, "account-claude-work", "work", [SONNET, OPUS, LEGACY]);
const PERSONAL = withModels(CLAUDE, "account-claude-personal", "personal", [OPUS]);

const CODEX = buildProviderAccount(OPENAI_IDENTITY, [
  buildSnapshot({
    runnerId: LOCAL.id,
    auth: { status: "ok", identity: "rogier@example.com", planLabel: "Pro" },
    models: [GPT],
  }),
]);

const CODEX_OUT = buildProviderAccount(OPENAI_IDENTITY, [
  buildSnapshot({ runnerId: LOCAL.id, auth: { status: "unauthenticated" }, models: [] }),
]);

/** Found on no runner: it has no snapshot for any runner. */
const PI = buildProviderAccount(ZAI_IDENTITY, []);

const buildCatalogs = (accounts: readonly ProviderAccount[]) => ({
  accounts,
  runners: [LOCAL],
  thisMacRunnerId: LOCAL.id,
  providers: PROVIDERS,
  harnesses: HARNESSES,
});

/** Returns the thread's config. The menu reads only the account, the harness and the model. */
const buildConfig = (providerAccountId: string, model: string): ThreadConfig => ({
  providerAccountId,
  harnessId: null,
  model,
  accessMode: "approval-required",
  runnerId: LOCAL.id,
  profileId: "p-unrestricted",
  options: {},
});

const DRAFT = { kind: "draft" as const, filter: "", recent: [] };

/** Returns one account with `count` models, to test the filter threshold. */
const buildCountedAccount = (id: string, label: string | null, count: number): ProviderAccount =>
  withModels(
    CLAUDE,
    id,
    label,
    Array.from({ length: count }, (_, index) => ({
      slug: `model-${id}-${index}`,
      name: `Model ${index}`,
      imageInput: { maxBytes: null },
      options: [],
    })),
  );

describe("buildModelMenu: filterable", () => {
  it("offers no filter at eight models across all accounts", () => {
    const menu = buildModelMenu(
      buildCatalogs([
        buildCountedAccount("account-a", "a", 5),
        buildCountedAccount("account-b", "b", 3),
      ]),
      buildConfig("account-a", "model-account-a-0"),
      DRAFT,
    );

    expect(menu.filterable).toBe(false);
  });

  it("offers a filter at nine models across all accounts", () => {
    const menu = buildModelMenu(
      buildCatalogs([
        buildCountedAccount("account-a", "a", 5),
        buildCountedAccount("account-b", "b", 4),
      ]),
      buildConfig("account-a", "model-account-a-0"),
      DRAFT,
    );

    expect(menu.filterable).toBe(true);
  });
});

describe("buildModelMenu: filtering", () => {
  it("keeps the matching rows in every account, case-insensitively, and omits accounts with no match", () => {
    const menu = buildModelMenu(
      buildCatalogs([WORK, PERSONAL, CODEX]),
      buildConfig(WORK.id, SONNET.slug),
      {
        ...DRAFT,
        filter: "OPUS",
      },
    );

    expect(menu.current.rows.map((row) => row.slug)).toEqual([OPUS.slug]);
    expect(menu.others.map((row) => row.providerAccountId)).toEqual([PERSONAL.id]);
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
  it("lists the given pairs in order, naming the account only for a provider with more than one account", () => {
    const menu = buildModelMenu(
      buildCatalogs([WORK, PERSONAL, CODEX]),
      buildConfig(WORK.id, SONNET.slug),
      {
        ...DRAFT,
        recent: [
          { providerAccountId: CODEX.id, model: GPT.slug },
          { providerAccountId: PERSONAL.id, model: OPUS.slug },
        ],
      },
    );

    expect(menu.recent).toHaveLength(2);
    expect(menu.recent[0]).toMatchObject({
      providerAccountId: CODEX.id,
      model: GPT.slug,
      name: "GPT-5",
      harnessId: "codex/codex",
      account: null,
    });
    expect(menu.recent[1]).toMatchObject({
      providerAccountId: PERSONAL.id,
      model: OPUS.slug,
      name: "Claude Opus 5",
      harnessId: "claude-code/claude-code",
      account: "Anthropic · personal",
    });
  });

  it("holds at most three rows", () => {
    const menu = buildModelMenu(
      buildCatalogs([buildCountedAccount("account-a", "a", 5)]),
      buildConfig("account-a", "model-account-a-0"),
      {
        ...DRAFT,
        recent: [0, 1, 2, 3].map((index) => ({
          providerAccountId: "account-a",
          model: `model-account-a-${index}`,
        })),
      },
    );

    expect(menu.recent).toHaveLength(3);
  });

  it("drops a pair whose account or model is no longer in the catalog", () => {
    const menu = buildModelMenu(buildCatalogs([WORK, CODEX]), buildConfig(WORK.id, SONNET.slug), {
      ...DRAFT,
      recent: [
        { providerAccountId: "account-that-went-away", model: SONNET.slug },
        { providerAccountId: WORK.id, model: "claude-model-that-went-away" },
        { providerAccountId: CODEX.id, model: GPT.slug },
      ],
    });

    expect(menu.recent.map((row) => row.model)).toEqual([GPT.slug]);
  });

  it("dims a recent row from another account as account fixed on an active thread", () => {
    const menu = buildModelMenu(
      buildCatalogs([WORK, PERSONAL, CODEX]),
      buildConfig(WORK.id, SONNET.slug),
      {
        ...DRAFT,
        kind: "active",
        recent: [
          { providerAccountId: PERSONAL.id, model: OPUS.slug },
          { providerAccountId: WORK.id, model: OPUS.slug },
        ],
      },
    );

    expect(menu.recent[0]).toMatchObject({
      providerAccountId: PERSONAL.id,
      dimmed: "account fixed",
    });
    expect(menu.recent[1]).toMatchObject({ providerAccountId: WORK.id, dimmed: null });
  });
});

describe("buildModelMenu: the current account", () => {
  it("labels the section with the account name, label included", () => {
    const menu = buildModelMenu(
      buildCatalogs([WORK, PERSONAL]),
      buildConfig(WORK.id, SONNET.slug),
      DRAFT,
    );

    expect(menu.current.label).toBe("Anthropic · work");
  });

  it("labels the section with the provider's name when the account has no label", () => {
    const menu = buildModelMenu(
      buildCatalogs([CLAUDE, CODEX]),
      buildConfig(CLAUDE.id, SONNET.slug),
      DRAFT,
    );

    expect(menu.current.label).toBe("Anthropic");
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

  it("moves legacy models from rows into older", () => {
    const menu = buildModelMenu(
      buildCatalogs([CLAUDE]),
      buildConfig(CLAUDE.id, SONNET.slug),
      DRAFT,
    );

    expect(menu.current.rows.map((row) => row.slug)).toEqual([SONNET.slug, OPUS.slug]);
    expect(menu.current.older.map((row) => row.slug)).toEqual([LEGACY.slug]);
  });

  it("keeps legacy models in rows while filtering", () => {
    const menu = buildModelMenu(buildCatalogs([CLAUDE]), buildConfig(CLAUDE.id, SONNET.slug), {
      ...DRAFT,
      filter: "sonnet",
    });

    expect(menu.current.rows.map((row) => row.slug)).toEqual([SONNET.slug, LEGACY.slug]);
    expect(menu.current.older).toEqual([]);
  });
});

describe("buildModelMenu: the other accounts", () => {
  it("gives one row per remaining account with its model count and identity", () => {
    const menu = buildModelMenu(
      buildCatalogs([CLAUDE, CODEX]),
      buildConfig(CLAUDE.id, SONNET.slug),
      DRAFT,
    );

    expect(menu.others).toHaveLength(1);
    expect(menu.others[0]).toMatchObject({
      providerAccountId: CODEX.id,
      models: "1 model",
      identity: "rogier@example.com",
      planLabel: "Pro",
      dimmed: null,
    });
  });

  it("dims an account that is not signed in on the runner, and includes the sign-in it needs", () => {
    const menu = buildModelMenu(
      buildCatalogs([CLAUDE, CODEX_OUT]),
      buildConfig(CLAUDE.id, SONNET.slug),
      DRAFT,
    );

    expect(menu.others[0]).toMatchObject({
      dimmed: "not signed in",
      signIn: { providerAccountId: CODEX_OUT.id, runnerId: LOCAL.id, subject: "OpenAI on moss" },
    });
  });

  it("dims an account with no snapshot on the runner, naming the runner", () => {
    const menu = buildModelMenu(
      buildCatalogs([CLAUDE, PI]),
      buildConfig(CLAUDE.id, SONNET.slug),
      DRAFT,
    );

    expect(menu.others[0]).toMatchObject({ providerAccountId: PI.id, dimmed: "not on moss" });
  });

  it("reads the current account in the thread's harness and every other account in its default harness", () => {
    const account = buildCountedAccount("account-a", null, 1);
    const inPi = buildSnapshot({
      runnerId: LOCAL.id,
      harnessId: "pi/pi",
      models: [{ slug: "glm-5.3", name: "GLM 5.3", imageInput: null, options: [] }],
    });
    const current = { ...account, snapshots: [...account.snapshots, inPi] };
    const other = { ...buildCountedAccount("account-b", null, 1), snapshots: [inPi] };

    const menu = buildModelMenu(
      buildCatalogs([current, other]),
      {
        ...buildConfig("account-a", "glm-5.3"),
        harnessId: "pi/pi",
      },
      DRAFT,
    );

    expect(menu.current.harnessId).toBe("pi/pi");
    expect(menu.current.rows.map((row) => row.slug)).toEqual(["glm-5.3"]);
    // The other account has only a Pi snapshot, but picking it would run its default harness.
    expect(menu.others[0]).toMatchObject({
      harnessId: ANTHROPIC_IDENTITY.harnessId,
      dimmed: "not on moss",
    });
  });

  it("lists every other account, however many there are; only the recent models are capped", () => {
    const others = [1, 2, 3, 4].map((n) =>
      buildCountedAccount(`account-${String(n)}`, `account ${String(n)}`, 1),
    );
    const menu = buildModelMenu(
      buildCatalogs([CLAUDE, ...others]),
      buildConfig(CLAUDE.id, SONNET.slug),
      DRAFT,
    );

    expect(menu.others.map((row) => row.providerAccountId)).toEqual(others.map((each) => each.id));
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

    expect(menu.others[0]).toMatchObject({ providerAccountId: CODEX.id, dimmed: "account fixed" });
    expect(menu.others[0]?.rows).toEqual([]);
  });

  it("dims every other account as account fixed on an active thread", () => {
    const menu = buildModelMenu(
      buildCatalogs([CLAUDE, CODEX]),
      buildConfig(CLAUDE.id, SONNET.slug),
      {
        ...DRAFT,
        kind: "active",
      },
    );

    expect(menu.others[0]).toMatchObject({
      providerAccountId: CODEX.id,
      dimmed: "account fixed",
      signIn: null,
    });
  });
});
