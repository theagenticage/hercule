/**
 * Tests `buildModelMenu(catalogs, current, view)`, which builds what the model
 * selector renders from the user's Model Profiles:
 *
 * - a draft shows the open profile: Recent, then one lane per account with
 *   its entries, a filter only for more than eight entries;
 * - an entry that cannot run is dimmed with its reason, and offers a sign-in
 *   when signing in would fix it;
 * - a running thread shows one flat list of its account and harness.
 */
import { describe, expect, it } from "vitest";
import type { ProviderAccount, ResolvedModelProfileEntry, Runner } from "@hercule/contract";
import {
  ANTHROPIC_IDENTITY,
  HARNESSES,
  OPENAI_IDENTITY,
  PROVIDERS,
  WITH_AGENTS,
  ZAI_IDENTITY,
  buildModelProfile,
  buildProfileEntry,
  buildProfileSection,
  buildProviderAccount,
} from "../providers.testing";
import type { ThreadCatalogs } from "./config";
import { buildModelMenu, type ModelMenu, type ModelMenuView } from "./model-menu";

const buildRunner = (overrides: Partial<Runner> & { id: string }): Runner => ({
  ...WITH_AGENTS,
  ...overrides,
});

const MOSS = buildRunner({ id: "r-moss", name: "moss" });
const COVE = buildRunner({ id: "r-cove", name: "cove" });

const CLAUDE_HARNESS = ANTHROPIC_IDENTITY.harnessId;
const CODEX_HARNESS = OPENAI_IDENTITY.harnessId;

/** Anthropic: ready on both machines. */
const CLAUDE = buildProviderAccount(
  ANTHROPIC_IDENTITY,
  [],
  [{ runnerId: MOSS.id }, { runnerId: COVE.id }],
);
/** OpenAI: signed in on cove only. */
const CODEX = buildProviderAccount(
  OPENAI_IDENTITY,
  [],
  [{ runnerId: MOSS.id, state: "not-signed-in" }, { runnerId: COVE.id }],
);
/** Z.ai: pi is on neither machine. */
const ZAI = buildProviderAccount(
  ZAI_IDENTITY,
  [],
  [
    { runnerId: MOSS.id, state: "harness-missing" },
    { runnerId: COVE.id, state: "harness-missing" },
  ],
);

const SONNET = buildProfileEntry(ANTHROPIC_IDENTITY, "claude-sonnet-5", { name: "Sonnet 5" });
const OPUS = buildProfileEntry(ANTHROPIC_IDENTITY, "claude-opus-5", { name: "Opus 5" });
const GPT = buildProfileEntry(OPENAI_IDENTITY, "gpt-6", { name: "GPT-6" });
const GLM = buildProfileEntry(ZAI_IDENTITY, "glm-5.3", { name: "GLM 5.3" });

const buildCatalogs = (
  modelProfiles: ThreadCatalogs["modelProfiles"],
  accounts: readonly ProviderAccount[] = [CLAUDE, CODEX, ZAI],
  runners: readonly Runner[] = [MOSS, COVE],
): ThreadCatalogs => ({
  accounts,
  runners,
  thisMacRunnerId: MOSS.id,
  providers: PROVIDERS,
  harnesses: HARNESSES,
  modelProfiles,
});

/** The open profile: Claude's two models, Codex's, and Z.ai's. Opus is the default. */
const MAIN = buildModelProfile(
  [
    buildProfileSection(ANTHROPIC_IDENTITY, [SONNET, OPUS]),
    buildProfileSection(OPENAI_IDENTITY, [GPT]),
    buildProfileSection(ZAI_IDENTITY, [GLM]),
  ],
  { defaultEntry: { providerAccountId: CLAUDE.id, model: "claude-opus-5", harnessId: null } },
);

const CURRENT = {
  providerAccountId: CLAUDE.id,
  harnessId: null,
  model: "claude-sonnet-5",
  runnerId: null,
};

const DRAFT: ModelMenuView = { kind: "draft", filter: "", recent: [], runnerId: null };

/** Returns the open profile of a draft menu. */
const readDraftProfile = (menu: ModelMenu) => {
  if (menu.kind !== "draft" || menu.profile === null) throw new Error("expected a draft profile");
  return menu.profile;
};

