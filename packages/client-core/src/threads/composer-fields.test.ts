/**
 * Tests `composeDraft(catalogs, config, kind)`, which decides every
 * lock, dimmed state and blocker the composer shows, so no component holds a
 * reason string. The tests check that:
 *
 * - an active thread's fields are locked, with a sentence that says why, and
 *   the model is never locked;
 * - a draft that cannot start says why, and includes the sign-in it needs;
 * - a draft cannot join a workspace that is not ready, or run on a retired
 *   runner;
 * - the model pill names the account only when the harness has more than
 *   one account.
 */
import { describe, expect, it } from "vitest";
import type {
  ModelOption,
  Project,
  ProviderAccount,
  Resource,
  Runner,
  Session,
  Workspace,
} from "@hercule/contract";
import {
  BARE,
  WITH_AGENTS,
  buildModelProfile,
  buildProfileEntry,
  buildProfileSection,
  buildProviderAccount,
  ANTHROPIC_IDENTITY,
  HARNESSES,
  PROVIDERS,
  ZAI_IDENTITY,
} from "../providers.testing";
import {
  buildComposerFields,
  buildPendingModelNote,
  describeMachineRow,
  type MachineRow,
} from "./composer-fields";
import type { ThreadCatalogs, ThreadConfig, ThreadPicks } from "./config";
import { resolveThreadConfig } from "./resolve-thread";
import { joinPhraseText } from "./workspaces";

const buildRunner = (overrides: Partial<Runner> & { id: string }): Runner => ({
  ...WITH_AGENTS,
  ...overrides,
});

const LOCAL = buildRunner({ id: "r-local", name: "moss" });

const EFFORT: ModelOption = {
  id: "effort",
  label: "Reasoning effort",
  kind: "select",
  choices: [
    { value: "low", label: "Low" },
    { value: "high", label: "High" },
  ],
  default: "low",
};

const SONNET = buildProfileEntry(ANTHROPIC_IDENTITY, "claude-sonnet-5", {
  name: "Claude Sonnet 5",
  options: [EFFORT],
  imageInput: { maxBytes: null },
});
const HAIKU = buildProfileEntry(ANTHROPIC_IDENTITY, "claude-haiku-5", {
  name: "Claude Haiku 5",
  imageInput: { maxBytes: null },
});

/** Ready on the local runner, the only one most tests have. */
const CLAUDE = buildProviderAccount(ANTHROPIC_IDENTITY, [], [{ runnerId: LOCAL.id }]);

/** Returns another account at the same provider, so the pill has an account to name. */
const buildNamedProviderAccount = (id: string, label: string): ProviderAccount => ({
  ...CLAUDE,
  id,
  label,
});

const WORK = buildNamedProviderAccount("account-claude-work", "work");
const PERSONAL = buildNamedProviderAccount("account-claude-personal", "personal");

/** The account exists, but the controller has no readiness row for it on any runner. */
const NOT_HERE = buildProviderAccount(ANTHROPIC_IDENTITY, []);

const SIGNED_OUT = buildProviderAccount(
  ANTHROPIC_IDENTITY,
  [],
  [{ runnerId: LOCAL.id, state: "not-signed-in" }],
);

/** Offers Sonnet and Haiku on each of the Claude accounts above. */
const PROFILE = buildModelProfile(
  [CLAUDE, WORK, PERSONAL].map((account) => {
    const identity = { ...ANTHROPIC_IDENTITY, id: account.id };
    return buildProfileSection(identity, [
      { ...SONNET, providerAccountId: account.id },
      { ...HAIKU, providerAccountId: account.id },
    ]);
  }),
);

const buildCatalogs = (accounts: readonly ProviderAccount[]) => ({
  accounts,
  runners: [LOCAL],
  thisMacRunnerId: LOCAL.id,
  providers: PROVIDERS,
  harnesses: HARNESSES,
  modelProfiles: [PROFILE],
});

const buildConfig = (overrides: Partial<ThreadConfig> = {}): ThreadConfig => ({
  providerAccountId: CLAUDE.id,
  harnessId: null,
  model: SONNET.model,
  accessMode: "approval-required" as const,
  runnerId: LOCAL.id,
  profileId: "p-unrestricted",
  options: {},
  ...overrides,
});

/** Returns the fields of a draft that starts from `config` and holds `picks`. */
const composeDraft = (catalogs: ThreadCatalogs, config: ThreadConfig, picks: ThreadPicks = {}) =>
  buildComposerFields(catalogs, resolveThreadConfig(catalogs, { kind: "draft", config }, picks));

/** Returns the fields of a thread that has started as `session`. */
const composeActive = (catalogs: ThreadCatalogs, session: Session, picks: ThreadPicks = {}) =>
  buildComposerFields(catalogs, resolveThreadConfig(catalogs, { kind: "active", session }, picks));

