/**
 * Tests `buildComposerFields(catalogs, config, kind)`, which decides every
 * lock, dimmed state and blocker the composer shows, so no component holds a
 * reason string. The tests check that:
 *
 * - an active thread's fields are locked, with a sentence that says why, and
 *   the model is never locked;
 * - a draft that cannot start says why, and includes the login it needs;
 * - a draft cannot join a workspace that is not ready, or run on a retired
 *   runner;
 * - the model pill names the account only when the provider has more than
 *   one instance.
 */
import { describe, expect, it } from "vitest";
import type {
  ModelOption,
  Project,
  ProviderInstance,
  Resource,
  Runner,
  Session,
  Workspace,
} from "@hercule/contract";
import { BARE, buildInstance, buildSnapshot } from "../providers.testing";
import {
  buildComposerFields,
  buildPendingModelNote,
  describeMachineRow,
  type MachineRow,
} from "./composer-fields";
import { joinPhraseText } from "./workspaces";

const buildRunner = (overrides: Partial<Runner> & { id: string }): Runner => ({
  ...BARE,
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

const SONNET = {
  slug: "claude-sonnet-5",
  name: "Claude Sonnet 5",
  isDefault: true,
  options: [EFFORT],
};
const HAIKU = { slug: "claude-haiku-5", name: "Claude Haiku 5", options: [] };

const CLAUDE = buildInstance("claude-code", "Claude Code", [
  buildSnapshot({ runnerId: LOCAL.id, models: [SONNET, HAIKU] }),
]);

/** Returns another instance of the same provider, so the pill has an account to name. */
const buildNamedInstance = (id: string, name: string): ProviderInstance => ({
  ...CLAUDE,
  id,
  name,
});

const WORK = buildNamedInstance("instance-claude-work", "work");
const PERSONAL = buildNamedInstance("instance-claude-personal", "personal");

/** Probed on no runner: the instance exists, but it has no catalog. */
const NOT_HERE = buildInstance("claude-code", "Claude Code", []);

const LOGGED_OUT = buildInstance("claude-code", "Claude Code", [
  buildSnapshot({ runnerId: LOCAL.id, auth: { status: "unauthenticated" }, models: [] }),
]);

const buildCatalogs = (instances: readonly ProviderInstance[]) => ({
  instances,
  runners: [LOCAL],
  thisMacRunnerId: LOCAL.id,
});

const buildConfig = (overrides: Record<string, unknown> = {}) => ({
  instanceId: CLAUDE.id,
  model: SONNET.slug,
  accessMode: "approval-required" as const,
  runnerId: LOCAL.id,
  profileId: "p-unrestricted",
  options: {},
  ...overrides,
});

describe("buildComposerFields", () => {
  it("locks the access mode, the workspace and the runner on an active thread", () => {
    const fields = buildComposerFields(buildCatalogs([CLAUDE]), buildConfig(), "active");

    expect(fields.accessMode.locked).toBe("Create a new thread to change the access mode");
    expect(fields.workspace.locked).toBe("Create a new thread to change the workspace");
    expect(fields.machine.locked).toBe("Create a new thread to change the machine");
  });

  it("locks nothing a draft can still change", () => {
    const fields = buildComposerFields(buildCatalogs([CLAUDE]), buildConfig(), "draft");

    expect(fields.accessMode.locked).toBeNull();
    expect(fields.machine.locked).toBeNull();
    // With no repo there is no workspace to choose, so the field is locked,
    // and its reason says how to get one. For a draft with no project, that
    // is picking a project.
    expect(fields.workspace.locked).toBe("Pick a project to work in a repository");
  });

  it("tells the user to add a repository when the project has none", () => {
    const fields = buildComposerFields(
      FULL,
      buildDraftConfig({ projectId: EMPTY_PROJECT.id }),
      "draft",
    );

    expect(fields.workspace.locked).toBe("Add a repository to the project to work in one");
  });

  it("blocks a draft with no provider instance set up", () => {
    const fields = buildComposerFields(
      buildCatalogs([]),
      buildConfig({ instanceId: null, model: null, runnerId: null }),
      "draft",
    );

    expect(fields.blocked).toMatchObject({ reason: "No provider instance is set up" });
  });

  it("blocks a draft when no runner is connected", () => {
    const fields = buildComposerFields(
      { instances: [CLAUDE], runners: [], thisMacRunnerId: null },
      buildConfig({ runnerId: null }),
      "draft",
    );

    expect(fields.blocked).toEqual({ reason: "No machine is connected", login: null });
  });

  it("blocks a draft whose only runner is retired, as if no runner were connected", () => {
    const retired = buildRunner({ id: "r-gone", name: "atlas", lifecycle: "retired" });
    const fields = buildComposerFields(
      { instances: [CLAUDE], runners: [retired], thisMacRunnerId: null },
      buildConfig({ runnerId: null }),
      "draft",
    );

    expect(fields.blocked).toEqual({ reason: "No machine is connected", login: null });
    expect(fields.machine.label).toBe("no machine");
  });

  it("blocks a draft whose instance is not on the runner it would run on", () => {
    const fields = buildComposerFields(
      buildCatalogs([NOT_HERE]),
      buildConfig({ instanceId: NOT_HERE.id, model: null, runnerId: null }),
      "draft",
    );

    expect(fields.blocked).toEqual({ reason: "Claude Code is not on moss", login: null });
  });

  it("blocks a draft whose instance is not logged in, naming the runner and including the login target", () => {
    const fields = buildComposerFields(
      buildCatalogs([LOGGED_OUT]),
      buildConfig({ instanceId: LOGGED_OUT.id, model: null, runnerId: null }),
      "draft",
    );

    expect(fields.blocked).toEqual({
      reason: "Claude Code is on moss but not logged in",
      login: { instanceId: LOGGED_OUT.id, runnerId: LOCAL.id, subject: "Claude Code on moss" },
    });
  });

  it("blocks nothing when the instance is logged in", () => {
    expect(buildComposerFields(buildCatalogs([CLAUDE]), buildConfig(), "draft").blocked).toBeNull();
  });

  it("has no options when the current model declares none, and has them when it does", () => {
    expect(
      buildComposerFields(buildCatalogs([CLAUDE]), buildConfig({ model: HAIKU.slug }), "draft")
        .options,
    ).toBeNull();
    expect(
      buildComposerFields(buildCatalogs([CLAUDE]), buildConfig(), "draft").options,
    ).not.toBeNull();
  });

  it("names no account in the pill when the provider has one instance", () => {
    expect(buildComposerFields(buildCatalogs([CLAUDE]), buildConfig(), "draft").model.pill).toEqual(
      {
        providerId: "claude-code",
        account: null,
        name: "Claude Sonnet 5",
      },
    );
  });

  it("names the instance in the pill when the provider has more than one", () => {
    const fields = buildComposerFields(
      buildCatalogs([WORK, PERSONAL]),
      buildConfig({ instanceId: PERSONAL.id }),
      "draft",
    );

    expect(fields.model.pill).toEqual({
      providerId: "claude-code",
      account: "personal",
      name: "Claude Sonnet 5",
    });
  });
});

describe("buildComposerFields: the access mode", () => {
  it("returns the current mode and the four rows the menu offers", () => {
    const fields = buildComposerFields(buildCatalogs([CLAUDE]), buildConfig(), "draft");

    expect(fields.accessMode.value).toBe("approval-required");
    expect(fields.accessMode.rows.map((row) => row.mode)).toEqual([
      "approval-required",
      "auto-accept-edits",
      "auto",
      "full-access",
    ]);
  });

  it("offers no modes while no instance is set up, because there is no provider to ask", () => {
    const fields = buildComposerFields(
      buildCatalogs([]),
      buildConfig({ instanceId: null }),
      "draft",
    );

    expect(fields.accessMode.rows).toEqual([]);
  });
});

describe("buildComposerFields: the runner", () => {
  it("names the runner the thread would be placed on", () => {
    expect(buildComposerFields(buildCatalogs([CLAUDE]), buildConfig(), "draft").machine.label).toBe(
      "moss",
    );
  });

  it("returns every runner as a row, marking the current one", () => {
    const fields = buildComposerFields(buildCatalogs([CLAUDE]), buildConfig(), "draft");

    expect(fields.machine.rows.map((row) => row.runnerId)).toEqual([LOCAL.id]);
    expect(fields.machine.rows.filter((row) => row.current).map((row) => row.runnerId)).toEqual([
      LOCAL.id,
    ]);
  });

  it("adds the reason the current runner is dimmed to its label", () => {
    const fields = buildComposerFields(
      buildCatalogs([LOGGED_OUT]),
      buildConfig({ instanceId: LOGGED_OUT.id }),
      "draft",
    );

    expect(fields.machine.label).toBe("moss · not logged in");
  });

  it("blocks a draft on a runner that was retired after the user picked it, and says so in its label", () => {
    const retired = { ...LOCAL, lifecycle: "retired" as const, connectivity: "offline" as const };
    const fields = buildComposerFields(
      { instances: [CLAUDE], runners: [retired], thisMacRunnerId: null },
      buildConfig({ runnerId: retired.id }),
      "draft",
    );

    expect(fields.blocked).toEqual({ reason: "moss is retired", login: null });
    expect(fields.machine.label).toBe("moss · retired");
  });

  it("shows no machine when there are no runners", () => {
    const fields = buildComposerFields(
      { instances: [CLAUDE], runners: [], thisMacRunnerId: null },
      buildConfig({ runnerId: null }),
      "draft",
    );

    expect(fields.machine.label).toBe("no machine");
  });
});

describe("buildComposerFields: the lead", () => {
  it("returns the draft's lead sentence, and none for an active thread", () => {
    expect(
      joinPhraseText(
        buildComposerFields(buildCatalogs([CLAUDE]), buildConfig(), "draft").lead ?? [],
      ),
    ).toBe("It works without a checkout.");
    expect(buildComposerFields(buildCatalogs([CLAUDE]), buildConfig(), "active").lead).toBeNull();
  });
});

describe("buildPendingModelNote", () => {
  it("says the change applies on send while an active thread has an unsent model pick", () => {
    expect(buildPendingModelNote("active", { model: "claude-opus-5" })).toBe(
      "model change applies on send",
    );
  });

  it("returns null for a draft, whose picks are sent with its first message", () => {
    expect(buildPendingModelNote("draft", { model: "claude-opus-5" })).toBeNull();
  });

  it("returns null when only the options were picked, because the model is not changing", () => {
    expect(buildPendingModelNote("active", { options: { effort: "high" } })).toBeNull();
  });
});

/**
 * The workspace a draft opens in, and the lead sentence shown above the draft
 * once a workspace is picked (#72).
 *
 * The types these tests rely on:
 *
 * - `ThreadCatalogs` has `projects`, `resources` and `workspaces`, the records
 *   the composer's menus read, next to the runners and instances.
 * - `ThreadConfig` has `projectId`, `workspace` and `preferredWorkspace`.
 *   `workspace` is the pick: the contract's `SpawnWorkspace`, plus
 *   `{ kind: "none" }` for a thread with no checkout. `null` means the user has
 *   picked nothing and the default applies. `preferredWorkspace` is the stored
 *   `thread.workspace` setting, or `null` when it is unset.
 * - `buildComposerFields(...).workspace.value` is the pick that actually
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
  checkouts: [
    {
      checkoutId: "co-primary",
      resourceId: WEBSHOP.id,
      form: "clone",
      subdirectory: null,
      branch: "main",
      branches: ["main", "release/2.4"],
      defaultBranch: "main",
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
      baseBranch: null,
    },
  ],
  sessionIds: ["s-flaky", "s-runbook"],
};

/** Returns a thread working in `THREAD_3F1`, as the session list has it. */
const buildThread = (id: string, title: string): Session => ({
  id,
  title,
  status: "idle",
  resumable: false,
  resumeHeld: false,
  permissionProfileId: "profile-unrestricted",
  agentId: null,
  conversationId: null,
  runId: null,
  stepId: null,
  instanceId: CLAUDE.id,
  runnerId: LOCAL.id,
  workspaceId: "ws-thread-3f1",
  projectId: WEBSHOP_PROJECT.id,
  requestedAccessMode: "approval-required",
  accessMode: "approval-required",
  nativeSessionId: null,
  modelSelection: { model: "claude-sonnet-5", options: {} },
  parentSessionId: null,
  openRequest: null,
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
  instances: [CLAUDE],
  runners: [LOCAL, OTHER],
  thisMacRunnerId: LOCAL.id,
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
  it("uses the main workspace in a project with one repo", () => {
    const fields = buildComposerFields(
      FULL,
      buildDraftConfig({ projectId: WEBSHOP_PROJECT.id }),
      "draft",
    );

    expect(fields.workspace.value).toEqual({ kind: "primary", resourceId: WEBSHOP.id });
  });

  it("uses a worktree of each repo in a project with several repos", () => {
    const fields = buildComposerFields(
      FULL,
      buildDraftConfig({ projectId: OPS_PROJECT.id }),
      "draft",
    );

    expect(fields.workspace.value).toEqual({
      kind: "ephemeral",
      checkouts: [{ resourceId: INFRA.id }, { resourceId: RUNBOOKS.id }],
    });
  });

  it("follows the stored thread.workspace setting over the repo count", () => {
    const fields = buildComposerFields(
      FULL,
      buildDraftConfig({ projectId: WEBSHOP_PROJECT.id, preferredWorkspace: "ephemeral" }),
      "draft",
    );

    expect(fields.workspace.value).toEqual({
      kind: "ephemeral",
      checkouts: [{ resourceId: WEBSHOP.id }],
    });
  });

  // A stored `none` is ignored: a project with a repo uses the default rule.
  it("ignores a stored none in a project with a repo", () => {
    const fields = buildComposerFields(
      FULL,
      buildDraftConfig({ projectId: WEBSHOP_PROJECT.id, preferredWorkspace: "none" }),
      "draft",
    );

    expect(fields.workspace.value).toEqual({ kind: "primary", resourceId: WEBSHOP.id });
  });

  it("works without a checkout when the stored setting is none and there is no repo", () => {
    const fields = buildComposerFields(
      FULL,
      buildDraftConfig({ projectId: EMPTY_PROJECT.id, preferredWorkspace: "none" }),
      "draft",
    );

    expect(fields.workspace.value).toEqual({ kind: "none" });
  });

  it("works without a checkout in a project with no repo, whatever the setting", () => {
    const fields = buildComposerFields(
      FULL,
      buildDraftConfig({ projectId: EMPTY_PROJECT.id, preferredWorkspace: "primary" }),
      "draft",
    );

    expect(fields.workspace.value).toEqual({ kind: "none" });
  });

  it("works without a checkout for a draft with no project", () => {
    const fields = buildComposerFields(
      FULL,
      buildDraftConfig({ preferredWorkspace: "primary" }),
      "draft",
    );

    expect(fields.workspace.value).toEqual({ kind: "none" });
  });

  it("keeps the pick the user made over the default", () => {
    const fields = buildComposerFields(
      FULL,
      buildDraftConfig({
        projectId: WEBSHOP_PROJECT.id,
        workspace: { kind: "existing", workspaceId: THREAD_3F1.id },
      }),
      "draft",
    );

    expect(fields.workspace.value).toEqual({ kind: "existing", workspaceId: THREAD_3F1.id });
  });
});

describe("buildComposerFields: every field uses the same runner", () => {
  it("uses the runner a draft would really be placed on when no runner is selectable", () => {
    // Nothing is logged in anywhere, so no row is selectable and the draft has
    // picked no runner. It would still be placed on the local runner, so the
    // lead sentence, the workspace menu and the branch list must all use that
    // runner rather than none.
    const catalogs = {
      ...FULL,
      instances: [LOGGED_OUT],
      workspaces: [PRIMARY],
    };
    const fields = buildComposerFields(
      catalogs,
      buildDraftConfig({
        instanceId: LOGGED_OUT.id,
        runnerId: null,
        projectId: WEBSHOP_PROJECT.id,
      }),
      "draft",
    );

    expect(fields.machine.runnerId).toBe(LOCAL.id);
    expect(fields.machine.label).toBe("moss · not logged in");
    // The lead uses the main workspace on that same runner, rather than
    // showing nothing because no runner was picked.
    expect(joinPhraseText(fields.lead ?? [])).toBe(
      "It works in the main workspace of webshop on moss, on main. You and the agent share the files.",
    );
  });
});

describe("buildComposerFields: the runner of a joined workspace", () => {
  it("names the workspace that decides the runner, while the draft can still change", () => {
    const fields = buildComposerFields(
      FULL,
      buildDraftConfig({
        projectId: WEBSHOP_PROJECT.id,
        workspace: { kind: "existing", workspaceId: THREAD_3F1.id },
      }),
      "draft",
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
    const fields = buildComposerFields(
      withRepos(FULL.projects, FULL.resources, [PRIMARY, { ...THREAD_3F1, status }]),
      buildDraftConfig({
        projectId: WEBSHOP_PROJECT.id,
        workspace: { kind: "existing", workspaceId: THREAD_3F1.id },
      }),
      "draft",
    );

    expect(fields.blocked).toEqual({ reason, login: null });
  });

  it("names the runner on an active thread, locked because the thread started", () => {
    const fields = buildComposerFields(
      FULL,
      buildDraftConfig({
        projectId: WEBSHOP_PROJECT.id,
        workspace: { kind: "existing", workspaceId: THREAD_3F1.id },
      }),
      "active",
    );

    expect(fields.machine.label).toBe("moss");
    expect(fields.machine.locked).toBe("Create a new thread to change the machine");
  });
});

describe("buildComposerFields: the lead sentence follows the workspace", () => {
  it("names the repo, the runner and the branch for the main workspace", () => {
    const fields = buildComposerFields(
      FULL,
      buildDraftConfig({
        projectId: WEBSHOP_PROJECT.id,
        workspace: { kind: "primary", resourceId: WEBSHOP.id, branch: "release/2.4" },
      }),
      "draft",
    );

    expect(joinPhraseText(fields.lead ?? [])).toBe(
      "It works in the main workspace of webshop on moss, on release/2.4. You and the agent share the files.",
    );
  });

  it("uses the main workspace's current branch when the draft has picked none", () => {
    const fields = buildComposerFields(
      FULL,
      buildDraftConfig({
        projectId: WEBSHOP_PROJECT.id,
        workspace: { kind: "primary", resourceId: WEBSHOP.id },
      }),
      "draft",
    );

    expect(joinPhraseText(fields.lead ?? [])).toBe(
      "It works in the main workspace of webshop on moss, on main. You and the agent share the files.",
    );
  });

  it("names the repo and the base branch for a new worktree", () => {
    const fields = buildComposerFields(
      FULL,
      buildDraftConfig({
        projectId: WEBSHOP_PROJECT.id,
        workspace: {
          kind: "ephemeral",
          checkouts: [{ resourceId: WEBSHOP.id, baseBranch: "release/2.4" }],
        },
      }),
      "draft",
    );

    expect(joinPhraseText(fields.lead ?? [])).toBe(
      "It gets its own worktree of webshop, on a new branch from release/2.4.",
    );
  });

  it("falls back to the repo's default branch as the base when the draft has picked none", () => {
    const fields = buildComposerFields(
      FULL,
      buildDraftConfig({
        projectId: WEBSHOP_PROJECT.id,
        workspace: { kind: "ephemeral", checkouts: [{ resourceId: WEBSHOP.id }] },
      }),
      "draft",
    );

    expect(joinPhraseText(fields.lead ?? [])).toBe(
      "It gets its own worktree of webshop, on a new branch from main.",
    );
  });

  // The lead names the threads the draft joins, not the workspace's name.
  it("names the threads the draft joins, and what joining them means", () => {
    const fields = buildComposerFields(
      FULL,
      buildDraftConfig({
        projectId: WEBSHOP_PROJECT.id,
        workspace: { kind: "existing", workspaceId: THREAD_3F1.id },
      }),
      "draft",
    );

    expect(joinPhraseText(fields.lead ?? [])).toBe(
      "It joins “Fix flaky webhook tests” and “Write the retry runbook” there: the agents see each other's edits, on one branch.",
    );
  });

  // At most two titles; the rest are counted.
  it("counts the threads past the second rather than naming them all", () => {
    const three = { ...THREAD_3F1, sessionIds: ["s-flaky", "s-runbook", "s-third"] };
    const fields = buildComposerFields(
      withRepos([WEBSHOP_PROJECT], [WEBSHOP], [PRIMARY, three]),
      buildDraftConfig({
        projectId: WEBSHOP_PROJECT.id,
        workspace: { kind: "existing", workspaceId: three.id },
      }),
      "draft",
    );

    expect(joinPhraseText(fields.lead ?? [])).toBe(
      "It joins “Fix flaky webhook tests”, “Write the retry runbook” and 1 more there: the agents see each other's edits, on one branch.",
    );
  });

  // A workspace with no threads has none to name, so the lead names the workspace.
  it("names the workspace itself when it has no threads yet", () => {
    const empty = { ...THREAD_3F1, sessionIds: [] };
    const fields = buildComposerFields(
      withRepos([WEBSHOP_PROJECT], [WEBSHOP], [PRIMARY, empty]),
      buildDraftConfig({
        projectId: WEBSHOP_PROJECT.id,
        workspace: { kind: "existing", workspaceId: empty.id },
      }),
      "draft",
    );

    expect(joinPhraseText(fields.lead ?? [])).toBe(
      "It joins “hercule/thread-3f1” there: the agents see each other's edits, on one branch.",
    );
  });

  // A thread works without a checkout when the project has no repo.
  it("says a thread with no checkout works without one", () => {
    const fields = buildComposerFields(
      FULL,
      buildDraftConfig({ projectId: EMPTY_PROJECT.id, preferredWorkspace: "none" }),
      "draft",
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
        dimmed: "not logged in",
        notCloned: "webshop is not cloned there · clones on first use",
      }),
    ).toBe(
      "this machine · default · reserved · not logged in · webshop is not cloned there · clones on first use",
    );
  });

  it("returns an empty line for a plain machine", () => {
    expect(describeMachineRow(ROW)).toBe("");
  });
});