const readActive = (menu: ModelMenu) => {
  if (menu.kind !== "active") throw new Error("expected a running thread's menu");
  return menu;
};

describe("buildModelMenu for a draft", () => {
  it("has no profile when the user has none", () => {
    expect(buildModelMenu(buildCatalogs([]), CURRENT, DRAFT)).toEqual({
      kind: "draft",
      filterable: false,
      profile: null,
      empty: "No models in your profile yet.",
    });
  });

  it("shows one lane per account in the profile's order, with the account's name and logo, and its entries in order", () => {
    const profile = readDraftProfile(buildModelMenu(buildCatalogs([MAIN]), CURRENT, DRAFT));

    expect(profile).toMatchObject({ profileId: MAIN.id, name: "Main" });
    expect(
      profile.lanes.map((lane) => [lane.name, lane.providerId, lane.rows.map((row) => row.name)]),
    ).toEqual([
      ["Anthropic", "anthropic/anthropic", ["Sonnet 5", "Opus 5"]],
      ["OpenAI", "openai/openai", ["GPT-6"]],
      ["Z.ai", "zai/zai", ["GLM 5.3"]],
    ]);
  });

  it("builds a row that names its entry fully, marks the default and the current entry, and has no problem when it can run", () => {
    const profile = readDraftProfile(buildModelMenu(buildCatalogs([MAIN]), CURRENT, DRAFT));
    const [sonnet, opus] = profile.lanes[0]!.rows;

    expect(sonnet).toEqual({
      providerAccountId: CLAUDE.id,
      providerId: "anthropic/anthropic",
      harnessId: CLAUDE_HARNESS,
      model: "claude-sonnet-5",
      name: "Sonnet 5",
      inHarness: null,
      isDefault: false,
      isCurrent: true,
      problem: null,
    });
    expect(opus).toMatchObject({ isDefault: true, isCurrent: false });
  });

  it("names the harness of an entry that runs in another harness than its lane's, and tells two entries of one model apart", () => {
    const inPi = buildProfileEntry(ANTHROPIC_IDENTITY, "claude-sonnet-5", {
      name: "Sonnet 5",
      harnessId: "pi/pi",
      resolvedHarnessId: "pi/pi",
    });
    const profile = buildModelProfile([buildProfileSection(ANTHROPIC_IDENTITY, [SONNET, inPi])]);
    const claude = buildProviderAccount(
      ANTHROPIC_IDENTITY,
      [],
      [{ runnerId: MOSS.id }, { runnerId: MOSS.id, harnessId: "pi/pi" }],
    );

    const lane = readDraftProfile(
      buildModelMenu(buildCatalogs([profile], [claude]), CURRENT, DRAFT),
    ).lanes[0]!;

    expect(lane.rows.map((row) => [row.harnessId, row.inHarness, row.isCurrent])).toEqual([
      [CLAUDE_HARNESS, null, true],
      ["pi/pi", "pi", false],
    ]);
  });

  it("does not call an entry that follows a section harness 'in' another harness", () => {
    const profile = buildModelProfile([
      buildProfileSection(
        ANTHROPIC_IDENTITY,
        [
          buildProfileEntry(ANTHROPIC_IDENTITY, "claude-sonnet-5", {
            resolvedHarnessId: "pi/pi",
          }),
        ],
        { harnessId: "pi/pi" },
      ),
    ]);

    const row = readDraftProfile(buildModelMenu(buildCatalogs([profile]), CURRENT, DRAFT)).lanes[0]!
      .rows[0]!;

    expect(row.inHarness).toBeNull();
  });

  it("marks the current entry by harness too, not by account and model alone", () => {
    const inPi = buildProfileEntry(ANTHROPIC_IDENTITY, "claude-sonnet-5", {
      harnessId: "pi/pi",
      resolvedHarnessId: "pi/pi",
    });
    const profile = buildModelProfile([buildProfileSection(ANTHROPIC_IDENTITY, [SONNET, inPi])]);

    const lane = readDraftProfile(
      buildModelMenu(buildCatalogs([profile]), { ...CURRENT, harnessId: "pi/pi" }, DRAFT),
    ).lanes[0]!;

    expect(lane.rows.map((row) => row.isCurrent)).toEqual([false, true]);
  });

  it("names a lane by its account's label, and shows the open profile only", () => {
    const work = buildProviderAccount({ ...ANTHROPIC_IDENTITY, id: "account-work", label: "work" });
    const workIdentity = { ...ANTHROPIC_IDENTITY, id: "account-work" };
    const second = buildModelProfile([buildProfileSection(ANTHROPIC_IDENTITY, [OPUS])], {
      id: "profile-second",
      name: "Second",
    });
    const first = buildModelProfile([
      buildProfileSection(workIdentity, [buildProfileEntry(workIdentity, "claude-opus-5")]),
    ]);

    const profile = readDraftProfile(
      buildModelMenu(buildCatalogs([first, second], [work, CLAUDE]), CURRENT, DRAFT),
    );

    expect(profile.profileId).toBe(first.id);
    expect(profile.lanes.map((lane) => lane.name)).toEqual(["Anthropic · work"]);
  });

  it("offers a filter only when the profile holds more than eight entries", () => {
    const entries = (count: number) =>
      Array.from({ length: count }, (_, index) =>
        buildProfileEntry(ANTHROPIC_IDENTITY, `model-${String(index)}`),
      );
    const profileOf = (count: number) =>
      buildModelProfile([buildProfileSection(ANTHROPIC_IDENTITY, entries(count))]);

    const filterable = (count: number) =>
      buildModelMenu(buildCatalogs([profileOf(count)]), CURRENT, DRAFT).filterable;

    expect(filterable(8)).toBe(false);
    expect(filterable(9)).toBe(true);
  });

  it("counts the entries of every account towards the filter", () => {
    const profile = buildModelProfile([
      buildProfileSection(
        ANTHROPIC_IDENTITY,
        Array.from({ length: 5 }, (_, i) =>
          buildProfileEntry(ANTHROPIC_IDENTITY, `a-${String(i)}`),
        ),
      ),
      buildProfileSection(
        OPENAI_IDENTITY,
        Array.from({ length: 4 }, (_, i) => buildProfileEntry(OPENAI_IDENTITY, `o-${String(i)}`)),
      ),
    ]);

    expect(buildModelMenu(buildCatalogs([profile]), CURRENT, DRAFT).filterable).toBe(true);
  });

  describe("the filter", () => {
    it("matches the display name and the model id, in any case, and drops the lanes with no match", () => {
      const catalogs = buildCatalogs([MAIN]);

      const byName = readDraftProfile(
        buildModelMenu(catalogs, CURRENT, { ...DRAFT, filter: " opus " }),
      );
      expect(byName.lanes.map((lane) => lane.rows.map((row) => row.model))).toEqual([
        ["claude-opus-5"],
      ]);

      const byId = readDraftProfile(
        buildModelMenu(catalogs, CURRENT, { ...DRAFT, filter: "GPT-6" }),
      );
      expect(byId.lanes.map((lane) => lane.name)).toEqual(["OpenAI"]);
    });

    it("finds a model by words from its name and its id together", () => {
      const byWords = readDraftProfile(
        buildModelMenu(buildCatalogs([MAIN]), CURRENT, { ...DRAFT, filter: "opus 5" }),
      );

      expect(byWords.lanes.map((lane) => lane.rows.map((row) => row.model))).toEqual([
        ["claude-opus-5"],
      ]);
    });

    it("shows nothing, and says that no model matches, when nothing matches", () => {
      const menu = buildModelMenu(buildCatalogs([MAIN]), CURRENT, { ...DRAFT, filter: "zzz" });
      const profile = readDraftProfile(menu);

      expect(profile.lanes).toEqual([]);
      expect(profile.recent).toEqual([]);
      expect(menu).toMatchObject({ empty: "No model matches." });
    });

    it("says nothing about being empty while something is listed", () => {
      expect(buildModelMenu(buildCatalogs([MAIN]), CURRENT, DRAFT)).toMatchObject({ empty: null });
    });

    it("says the profile is empty when it holds nothing and the user is not filtering", () => {
      const empty = buildModelProfile([buildProfileSection(ANTHROPIC_IDENTITY, [])]);

      expect(buildModelMenu(buildCatalogs([empty]), CURRENT, DRAFT)).toMatchObject({
        empty: "No models in your profile yet.",
      });
    });

    it("filters Recent too", () => {
      const recent = [
        { providerAccountId: CLAUDE.id, harnessId: CLAUDE_HARNESS, model: "claude-opus-5" },
        { providerAccountId: CODEX.id, harnessId: CODEX_HARNESS, model: "gpt-6" },
      ];

      const profile = readDraftProfile(
        buildModelMenu(buildCatalogs([MAIN]), CURRENT, { ...DRAFT, filter: "gpt", recent }),
      );

      expect(profile.recent.map((row) => row.model)).toEqual(["gpt-6"]);
    });
  });

  describe("Recent", () => {
    it("lists the entries of this profile the user picked, newest first, at most three", () => {
      const recent = [
        { providerAccountId: CODEX.id, harnessId: CODEX_HARNESS, model: "gpt-6" },
        { providerAccountId: CLAUDE.id, harnessId: CLAUDE_HARNESS, model: "claude-opus-5" },
        { providerAccountId: ZAI.id, harnessId: "pi/pi", model: "glm-5.3" },
        { providerAccountId: CLAUDE.id, harnessId: CLAUDE_HARNESS, model: "claude-sonnet-5" },
      ];

      const profile = readDraftProfile(
        buildModelMenu(buildCatalogs([MAIN]), CURRENT, { ...DRAFT, recent }),
      );

      expect(profile.recent.map((row) => row.name)).toEqual(["GPT-6", "Opus 5", "GLM 5.3"]);
    });

    it("skips an entry the profile no longer holds, and one that runs in another harness than the one recorded", () => {
      const recent = [
        { providerAccountId: CLAUDE.id, harnessId: CLAUDE_HARNESS, model: "claude-haiku-5" },
        { providerAccountId: CLAUDE.id, harnessId: "pi/pi", model: "claude-opus-5" },
        { providerAccountId: CLAUDE.id, harnessId: CLAUDE_HARNESS, model: "claude-opus-5" },
      ];

      const profile = readDraftProfile(
        buildModelMenu(buildCatalogs([MAIN]), CURRENT, { ...DRAFT, recent }),
      );

      expect(profile.recent.map((row) => row.model)).toEqual(["claude-opus-5"]);
    });

    it("keeps the full row on a recent entry, and names its account only when the user has two at its provider", () => {
      const recent = [
        { providerAccountId: CLAUDE.id, harnessId: CLAUDE_HARNESS, model: "claude-opus-5" },
      ];
      const alone = readDraftProfile(
        buildModelMenu(buildCatalogs([MAIN]), CURRENT, { ...DRAFT, recent }),
      );
      expect(alone.recent[0]).toMatchObject({ isDefault: true, account: null });

      const work = buildProviderAccount({
        ...ANTHROPIC_IDENTITY,
        id: "account-work",
        label: "work",
      });
      const withTwo = readDraftProfile(
        buildModelMenu(buildCatalogs([MAIN], [CLAUDE, work, CODEX, ZAI]), CURRENT, {
          ...DRAFT,
          recent,
        }),
      );
      expect(withTwo.recent[0]).toMatchObject({ account: "Anthropic" });
    });
  });

  describe("an entry that cannot run", () => {
    it("is dimmed with the machine's name when the account is not signed in on the selected machine", () => {
      const profile = readDraftProfile(
        buildModelMenu(buildCatalogs([MAIN]), CURRENT, { ...DRAFT, runnerId: MOSS.id }),
      );

      expect(profile.lanes[1]!.rows[0]!.problem).toEqual({
        message: "not signed in on moss",
        signIn: {
          providerAccountId: CODEX.id,
          runnerId: MOSS.id,
          subject: "OpenAI on moss",
        },
      });
    });

    it("is not dimmed on a selected machine where the account is ready, whatever the other machines say", () => {
      const profile = readDraftProfile(
        buildModelMenu(buildCatalogs([MAIN]), CURRENT, { ...DRAFT, runnerId: COVE.id }),
      );

      expect(profile.lanes[1]!.rows[0]!.problem).toBeNull();
    });

    it("reads the readiness of the entry's own harness, not the account's default", () => {
      const inPi = buildProfileEntry(ANTHROPIC_IDENTITY, "claude-sonnet-5", {
        harnessId: "pi/pi",
        resolvedHarnessId: "pi/pi",
      });
      const profile = buildModelProfile([buildProfileSection(ANTHROPIC_IDENTITY, [SONNET, inPi])]);

      const rows = readDraftProfile(
        buildModelMenu(buildCatalogs([profile]), CURRENT, { ...DRAFT, runnerId: MOSS.id }),
      ).lanes[0]!.rows;

      expect(rows.map((row) => row.problem?.message ?? null)).toEqual([null, "pi is not on moss"]);
    });

    it("says why for each state the controller reports on the selected machine", () => {
      const states = [
        ["not-signed-in", "not signed in on moss"],
        ["credential-missing", "no key"],
        ["token-expired", "expired"],
        ["harness-missing", "Claude Code is not on moss"],
        ["harness-too-old", "Claude Code on moss is too old"],
      ] as const;

      for (const [state, message] of states) {
        const claude = buildProviderAccount(ANTHROPIC_IDENTITY, [], [{ runnerId: MOSS.id, state }]);
        const profile = readDraftProfile(
          buildModelMenu(buildCatalogs([MAIN], [claude, CODEX, ZAI]), CURRENT, {
            ...DRAFT,
            runnerId: MOSS.id,
          }),
        );
        expect(profile.lanes[0]!.rows[0]!.problem?.message).toBe(message);
      }
    });

    it("offers a sign-in only for a missing sign-in, and only on a machine that is online", () => {
      const offline = buildRunner({ id: MOSS.id, name: "moss", connectivity: "offline" });
      const draining = buildRunner({ id: MOSS.id, name: "moss", lifecycle: "draining" });
      const claude = buildProviderAccount(
        ANTHROPIC_IDENTITY,
        [],
        [{ runnerId: MOSS.id, state: "token-expired" }],
      );

      const expired = readDraftProfile(
        buildModelMenu(buildCatalogs([MAIN], [claude, CODEX, ZAI]), CURRENT, {
          ...DRAFT,
          runnerId: MOSS.id,
        }),
      );
      expect(expired.lanes[0]!.rows[0]!.problem?.signIn).toBeNull();

      const signInOn = (runners: readonly Runner[]) =>
        readDraftProfile(
          buildModelMenu(buildCatalogs([MAIN], [CLAUDE, CODEX, ZAI], runners), CURRENT, {
            ...DRAFT,
            runnerId: MOSS.id,
          }),
        ).lanes[1]!.rows[0]!.problem;
      expect(signInOn([offline, COVE])).toMatchObject({
        message: "not signed in on moss",
        signIn: null,
      });
      expect(signInOn([draining, COVE])?.signIn).toMatchObject({ runnerId: MOSS.id });
    });

    describe("for an account whose login makes a token", () => {
      const TOKEN_KIND = {
        id: "subscription-token",
        title: "Claude subscription token",
        description: "A token made once and used on every machine.",
        setup: [{ kind: "harness-login", method: "create-token" }],
        harnesses: [CLAUDE_HARNESS],
      } as const;
      const providers = PROVIDERS.map((provider) =>
        provider.id === ANTHROPIC_IDENTITY.providerId
          ? { ...provider, kinds: [...provider.kinds, TOKEN_KIND] }
          : provider,
      );
      const tokenAccount = (state: "credential-missing" | "token-expired") => ({
        ...buildProviderAccount(ANTHROPIC_IDENTITY, [], [{ runnerId: MOSS.id, state }]),
        kind: TOKEN_KIND.id,
      });
      const rowOn = (account: ProviderAccount, runnerId: string | null) =>
        readDraftProfile(
          buildModelMenu({ ...buildCatalogs([MAIN], [account, CODEX, ZAI]), providers }, CURRENT, {
            ...DRAFT,
            runnerId,
          }),
        ).lanes[0]!.rows[0]!.problem;

      it("offers to make a token when there is none or it expired", () => {
        for (const [state, message] of [
          ["credential-missing", "no token"],
          ["token-expired", "expired"],
        ] as const) {
          expect(rowOn(tokenAccount(state), MOSS.id)).toEqual({
            message,
            signIn: {
              providerAccountId: CLAUDE.id,
              runnerId: MOSS.id,
              subject: "Anthropic on moss",
            },
          });
        }
      });

      it("offers it on the first online machine that has the problem when no machine is selected", () => {
        const expired: ResolvedModelProfileEntry = {
          ...SONNET,
          problem: { reason: "token-expired", message: "controller words" },
        };
        const profile = buildModelProfile([buildProfileSection(ANTHROPIC_IDENTITY, [expired])]);

        const { lanes } = readDraftProfile(
          buildModelMenu(
            { ...buildCatalogs([profile], [tokenAccount("token-expired")]), providers },
            CURRENT,
            DRAFT,
          ),
        );

        expect(lanes[0]!.rows[0]!.problem).toMatchObject({
          message: "expired",
          signIn: { runnerId: MOSS.id },
        });
      });
    });

    it("keeps the controller's sentence for a problem with the model itself, on any machine, with no sign-in", () => {
      const gone: ResolvedModelProfileEntry = {
        ...SONNET,
        problem: { reason: "model-left-catalog", message: "Anthropic no longer lists this model" },
      };
      const lacks: ResolvedModelProfileEntry = {
        ...OPUS,
        problem: { reason: "harness-lacks-model", message: "pi does not list this model" },
      };
      const profile = buildModelProfile([buildProfileSection(ANTHROPIC_IDENTITY, [gone, lacks])]);

      for (const runnerId of [null, MOSS.id]) {
        const rows = readDraftProfile(
          buildModelMenu(buildCatalogs([profile]), CURRENT, { ...DRAFT, runnerId }),
        ).lanes[0]!.rows;
        expect(rows.map((row) => row.problem)).toEqual([
          { message: "Anthropic no longer lists this model", signIn: null },
          { message: "pi does not list this model", signIn: null },
        ]);
      }
    });

    it("keeps the controller's sentence for a harness the account may not use, on any machine, with no sign-in", () => {
      const refused: ResolvedModelProfileEntry = {
        ...SONNET,
        problem: { reason: "harness-not-allowed", message: "controller words" },
      };
      const profile = buildModelProfile([buildProfileSection(ANTHROPIC_IDENTITY, [refused])]);

      for (const runnerId of [null, MOSS.id]) {
        const row = readDraftProfile(
          buildModelMenu(buildCatalogs([profile]), CURRENT, { ...DRAFT, runnerId }),
        ).lanes[0]!.rows[0]!;
        expect(row.problem).toEqual({ message: "controller words", signIn: null });
      }
    });

    describe("with no machine selected", () => {
      const withProblem = (
        entry: ResolvedModelProfileEntry,
        problem: ResolvedModelProfileEntry["problem"],
      ) => buildModelProfile([buildProfileSection(OPENAI_IDENTITY, [{ ...entry, problem }])]);

      it("is not dimmed while some machine can run the entry", () => {
        const profile = readDraftProfile(buildModelMenu(buildCatalogs([MAIN]), CURRENT, DRAFT));

        expect(profile.lanes.every((lane) => lane.rows[0]!.problem === null)).toBe(true);
      });

      it("signs in on the first connected machine where the account is not signed in", () => {
        const codex = buildProviderAccount(
          OPENAI_IDENTITY,
          [],
          [
            { runnerId: MOSS.id, state: "harness-missing" },
            { runnerId: COVE.id, state: "not-signed-in" },
          ],
        );
        const profile = withProblem(GPT, { reason: "not-signed-in", message: "controller words" });

        const row = readDraftProfile(
          buildModelMenu(buildCatalogs([profile], [codex]), CURRENT, DRAFT),
        ).lanes[0]!.rows[0]!;

        expect(row.problem).toEqual({
          message: "not signed in on cove",
          signIn: { providerAccountId: codex.id, runnerId: COVE.id, subject: "OpenAI on cove" },
        });
      });

      it("skips a machine that is offline when it looks for the machine to sign in on", () => {
        const codex = buildProviderAccount(
          OPENAI_IDENTITY,
          [],
          [
            { runnerId: MOSS.id, state: "not-signed-in" },
            { runnerId: COVE.id, state: "not-signed-in" },
          ],
        );
        const profile = withProblem(GPT, { reason: "not-signed-in", message: "controller words" });
        const offline = buildRunner({ id: MOSS.id, name: "moss", connectivity: "offline" });

        const row = readDraftProfile(
          buildModelMenu(buildCatalogs([profile], [codex], [offline, COVE]), CURRENT, DRAFT),
        ).lanes[0]!.rows[0]!;

        expect(row.problem?.signIn).toMatchObject({ runnerId: COVE.id });
      });

      it("says the other reasons without naming a machine", () => {
        const reasons = [
          ["credential-missing", "no key"],
          ["token-expired", "expired"],
          ["harness-missing", "Codex is not on any machine"],
          ["harness-too-old", "Codex is too old"],
          ["no-runner", "no machine is connected"],
        ] as const;

        for (const [reason, message] of reasons) {
          const profile = withProblem(GPT, { reason, message: "controller words" });
          const row = readDraftProfile(
            buildModelMenu(buildCatalogs([profile], [CODEX]), CURRENT, DRAFT),
          ).lanes[0]!.rows[0]!;
          expect(row.problem).toEqual({ message, signIn: null });
        }
      });
    });
  });

  describe("a section whose account has not been read yet", () => {
    const pending = buildModelProfile([
      buildProfileSection(ANTHROPIC_IDENTITY, [SONNET]),
      buildProfileSection(OPENAI_IDENTITY, "pending"),
    ]);

    it("shows its lane with a note and no rows", () => {
      const lanes = readDraftProfile(
        buildModelMenu(buildCatalogs([pending]), CURRENT, DRAFT),
      ).lanes;

      expect(lanes.map((lane) => [lane.name, lane.rows.length, lane.note])).toEqual([
        ["Anthropic", 1, null],
        ["OpenAI", 0, "Reading models…"],
      ]);
    });

    it("does not count towards the filter, and shows no lane while the user is filtering", () => {
      const profile = readDraftProfile(
        buildModelMenu(buildCatalogs([pending]), CURRENT, { ...DRAFT, filter: "son" }),
      );

      expect(profile.lanes.map((lane) => lane.name)).toEqual(["Anthropic"]);
    });
  });

  it("leaves out a section with no entries, since it has nothing to pick", () => {
    const profile = buildModelProfile([
      buildProfileSection(ANTHROPIC_IDENTITY, []),
      buildProfileSection(OPENAI_IDENTITY, [GPT]),
    ]);

    expect(
      readDraftProfile(buildModelMenu(buildCatalogs([profile]), CURRENT, DRAFT)).lanes.map(
        (lane) => lane.name,
      ),
    ).toEqual(["OpenAI"]);
  });

  it("leaves out a section whose account is not on the list", () => {
    const lanes = readDraftProfile(
      buildModelMenu(buildCatalogs([MAIN], [CLAUDE]), CURRENT, DRAFT),
    ).lanes;

    expect(lanes.map((lane) => lane.name)).toEqual(["Anthropic"]);
  });
});