describe("buildComposerFields", () => {
  describe("an account on a runner that may or may not have its harness", () => {
    const WITH_PI = buildRunner({
      id: "r-pi",
      name: "pi-box",
      facts: {
        ...BARE.facts!,
        harnesses: [{ name: "pi", present: true, path: "/usr/local/bin/pi" }],
        adapters: ["pi/pi"],
      },
    });
    const draftOn = (runner: Runner, account: ProviderAccount) =>
      composeDraft(
        { ...buildCatalogs([account]), runners: [runner], thisMacRunnerId: runner.id },
        buildConfig({ providerAccountId: account.id, runnerId: runner.id, model: null }),
      );

    it("lets a draft start where the controller says the account is ready, and offers no sign-in", () => {
      const ready = buildProviderAccount(ZAI_IDENTITY, [], [{ runnerId: WITH_PI.id }]);

      const fields = draftOn(WITH_PI, ready);

      expect(fields.blocked).toBeNull();
      expect(fields.machine.label).toBe("pi-box");
    });

    it("blocks a draft on a runner without the harness, with no sign-in to offer", () => {
      const missing = buildProviderAccount(
        ZAI_IDENTITY,
        [],
        [{ runnerId: LOCAL.id, state: "harness-missing" }],
      );

      const fields = draftOn(LOCAL, missing);

      expect(fields.blocked).toEqual({
        reason: "Z.ai is not on moss",
        signIn: null,
        addAccount: false,
      });
      expect(fields.machine.label).toBe("moss · not installed");
    });

    it("blocks a draft on a runner whose harness is too old, and says to update it", () => {
      const old = buildProviderAccount(
        ZAI_IDENTITY,
        [],
        [{ runnerId: LOCAL.id, state: "harness-too-old" }],
      );

      expect(draftOn(LOCAL, old).blocked).toEqual({
        reason: "The harness on moss is older than Hercule supports; update it",
        signIn: null,
        addAccount: false,
      });
    });

    it("blocks a draft whose key is not stored, and offers no sign-in because a key is typed in", () => {
      const noKey = buildProviderAccount(
        ZAI_IDENTITY,
        [],
        [{ runnerId: LOCAL.id, state: "credential-missing" }],
      );

      expect(draftOn(LOCAL, noKey).blocked).toEqual({
        reason: "Z.ai has no key; add one",
        signIn: null,
        addAccount: false,
      });
    });

    it("blocks a draft whose token expired, and offers to make a new one", () => {
      const expired = buildProviderAccount(
        ANTHROPIC_IDENTITY,
        [],
        [{ runnerId: LOCAL.id, state: "token-expired" }],
      );

      expect(draftOn(LOCAL, expired).blocked).toEqual({
        reason: "Anthropic's token expired; make a new one",
        signIn: {
          providerAccountId: expired.id,
          runnerId: LOCAL.id,
          subject: "Anthropic on moss",
        },
        addAccount: false,
      });
    });

    it("blocks a draft whose entry names a harness the account may not use, with the controller's sentence rather than 'not on' the machine", () => {
      const refused = {
        ...SONNET,
        problem: {
          reason: "harness-not-allowed" as const,
          message: "Anthropic subscriptions cannot run in pi",
        },
      };
      // No machine has a readiness row for a harness the account may not use.
      const catalogs = {
        ...buildCatalogs([buildProviderAccount(ANTHROPIC_IDENTITY, [], [])]),
        modelProfiles: [buildModelProfile([buildProfileSection(ANTHROPIC_IDENTITY, [refused])])],
      };

      expect(composeDraft(catalogs, buildConfig()).blocked).toEqual({
        reason: "Anthropic subscriptions cannot run in pi",
        signIn: null,
        addAccount: false,
      });
    });

    it("blocks a draft whose model left the account's catalog, with the controller's sentence", () => {
      const gone = {
        ...SONNET,
        problem: {
          reason: "model-left-catalog" as const,
          message: "Anthropic no longer lists Claude Sonnet 5",
        },
      };
      const catalogs = {
        ...buildCatalogs([CLAUDE]),
        modelProfiles: [buildModelProfile([buildProfileSection(ANTHROPIC_IDENTITY, [gone])])],
      };

      expect(composeDraft(catalogs, buildConfig()).blocked).toEqual({
        reason: "Anthropic no longer lists Claude Sonnet 5",
        signIn: null,
        addAccount: false,
      });
    });

    it("does not block a draft on a runner-level problem of its entry when the account is ready on the draft's own machine", () => {
      // The entry cannot run on any connected runner, but the account is ready here.
      const stale = {
        ...SONNET,
        problem: { reason: "no-runner" as const, message: "No machine is connected" },
      };
      const catalogs = {
        ...buildCatalogs([CLAUDE]),
        modelProfiles: [buildModelProfile([buildProfileSection(ANTHROPIC_IDENTITY, [stale])])],
      };

      expect(composeDraft(catalogs, buildConfig()).blocked).toBeNull();
    });
  });

  it("locks the access mode, the workspace and the runner on an active thread", () => {
    const fields = composeActive(buildCatalogs([CLAUDE]), {
      ...buildThread("s1", "A thread"),
      workspaceId: null,
    });

    expect(fields.accessMode.locked).toBe("Create a new thread to change the access mode");
    expect(fields.workspace.locked).toBe("Create a new thread to change the workspace");
    expect(fields.machine.locked).toBe("Create a new thread to change the machine");
  });

  it("locks nothing a draft can still change", () => {
    const fields = composeDraft(buildCatalogs([CLAUDE]), buildConfig());

    expect(fields.accessMode.locked).toBeNull();
    expect(fields.machine.locked).toBeNull();
    // With no repo there is no workspace to choose, so the field is locked,
    // and its reason says how to get one. For a draft with no project, that
    // is picking a project.
    expect(fields.workspace.locked).toBe("Pick a project to work in a repository");
  });

  it("tells the user to add a repository when the project has none", () => {
    const fields = composeDraft(FULL, buildDraftConfig({ projectId: EMPTY_PROJECT.id }));

    expect(fields.workspace.locked).toBe("Add a repository to the project to work in one");
  });

  it("blocks a draft with no account set up", () => {
    const fields = composeDraft(
      buildCatalogs([]),
      buildConfig({ providerAccountId: null, model: null, runnerId: null }),
    );

    // Nothing to sign in to: the one fix is a new account.
    expect(fields.blocked).toEqual({
      reason: "No account is set up",
      signIn: null,
      addAccount: true,
    });
  });

  it("blocks a draft when no runner is connected", () => {
    const fields = composeDraft(
      {
        accounts: [CLAUDE],
        runners: [],
        thisMacRunnerId: null,
        providers: PROVIDERS,
        harnesses: HARNESSES,
        modelProfiles: [PROFILE],
      },
      buildConfig({ runnerId: null }),
    );

    expect(fields.blocked).toEqual({
      reason: "No machine is connected",
      signIn: null,
      addAccount: false,
    });
  });

  it("blocks a draft whose only runner is retired, as if no runner were connected", () => {
    const retired = buildRunner({ id: "r-gone", name: "atlas", lifecycle: "retired" });
    const fields = composeDraft(
      {
        accounts: [CLAUDE],
        runners: [retired],
        thisMacRunnerId: null,
        providers: PROVIDERS,
        harnesses: HARNESSES,
        modelProfiles: [PROFILE],
      },
      buildConfig({ runnerId: null }),
    );

    expect(fields.blocked).toEqual({
      reason: "No machine is connected",
      signIn: null,
      addAccount: false,
    });
    expect(fields.machine.label).toBe("no machine");
  });

  it("blocks a draft whose account is not on the runner it would run on", () => {
    const fields = composeDraft(
      buildCatalogs([NOT_HERE]),
      buildConfig({ providerAccountId: NOT_HERE.id, model: null, runnerId: null }),
    );

    expect(fields.blocked).toEqual({
      reason: "Anthropic is not on moss",
      signIn: null,
      addAccount: false,
    });
  });

  it("blocks a draft whose account is not signed in, naming the runner and including the sign-in target", () => {
    const fields = composeDraft(
      buildCatalogs([SIGNED_OUT]),
      buildConfig({ providerAccountId: SIGNED_OUT.id, model: null, runnerId: null }),
    );

    expect(fields.blocked).toEqual({
      reason: "Anthropic is not signed in on moss",
      signIn: {
        providerAccountId: SIGNED_OUT.id,
        runnerId: LOCAL.id,
        subject: "Anthropic on moss",
      },
      addAccount: false,
    });
  });

  it("blocks nothing when the account is signed in", () => {
    expect(composeDraft(buildCatalogs([CLAUDE]), buildConfig()).blocked).toBeNull();
  });

  it("has no options when the current model declares none, and has them when it does", () => {
    expect(
      composeDraft(buildCatalogs([CLAUDE]), buildConfig({ model: HAIKU.model })).options,
    ).toBeNull();
    expect(composeDraft(buildCatalogs([CLAUDE]), buildConfig()).options).not.toBeNull();
  });

  it("says whether the selected model takes images, and fails closed on a model it cannot find", () => {
    const textOnly = buildProfileEntry(ANTHROPIC_IDENTITY, "glm-5.3", {
      name: "GLM 5.3",
      imageInput: null,
    });
    const catalogs = {
      ...buildCatalogs([CLAUDE]),
      modelProfiles: [
        buildModelProfile([buildProfileSection(ANTHROPIC_IDENTITY, [SONNET, textOnly])]),
      ],
    };
    const readModel = (model: string) => composeDraft(catalogs, buildConfig({ model })).model;

    expect(readModel(SONNET.model)).toMatchObject({
      imageInput: { maxBytes: null },
      modelName: "Claude Sonnet 5",
    });
    expect(readModel("glm-5.3")).toMatchObject({ imageInput: null, modelName: "GLM 5.3" });
    expect(readModel("gone-model")).toMatchObject({
      imageInput: null,
      modelName: "gone-model",
    });
  });

  it("names no account in the pill when the provider has one account", () => {
    expect(composeDraft(buildCatalogs([CLAUDE]), buildConfig()).model.pill).toEqual({
      harnessId: "claude-code/claude-code",
      account: null,
      name: "Claude Sonnet 5",
    });
  });

  it("names the account in the pill when the provider has more than one", () => {
    const fields = composeDraft(
      buildCatalogs([WORK, PERSONAL]),
      buildConfig({ providerAccountId: PERSONAL.id }),
    );

    expect(fields.model.pill).toEqual({
      harnessId: "claude-code/claude-code",
      account: "Anthropic · personal",
      name: "Claude Sonnet 5",
    });
  });
});

describe("buildComposerFields: the access mode", () => {
  it("returns the current mode and the four rows the menu offers", () => {
    const fields = composeDraft(buildCatalogs([CLAUDE]), buildConfig());

    expect(fields.accessMode.value).toBe("approval-required");
    expect(fields.accessMode.rows.map((row) => row.mode)).toEqual([
      "approval-required",
      "auto-accept-edits",
      "auto",
      "full-access",
    ]);
  });

  it("offers no modes while no account is set up, because there is no harness to ask", () => {
    const fields = composeDraft(buildCatalogs([]), buildConfig({ providerAccountId: null }));

    expect(fields.accessMode.rows).toEqual([]);
  });
});

describe("buildComposerFields: the runner", () => {
  it("names the runner the thread would be placed on", () => {
    expect(composeDraft(buildCatalogs([CLAUDE]), buildConfig()).machine.label).toBe("moss");
  });

  it("returns every runner as a row, marking the current one", () => {
    const fields = composeDraft(buildCatalogs([CLAUDE]), buildConfig());

    expect(fields.machine.rows.map((row) => row.runnerId)).toEqual([LOCAL.id]);
    expect(fields.machine.rows.filter((row) => row.current).map((row) => row.runnerId)).toEqual([
      LOCAL.id,
    ]);
  });

  it("adds the reason the current runner is dimmed to its label", () => {
    const fields = composeDraft(
      buildCatalogs([SIGNED_OUT]),
      buildConfig({ providerAccountId: SIGNED_OUT.id }),
    );

    expect(fields.machine.label).toBe("moss · not signed in");
  });

  it("blocks a draft on a runner that was retired after the user picked it, and says so in its label", () => {
    const retired = { ...LOCAL, lifecycle: "retired" as const, connectivity: "offline" as const };
    const fields = composeDraft(
      {
        accounts: [CLAUDE],
        runners: [retired],
        thisMacRunnerId: null,
        providers: PROVIDERS,
        harnesses: HARNESSES,
        modelProfiles: [PROFILE],
      },
      buildConfig({ runnerId: retired.id }),
    );

    expect(fields.blocked).toEqual({ reason: "moss is retired", signIn: null, addAccount: false });
    expect(fields.machine.label).toBe("moss · retired");
  });

  it("shows no machine when there are no runners", () => {
    const fields = composeDraft(
      {
        accounts: [CLAUDE],
        runners: [],
        thisMacRunnerId: null,
        providers: PROVIDERS,
        harnesses: HARNESSES,
        modelProfiles: [PROFILE],
      },
      buildConfig({ runnerId: null }),
    );

    expect(fields.machine.label).toBe("no machine");
  });
});