describe("buildModelMenu for a running thread", () => {
  const ACTIVE = { ...CURRENT, runnerId: MOSS.id };
  const view: ModelMenuView = { kind: "active", filter: "", recent: [], runnerId: null };

  it("is one flat list of the entries with the session's account and harness, with the note, and no Recent", () => {
    const menu = readActive(buildModelMenu(buildCatalogs([MAIN]), ACTIVE, view));

    expect(menu.rows.map((row) => [row.name, row.isCurrent])).toEqual([
      ["Sonnet 5", true],
      ["Opus 5", false],
    ]);
    expect(menu.note).toBe("Other models start a new thread.");
    expect(menu).not.toHaveProperty("recent");
  });

  it("says that no model matches when the filter matches none, and nothing otherwise", () => {
    const catalogs = buildCatalogs([MAIN]);

    expect(buildModelMenu(catalogs, ACTIVE, view)).toMatchObject({ empty: null });
    expect(buildModelMenu(catalogs, ACTIVE, { ...view, filter: "zzz" })).toMatchObject({
      rows: [],
      empty: "No model matches.",
    });
  });

  it("lists each model once, the first profile that has it winning, across all profiles", () => {
    const first = buildModelProfile([buildProfileSection(ANTHROPIC_IDENTITY, [OPUS])], {
      id: "profile-first",
    });
    const second = buildModelProfile(
      [buildProfileSection(ANTHROPIC_IDENTITY, [{ ...OPUS, name: "Opus (second)" }, SONNET])],
      { id: "profile-second" },
    );

    const menu = readActive(buildModelMenu(buildCatalogs([first, second]), ACTIVE, view));

    expect(menu.rows.map((row) => row.name)).toEqual(["Opus 5", "Sonnet 5"]);
  });

  it("leaves out the entries of other accounts and of other harnesses", () => {
    const inPi = buildProfileEntry(ANTHROPIC_IDENTITY, "claude-haiku-5", {
      harnessId: "pi/pi",
      resolvedHarnessId: "pi/pi",
    });
    const profile = buildModelProfile([
      buildProfileSection(ANTHROPIC_IDENTITY, [SONNET, inPi]),
      buildProfileSection(OPENAI_IDENTITY, [GPT]),
    ]);

    const menu = readActive(buildModelMenu(buildCatalogs([profile]), ACTIVE, view));

    expect(menu.rows.map((row) => row.model)).toEqual(["claude-sonnet-5"]);
  });

  it("shows a model that no profile holds as the current row, under its id", () => {
    const menu = readActive(
      buildModelMenu(buildCatalogs([MAIN]), { ...ACTIVE, model: "claude-haiku-5" }, view),
    );

    expect(menu.rows[0]).toMatchObject({
      model: "claude-haiku-5",
      name: "claude-haiku-5",
      isCurrent: true,
      problem: null,
      harnessId: CLAUDE_HARNESS,
    });
    expect(menu.rows.slice(1).map((row) => row.isCurrent)).toEqual([false, false]);
  });

  it("shows the session's model alone when the user has no profile", () => {
    const menu = readActive(buildModelMenu(buildCatalogs([]), ACTIVE, view));

    expect(menu.rows.map((row) => [row.model, row.isCurrent])).toEqual([["claude-sonnet-5", true]]);
  });

  it("dims an entry by the readiness on the session's own machine", () => {
    const claude = buildProviderAccount(ANTHROPIC_IDENTITY, [], [{ runnerId: MOSS.id }]);
    const broken: ResolvedModelProfileEntry = {
      ...OPUS,
      problem: { reason: "model-left-catalog", message: "Anthropic no longer lists this model" },
    };
    const profile = buildModelProfile([buildProfileSection(ANTHROPIC_IDENTITY, [SONNET, broken])]);

    const menu = readActive(
      buildModelMenu(buildCatalogs([profile], [claude]), { ...ACTIVE, runnerId: MOSS.id }, view),
    );

    expect(menu.rows.map((row) => row.problem?.message ?? null)).toEqual([
      null,
      "Anthropic no longer lists this model",
    ]);

    const elsewhere = readActive(
      buildModelMenu(buildCatalogs([profile], [claude]), { ...ACTIVE, runnerId: COVE.id }, view),
    );
    expect(elsewhere.rows[0]!.problem?.message).toBe("Claude Code is not on cove");
  });

  it("marks no row as the profile's default, and names no harness on a row", () => {
    const menu = readActive(buildModelMenu(buildCatalogs([MAIN]), ACTIVE, view));

    expect(menu.rows.every((row) => !row.isDefault && row.inHarness === null)).toBe(true);
  });

  it("offers a filter for more than eight models, and applies it", () => {
    const profile = buildModelProfile([
      buildProfileSection(
        ANTHROPIC_IDENTITY,
        Array.from({ length: 9 }, (_, index) =>
          buildProfileEntry(ANTHROPIC_IDENTITY, `model-${String(index)}`),
        ),
      ),
    ]);

    const unfiltered = readActive(buildModelMenu(buildCatalogs([profile]), ACTIVE, view));
    const filtered = readActive(
      buildModelMenu(buildCatalogs([profile]), ACTIVE, { ...view, filter: "model-3" }),
    );

    expect(unfiltered.filterable).toBe(true);
    expect(filtered.rows.map((row) => row.model)).toEqual(["model-3"]);
  });
});