describe("buildComposerFields: a runner the user picked", () => {
  const COVE = buildRunner({ id: "r-cove", name: "cove" });
  const both = (account: ProviderAccount, cove: Runner = COVE) => ({
    accounts: [account],
    runners: [LOCAL, cove],
    thisMacRunnerId: LOCAL.id,
    providers: PROVIDERS,
    harnesses: HARNESSES,
    modelProfiles: [PROFILE],
  });
  const onCove: ThreadPicks = { runnerId: COVE.id };
  const INSTALLED = buildProviderAccount(
    ANTHROPIC_IDENTITY,
    [],
    [{ runnerId: LOCAL.id }, { runnerId: COVE.id }],
  );

  it.each([
    ["offline", { connectivity: "offline" as const }],
    ["unreachable", { connectivity: "unreachable" as const }],
    ["draining", { lifecycle: "draining" as const }],
  ])("stays the runner while it is %s, and the blocker names it", (state, overrides) => {
    const fields = composeDraft(both(INSTALLED, { ...COVE, ...overrides }), buildConfig(), onCove);

    expect(fields.machine.runnerId).toBe(COVE.id);
    expect(fields.machine.label).toBe(`cove · ${state}`);
    expect(fields.blocked).toEqual({ reason: `cove is ${state}`, signIn: null, addAccount: false });
  });

  it("stays the runner when the account picked has the harness there but is signed out, and offers the sign-in", () => {
    const signedOutOnCove = buildProviderAccount(
      ANTHROPIC_IDENTITY,
      [],
      [{ runnerId: LOCAL.id }, { runnerId: COVE.id, state: "not-signed-in" }],
    );
    const fields = composeDraft(both(signedOutOnCove), buildConfig(), {
      ...onCove,
      providerAccountId: signedOutOnCove.id,
    });

    expect(fields.machine.runnerId).toBe(COVE.id);
    expect(fields.blocked).toEqual({
      reason: "Anthropic is not signed in on cove",
      signIn: {
        providerAccountId: signedOutOnCove.id,
        runnerId: COVE.id,
        subject: "Anthropic on cove",
      },
      addAccount: false,
    });
  });

  it("gives way to the account's default runner when the account's harness is not on the picked one", () => {
    const onLocalOnly = buildProviderAccount(
      ANTHROPIC_IDENTITY,
      [],
      [{ runnerId: LOCAL.id }, { runnerId: COVE.id, state: "harness-missing" }],
    );
    const fields = composeDraft(both(onLocalOnly), buildConfig(), onCove);

    expect(fields.machine.runnerId).toBe(LOCAL.id);
    expect(fields.blocked).toBeNull();
  });
});

describe("buildComposerFields: the lead", () => {
  it("returns the draft's lead sentence, and none for an active thread", () => {
    expect(joinPhraseText(composeDraft(buildCatalogs([CLAUDE]), buildConfig()).lead ?? [])).toBe(
      "It works without a checkout.",
    );
    expect(
      composeActive(buildCatalogs([CLAUDE]), {
        ...buildThread("s1", "A thread"),
        workspaceId: null,
      }).lead,
    ).toBeNull();
  });
});

describe("buildPendingModelNote", () => {
  const catalogs = buildCatalogs([CLAUDE]);
  const session = { ...buildThread("s1", "A thread"), workspaceId: null };
  const resolve = (picks: ThreadPicks) =>
    resolveThreadConfig(catalogs, { kind: "active", session }, picks);

  it("says the change applies on send while an active thread has an unsent model pick", () => {
    expect(buildPendingModelNote(resolve({ model: HAIKU.model }))).toBe(
      "model change applies on send",
    );
  });

  it("returns null when the picked model is the one the thread runs", () => {
    expect(buildPendingModelNote(resolve({ model: SONNET.model }))).toBeNull();
  });

  it("returns null for a draft, whose picks are sent with its first message", () => {
    expect(
      buildPendingModelNote(
        resolveThreadConfig(
          catalogs,
          { kind: "draft", config: buildConfig() },
          { model: HAIKU.model },
        ),
      ),
    ).toBeNull();
  });

  it("returns null when only the options were picked, because the model is not changing", () => {
    expect(buildPendingModelNote(resolve({ options: { effort: "high" } }))).toBeNull();
  });
});

/**
 * The workspace a draft opens in, and the lead sentence shown above the draft
 * once a workspace is picked (#72).
 *
 * The types these tests rely on:
 *
 * - `ThreadCatalogs` has `projects`, `resources` and `workspaces`, the records
 *   the composer's menus read, next to the runners and accounts.
 * - `ThreadConfig` has `projectId`, `workspace` and `preferredWorkspace`.
 *   `workspace` is the pick: the contract's `SpawnWorkspace`, plus
 *   `{ kind: "none" }` for a thread with no checkout. `null` means the user has
 *   picked nothing and the default applies. `preferredWorkspace` is the stored
 *   `thread.workspace` setting, or `null` when it is unset.
 * - `composeDraft(...).workspace.value` is the pick that actually
 *   applies: the config's pick when it has one, and the default otherwise.
 * - A repo's short name is the last segment of its `canonicalRemote`; every
 *   sentence and row below uses it.
 */
const OTHER = buildRunner({ id: "r-other", name: "cove" });

const at = "2026-09-10T09:00:00.000Z";

const WEBSHOP_PROJECT: Project = {
  id: "p-webshop",
  name: "webshop",
  createdAt: at,
  updatedAt: at,
};

const OPS_PROJECT: Project = { id: "p-ops", name: "ops", createdAt: at, updatedAt: at };

/** A project with no repos. */
const EMPTY_PROJECT: Project = { id: "p-empty", name: "sandbox", createdAt: at, updatedAt: at };

/**
 * Returns a repo resource, with both the remote and the canonical remote given
 * explicitly. Neither is derived from the other, because canonicalizing a
 * remote is the controller's rule.
 */
const buildRepo = (
  id: string,
  remote: string,
  canonicalRemote: string,
  projectIds: readonly string[],
): Resource => ({
  id,
  kind: "repo",
  remote,
  canonicalRemote,
  label: null,
  connectionId: "conn-github",
  setupCommand: null,
  workspaceInclude: true,
  projectIds,
  createdAt: at,
  updatedAt: at,
});

const WEBSHOP = buildRepo(
  "res-webshop",
  "git@github.com:acme/webshop.git",
  "github.com/acme/webshop",
  [WEBSHOP_PROJECT.id],
);
const INFRA = buildRepo(
  "res-infra",
  "git@github.com:acme/ops-infra.git",
  "github.com/acme/ops-infra",
  [OPS_PROJECT.id],
);
const RUNBOOKS = buildRepo(
  "res-runbooks",
  "git@github.com:acme/ops-runbooks.git",
  "github.com/acme/ops-runbooks",
  [OPS_PROJECT.id],
);

/** webshop's main workspace on the local machine, sitting on `main`. */
const PRIMARY: Workspace = {
  id: "ws-primary",
  runnerId: LOCAL.id,
  kind: "primary",
  status: "ready",
  ownership: "managed",
  retentionPolicy: "manual",
  path: null,
  observedAt: null,
  warnings: [],
  checkouts: [
    {
      checkoutId: "co-primary",
      resourceId: WEBSHOP.id,
      form: "clone",
      subdirectory: null,
      branch: "main",
      branches: ["main", "release/2.4"],
      defaultBranch: "main",
      remoteBranches: [],
      headCommit: null,
      baseCommit: null,
      startingRevision: null,
      baseBranch: null,
    },
  ],
  designatedConnectionId: "conn-github",
  message: null,
  sessionIds: [],
  keptUntil: null,
  createdAt: at,
  provisionedAt: at,
  lastUsedAt: at,
  disposedAt: null,
};

/** A live worktree of webshop, which another thread is already working in. */
const THREAD_3F1: Workspace = {
  ...PRIMARY,
  id: "ws-thread-3f1",
  kind: "ephemeral",
  checkouts: [
    {
      checkoutId: "co-thread-3f1",
      resourceId: WEBSHOP.id,
      form: "worktree",
      subdirectory: null,
      branch: "hercule/thread-3f1",
      branches: ["hercule/thread-3f1"],
      defaultBranch: "main",
      remoteBranches: [],
      headCommit: null,
      baseCommit: null,
      startingRevision: null,
      baseBranch: null,
    },
  ],
  sessionIds: ["s-flaky", "s-runbook"],
};

/** Returns a thread working in `THREAD_3F1`, as the session list has it. */
const buildThread = (id: string, title: string): Session => ({
  id,
  title,
  kind: "thread",
  role: null,
  status: "idle",
  resumable: false,
  resumeHeld: false,
  toolCalls: 0,
  permissionProfileId: "profile-unrestricted",
  agentId: null,
  conversationId: null,
  runId: null,
  stepId: null,
  providerAccountId: CLAUDE.id,
  harnessId: CLAUDE.defaultHarnessId,
  runnerId: LOCAL.id,
  workspaceId: "ws-thread-3f1",
  projectId: WEBSHOP_PROJECT.id,
  requestedAccessMode: "approval-required",
  accessMode: "approval-required",
  nativeSessionId: null,
  modelSelection: { model: "claude-sonnet-5", options: {} },
  parentSessionId: null,
  openRequests: [],
  openPermissionRequests: [],
  createdAt: at,
  startedAt: at,
  exitedAt: null,
  lastActivityAt: at,
  unenforced: [],
});

const SESSIONS = [
  buildThread("s-flaky", "Fix flaky webhook tests"),
  buildThread("s-runbook", "Write the retry runbook"),
  buildThread("s-third", "Bump the Bun pin"),
];

const withRepos = (
  projects: readonly Project[],
  resources: readonly Resource[],
  workspaces: readonly Workspace[] = [PRIMARY, THREAD_3F1],
) => ({
  accounts: [CLAUDE],
  runners: [LOCAL, OTHER],
  thisMacRunnerId: LOCAL.id,
  providers: PROVIDERS,
  harnesses: HARNESSES,
  modelProfiles: [PROFILE],
  projects,
  resources,
  workspaces,
  // The threads in the workspaces, which the lead of a draft joining one names.
  sessions: SESSIONS,
});

/** The catalogs every test below uses unless it says otherwise. */
const FULL = withRepos([WEBSHOP_PROJECT, OPS_PROJECT, EMPTY_PROJECT], [WEBSHOP, INFRA, RUNBOOKS]);

const buildDraftConfig = (overrides: Record<string, unknown> = {}) =>
  buildConfig({ projectId: null, workspace: null, preferredWorkspace: null, ...overrides });

describe("buildComposerFields: the workspace a draft defaults to", () => {
  it("uses separate files in a project with one repo", () => {
    const fields = composeDraft(FULL, buildDraftConfig({ projectId: WEBSHOP_PROJECT.id }));

    expect(fields.workspace.value).toEqual({
      kind: "ephemeral",
      checkouts: [{ resourceId: WEBSHOP.id }],
    });
  });

  it("uses a worktree of each repo in a project with several repos", () => {
    const fields = composeDraft(FULL, buildDraftConfig({ projectId: OPS_PROJECT.id }));

    expect(fields.workspace.value).toEqual({
      kind: "ephemeral",
      checkouts: [{ resourceId: INFRA.id }, { resourceId: RUNBOOKS.id }],
    });
  });

  it("follows the stored thread.workspace setting over the repo count", () => {
    const fields = composeDraft(
      FULL,
      buildDraftConfig({ projectId: WEBSHOP_PROJECT.id, preferredWorkspace: "ephemeral" }),
    );

    expect(fields.workspace.value).toEqual({
      kind: "ephemeral",
      checkouts: [{ resourceId: WEBSHOP.id }],
    });
  });

  // A stored `none` is ignored: a project with a repo uses the default rule.
  it("ignores a stored none in a project with a repo", () => {
    const fields = composeDraft(
      FULL,
      buildDraftConfig({ projectId: WEBSHOP_PROJECT.id, preferredWorkspace: "none" }),
    );

    expect(fields.workspace.value).toEqual({
      kind: "ephemeral",
      checkouts: [{ resourceId: WEBSHOP.id }],
    });
  });

  it("works without a checkout when the stored setting is none and there is no repo", () => {
    const fields = composeDraft(
      FULL,
      buildDraftConfig({ projectId: EMPTY_PROJECT.id, preferredWorkspace: "none" }),
    );

    expect(fields.workspace.value).toEqual({ kind: "none" });
  });

  it("works without a checkout in a project with no repo, whatever the setting", () => {
    const fields = composeDraft(
      FULL,
      buildDraftConfig({ projectId: EMPTY_PROJECT.id, preferredWorkspace: "primary" }),
    );

    expect(fields.workspace.value).toEqual({ kind: "none" });
  });

  it("works without a checkout for a draft with no project", () => {
    const fields = composeDraft(FULL, buildDraftConfig({ preferredWorkspace: "primary" }));

    expect(fields.workspace.value).toEqual({ kind: "none" });
  });

  it("keeps the pick the user made over the default", () => {
    const fields = composeDraft(
      FULL,
      buildDraftConfig({
        projectId: WEBSHOP_PROJECT.id,
        workspace: { kind: "existing", workspaceId: THREAD_3F1.id },
      }),
    );

    expect(fields.workspace.value).toEqual({ kind: "existing", workspaceId: THREAD_3F1.id });
  });
});

describe("buildComposerFields: every field uses the same runner", () => {
  it("uses the runner a draft would really be placed on when no runner is selectable", () => {
    // Nothing is signed in anywhere, so no row is selectable and the draft has
    // picked no runner. It would still be placed on the local runner, so the
    // lead sentence, the workspace menu and the branch list must all use that
    // runner rather than none.
    const catalogs = {
      ...FULL,
      accounts: [SIGNED_OUT],
      workspaces: [PRIMARY],
    };
    const fields = composeDraft(
      catalogs,
      buildDraftConfig({
        providerAccountId: SIGNED_OUT.id,
        runnerId: null,
        projectId: WEBSHOP_PROJECT.id,
      }),
    );

    expect(fields.machine.runnerId).toBe(LOCAL.id);
    expect(fields.machine.label).toBe("moss · not signed in");
    // The lead uses the main workspace on that same runner, rather than
    // showing nothing because no runner was picked.
    expect(joinPhraseText(fields.lead ?? [])).toBe(
      "It gets its own worktree of webshop, on a new branch from remote default.",
    );
  });
});

describe("buildComposerFields: the runner of a joined workspace", () => {
  it("names the workspace that decides the runner, while the draft can still change", () => {
    const fields = composeDraft(
      FULL,
      buildDraftConfig({
        projectId: WEBSHOP_PROJECT.id,
        workspace: { kind: "existing", workspaceId: THREAD_3F1.id },
      }),
    );

    expect(fields.machine.label).toBe("set by the workspace hercule/thread-3f1");
    expect(fields.machine.locked).toBe("The workspace it joins decides the machine");
  });

  it.each([
    ["provisioning", "The workspace it joins is still being set up"],
    ["failed", "The workspace it joins could not be set up"],
    ["deleted", "The workspace it joins was deleted"],
    ["lost", "The workspace it joins was lost when its machine was retired"],
  ] as const)("blocks a draft that joins a workspace that is %s, saying why", (status, reason) => {
    const fields = composeDraft(
      withRepos(FULL.projects, FULL.resources, [PRIMARY, { ...THREAD_3F1, status }]),
      buildDraftConfig({
        projectId: WEBSHOP_PROJECT.id,
        workspace: { kind: "existing", workspaceId: THREAD_3F1.id },
      }),
    );

    expect(fields.blocked).toEqual({ reason, signIn: null, addAccount: false });
  });

  it("names the runner on an active thread, locked because the thread started", () => {
    const fields = composeActive(FULL, buildThread("s-flaky", "Fix flaky webhook tests"));

    expect(fields.machine.label).toBe("moss");
    expect(fields.machine.locked).toBe("Create a new thread to change the machine");
  });
});

describe("buildComposerFields: the lead sentence follows the workspace", () => {
  it("names the repo, the runner and the branch for the main workspace", () => {
    const fields = composeDraft(
      FULL,
      buildDraftConfig({
        projectId: WEBSHOP_PROJECT.id,
        workspace: { kind: "primary", resourceId: WEBSHOP.id, branch: "release/2.4" },
      }),
    );

    expect(joinPhraseText(fields.lead ?? [])).toBe(
      "It works in the main workspace of webshop on moss, on main. You and the agent share the files.",
    );
  });

  it("uses the main workspace's current branch when the draft has picked none", () => {
    const fields = composeDraft(
      FULL,
      buildDraftConfig({
        projectId: WEBSHOP_PROJECT.id,
        workspace: { kind: "primary", resourceId: WEBSHOP.id },
      }),
    );

    expect(joinPhraseText(fields.lead ?? [])).toBe(
      "It works in the main workspace of webshop on moss, on main. You and the agent share the files.",
    );
  });

  it("names the repo and the base branch for a new worktree", () => {
    const fields = composeDraft(
      FULL,
      buildDraftConfig({
        projectId: WEBSHOP_PROJECT.id,
        workspace: {
          kind: "ephemeral",
          checkouts: [{ resourceId: WEBSHOP.id, baseBranch: "release/2.4" }],
        },
      }),
    );

    expect(joinPhraseText(fields.lead ?? [])).toBe(
      "It gets its own worktree of webshop, on a new branch from remote branch release/2.4.",
    );
  });

  it("falls back to the repo's default branch as the base when the draft has picked none", () => {
    const fields = composeDraft(
      FULL,
      buildDraftConfig({
        projectId: WEBSHOP_PROJECT.id,
        workspace: { kind: "ephemeral", checkouts: [{ resourceId: WEBSHOP.id }] },
      }),
    );

    expect(joinPhraseText(fields.lead ?? [])).toBe(
      "It gets its own worktree of webshop, on a new branch from remote default.",
    );
  });

  // The lead names the threads the draft joins, not the workspace's name.
  it("names the threads the draft joins, and what joining them means", () => {
    const fields = composeDraft(
      FULL,
      buildDraftConfig({
        projectId: WEBSHOP_PROJECT.id,
        workspace: { kind: "existing", workspaceId: THREAD_3F1.id },
      }),
    );

    expect(joinPhraseText(fields.lead ?? [])).toBe(
      "It joins “Fix flaky webhook tests” and “Write the retry runbook” there: the agents see each other's edits, on one branch.",
    );
  });

  // At most two titles; the rest are counted.
  it("counts the threads past the second rather than naming them all", () => {
    const three = { ...THREAD_3F1, sessionIds: ["s-flaky", "s-runbook", "s-third"] };
    const fields = composeDraft(
      withRepos([WEBSHOP_PROJECT], [WEBSHOP], [PRIMARY, three]),
      buildDraftConfig({
        projectId: WEBSHOP_PROJECT.id,
        workspace: { kind: "existing", workspaceId: three.id },
      }),
    );

    expect(joinPhraseText(fields.lead ?? [])).toBe(
      "It joins “Fix flaky webhook tests”, “Write the retry runbook” and 1 more there: the agents see each other's edits, on one branch.",
    );
  });

  // A workspace with no threads has none to name, so the lead names the workspace.
  it("names the workspace itself when it has no threads yet", () => {
    const empty = { ...THREAD_3F1, sessionIds: [] };
    const fields = composeDraft(
      withRepos([WEBSHOP_PROJECT], [WEBSHOP], [PRIMARY, empty]),
      buildDraftConfig({
        projectId: WEBSHOP_PROJECT.id,
        workspace: { kind: "existing", workspaceId: empty.id },
      }),
    );

    expect(joinPhraseText(fields.lead ?? [])).toBe(
      "It joins “hercule/thread-3f1” there: the agents see each other's edits, on one branch.",
    );
  });

  // A thread works without a checkout when the project has no repo.
  it("says a thread with no checkout works without one", () => {
    const fields = composeDraft(
      FULL,
      buildDraftConfig({ projectId: EMPTY_PROJECT.id, preferredWorkspace: "none" }),
    );

    expect(joinPhraseText(fields.lead ?? [])).toBe("It works without a checkout.");
  });
});

describe("describeMachineRow", () => {
  const ROW: MachineRow = {
    runnerId: "r-local",
    name: "moss",
    state: "online",
    isLocal: false,
    reserved: false,
    identity: null,
    planLabel: null,
    dimmed: null,
    current: false,
    isDefault: false,
    capacity: "0/4",
    notCloned: null,
  };

  it("says what kind of machine the row is, then why it is dimmed or slower", () => {
    expect(
      describeMachineRow({
        ...ROW,
        isLocal: true,
        isDefault: true,
        reserved: true,
        dimmed: "not signed in",
        notCloned: "webshop is not cloned there · clones on first use",
      }),
    ).toBe(
      "this machine · default · reserved · not signed in · webshop is not cloned there · clones on first use",
    );
  });

  it("returns an empty line for a plain machine", () => {
    expect(describeMachineRow(ROW)).toBe("");
  });
});

describe("buildComposerFields: the model's profile entry", () => {
  it("offers a model's options and name from its profile entry, whatever runner the draft is placed on", () => {
    const WITH_PI = buildRunner({
      id: "r-pi",
      name: "pi-box",
      facts: {
        ...BARE.facts!,
        harnesses: [{ name: "pi", present: true, path: "/usr/local/bin/pi" }],
        adapters: ["pi/pi"],
      },
    });
    const zai = buildProviderAccount(ZAI_IDENTITY, [], [{ runnerId: WITH_PI.id }]);
    const entry = buildProfileEntry(ZAI_IDENTITY, SONNET.model, {
      name: SONNET.name,
      options: [EFFORT],
    });
    const fields = composeDraft(
      {
        ...buildCatalogs([zai]),
        runners: [WITH_PI],
        thisMacRunnerId: WITH_PI.id,
        modelProfiles: [buildModelProfile([buildProfileSection(ZAI_IDENTITY, [entry])])],
      },
      buildConfig({ providerAccountId: zai.id, runnerId: WITH_PI.id, model: SONNET.model }),
    );

    expect(fields.blocked).toBeNull();
    expect(fields.options?.map((option) => option.id)).toEqual(["effort"]);
    expect(fields.model.modelName).toBe("Claude Sonnet 5");
  });
});
