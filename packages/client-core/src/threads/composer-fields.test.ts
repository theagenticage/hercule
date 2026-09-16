/**
 * `composerFields(catalogs, config, kind)` is every lock, dimming and blocker
 * the composer shows, decided once here so no component holds a reason
 * string. What matters: an active thread's fields are locked with
 * the sentence that says why, the model is never one of them, a draft that cannot start says so and carries
 * the login it needs, and the pill names the account only when the provider
 * has more than one.
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
} from "@hydra/contract";
import { BARE, instance, snapshot } from "../providers.testing";
import { composerFields, pendingModelNote } from "./composer-fields";
import { phraseText } from "./workspaces";

const runner = (overrides: Partial<Runner> & { id: string }): Runner => ({
  ...BARE,
  ...overrides,
});

const LOCAL = runner({ id: "r-local", name: "moss" });

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

const CLAUDE = instance("claude-code", "Claude Code", [
  snapshot({ runnerId: LOCAL.id, models: [SONNET, HAIKU] }),
]);

/** A second instance of the same provider, so the pill has an account to name. */
const named = (id: string, name: string): ProviderInstance => ({
  ...CLAUDE,
  id,
  name,
});

const WORK = named("instance-claude-work", "work");
const PERSONAL = named("instance-claude-personal", "personal");

/** Probed on no machine at all: the instance exists, the catalog does not. */
const NOT_HERE = instance("claude-code", "Claude Code", []);

const LOGGED_OUT = instance("claude-code", "Claude Code", [
  snapshot({ runnerId: LOCAL.id, auth: { status: "unauthenticated" }, models: [] }),
]);

const catalogs = (instances: readonly ProviderInstance[]) => ({
  instances,
  runners: [LOCAL],
  localRunnerId: LOCAL.id,
});

const config = (overrides: Record<string, unknown> = {}) => ({
  instanceId: CLAUDE.id,
  model: SONNET.slug,
  accessMode: "approval-required" as const,
  runnerId: LOCAL.id,
  profileId: "p-unrestricted",
  options: {},
  ...overrides,
});

describe("composerFields", () => {
  it("locks the access mode, the workspace and the machine on an active thread", () => {
    const fields = composerFields(catalogs([CLAUDE]), config(), "active");

    expect(fields.accessMode.locked).toBe("Create a new thread to change the access mode");
    expect(fields.workspace.locked).toBe("Create a new thread to change the workspace");
    expect(fields.machine.locked).toBe("Create a new thread to change the machine");
  });

  it("locks nothing a draft can still change", () => {
    const fields = composerFields(catalogs([CLAUDE]), config(), "draft");

    expect(fields.accessMode.locked).toBeNull();
    expect(fields.machine.locked).toBeNull();
    // D-20d: with no repo to work in there is nothing to choose between, so
    // the workspace field is its value with the way out as its reason - and on
    // a draft standing in no project the way out is picking one (R5).
    expect(fields.workspace.locked).toBe("Pick a project to work in a repository");
  });

  it("names the repository as the way out where the project is the one that holds none", () => {
    const fields = composerFields(FULL, draft({ projectId: EMPTY_PROJECT.id }), "draft");

    expect(fields.workspace.locked).toBe("Add a repository to the project to work in one");
  });

  it("blocks a draft with no provider instance set up", () => {
    const fields = composerFields(
      catalogs([]),
      config({ instanceId: null, model: null, runnerId: null }),
      "draft",
    );

    expect(fields.blocked).toMatchObject({ reason: "no provider instance is set up" });
  });

  it("blocks a draft with no machine connected at all", () => {
    const fields = composerFields(
      { instances: [CLAUDE], runners: [], localRunnerId: null },
      config({ runnerId: null }),
      "draft",
    );

    expect(fields.blocked).toEqual({ reason: "no machine is connected", login: null });
  });

  it("blocks a draft whose instance is not on the machine it would run on", () => {
    const fields = composerFields(
      catalogs([NOT_HERE]),
      config({ instanceId: NOT_HERE.id, model: null, runnerId: null }),
      "draft",
    );

    expect(fields.blocked).toEqual({ reason: "Claude Code is not on moss", login: null });
  });

  it("blocks a draft whose instance is not logged in, naming the machine and carrying the login target", () => {
    const fields = composerFields(
      catalogs([LOGGED_OUT]),
      config({ instanceId: LOGGED_OUT.id, model: null, runnerId: null }),
      "draft",
    );

    expect(fields.blocked).toEqual({
      reason: "Claude Code is on moss but not logged in",
      login: { instanceId: LOGGED_OUT.id, runnerId: LOCAL.id, subject: "Claude Code on moss" },
    });
  });

  it("blocks nothing when the instance is logged in", () => {
    expect(composerFields(catalogs([CLAUDE]), config(), "draft").blocked).toBeNull();
  });

  it("has no options field when the current model declares no descriptors, and one when it does", () => {
    expect(
      composerFields(catalogs([CLAUDE]), config({ model: HAIKU.slug }), "draft").options,
    ).toBeNull();
    expect(composerFields(catalogs([CLAUDE]), config(), "draft").options).not.toBeNull();
  });

  it("names no account in the pill when the provider has one instance", () => {
    expect(composerFields(catalogs([CLAUDE]), config(), "draft").model.pill).toEqual({
      providerId: "claude-code",
      account: null,
      name: "Claude Sonnet 5",
    });
  });

  it("names the instance in the pill when the provider has more than one", () => {
    const fields = composerFields(
      catalogs([WORK, PERSONAL]),
      config({ instanceId: PERSONAL.id }),
      "draft",
    );

    expect(fields.model.pill).toEqual({
      providerId: "claude-code",
      account: "personal",
      name: "Claude Sonnet 5",
    });
  });
});

describe("composerFields: the access mode", () => {
  it("carries the mode in force and the four rows the menu offers under it", () => {
    const fields = composerFields(catalogs([CLAUDE]), config(), "draft");

    expect(fields.accessMode.value).toBe("approval-required");
    expect(fields.accessMode.rows.map((row) => row.mode)).toEqual([
      "approval-required",
      "auto-accept-edits",
      "auto",
      "full-access",
    ]);
  });

  it("offers no mode at all while no instance is set up, there being no provider to ask", () => {
    const fields = composerFields(catalogs([]), config({ instanceId: null }), "draft");

    expect(fields.accessMode.rows).toEqual([]);
  });
});

describe("composerFields: the machine", () => {
  it("names the machine the thread would be placed on", () => {
    expect(composerFields(catalogs([CLAUDE]), config(), "draft").machine.label).toBe("moss");
  });

  it("carries the fleet as rows, marking the machine in force", () => {
    const fields = composerFields(catalogs([CLAUDE]), config(), "draft");

    expect(fields.machine.rows.map((row) => row.runnerId)).toEqual([LOCAL.id]);
    expect(fields.machine.rows.filter((row) => row.current).map((row) => row.runnerId)).toEqual([
      LOCAL.id,
    ]);
  });

  it("names the machine in force with the reason it is dimmed, since its menu is shut", () => {
    const fields = composerFields(
      catalogs([LOGGED_OUT]),
      config({ instanceId: LOGGED_OUT.id }),
      "draft",
    );

    expect(fields.machine.label).toBe("moss · not logged in");
  });

  it("says there is no machine to name when the fleet holds none", () => {
    const fields = composerFields(
      { instances: [CLAUDE], runners: [], localRunnerId: null },
      config({ runnerId: null }),
      "draft",
    );

    expect(fields.machine.label).toBe("no machine");
  });
});

describe("composerFields: the lead", () => {
  it("carries the draft's sentence, and none on a thread that has started", () => {
    expect(phraseText(composerFields(catalogs([CLAUDE]), config(), "draft").lead ?? [])).toBe(
      "It works without a checkout.",
    );
    expect(composerFields(catalogs([CLAUDE]), config(), "active").lead).toBeNull();
  });
});

describe("pendingModelNote", () => {
  it("says the change applies on send while an active thread holds an unsent model pick", () => {
    expect(pendingModelNote("active", { model: "claude-opus-5" })).toBe(
      "model change applies on send",
    );
  });

  it("says nothing on a draft, whose picks go out with the thread's first message", () => {
    expect(pendingModelNote("draft", { model: "claude-opus-5" })).toBeNull();
  });

  it("says nothing when only the options were picked: the model itself is not changing", () => {
    expect(pendingModelNote("active", { options: { effort: "high" } })).toBeNull();
  });
});

/**
 * Slice 3 of #72 (AC-17): the workspace a draft opens in, and the sentence the
 * draft stands under once it is picked.
 *
 * Shapes this file fixes, where the SPEC names a value but not a signature:
 * - `ThreadCatalogs` gains `projects`, `resources` and `workspaces`, the three
 *   records the composer's own menu reads (the fleet and the instances are
 *   already there).
 * - `ThreadConfig` gains `projectId`, `workspace` and `preferredWorkspace`.
 *   `workspace` is the pick, in the contract's own `SpawnWorkspace` spelling
 *   plus a fourth kind `{ kind: "none" }` for a thread with no checkout; `null`
 *   means the user has picked nothing and the default stands.
 *   `preferredWorkspace` is the `thread.workspace` setting as stored, `null`
 *   when it is unset.
 * - `composerFields(...).workspace.value` is the pick that is really in force:
 *   the config's own when it has one, the default otherwise.
 * - A repo's short name is the last segment of its `canonicalRemote`, which is
 *   what every sentence and row below calls it.
 */
const OTHER = runner({ id: "r-other", name: "cove" });

const at = "2026-09-10T09:00:00.000Z";

const WEBSHOP_PROJECT: Project = {
  id: "p-webshop",
  name: "webshop",
  createdAt: at,
  updatedAt: at,
};

const OPS_PROJECT: Project = { id: "p-ops", name: "ops", createdAt: at, updatedAt: at };

/** A project with a name and nothing filed under it. */
const EMPTY_PROJECT: Project = { id: "p-empty", name: "sandbox", createdAt: at, updatedAt: at };

/** Both spellings of the remote are written out; neither is derived from the
 * other, because canonicalizing a remote is the system's rule to hold. */
const repo = (
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

const WEBSHOP = repo("res-webshop", "git@github.com:acme/webshop.git", "github.com/acme/webshop", [
  WEBSHOP_PROJECT.id,
]);
const INFRA = repo("res-infra", "git@github.com:acme/ops-infra.git", "github.com/acme/ops-infra", [
  OPS_PROJECT.id,
]);
const RUNBOOKS = repo(
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
    },
  ],
  designatedConnectionId: "conn-github",
  message: null,
  sessionIds: [],
  createdAt: at,
  provisionedAt: at,
  lastUsedAt: at,
  disposedAt: null,
};

/** A live worktree of webshop, which another thread is already working in. */
const RUN_3F1: Workspace = {
  ...PRIMARY,
  id: "ws-run-3f1",
  kind: "ephemeral",
  checkouts: [
    {
      checkoutId: "co-run-3f1",
      resourceId: WEBSHOP.id,
      form: "worktree",
      subdirectory: null,
      branch: "hydra/run-3f1",
      branches: ["hydra/run-3f1"],
      defaultBranch: "main",
    },
  ],
  sessionIds: ["s-flaky", "s-runbook"],
};

/** The threads working in `RUN_3F1`, as the listing holds them (D-19). */
const thread = (id: string, title: string): Session => ({
  id,
  title,
  status: "idle",
  resumable: false,
  permissionProfileId: "profile-unrestricted",
  instanceId: CLAUDE.id,
  runnerId: LOCAL.id,
  workspaceId: "ws-run-3f1",
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
});

const SESSIONS = [
  thread("s-flaky", "Fix flaky webhook tests"),
  thread("s-runbook", "Write the retry runbook"),
  thread("s-third", "Bump the Bun pin"),
];

const withRepos = (
  projects: readonly Project[],
  resources: readonly Resource[],
  workspaces: readonly Workspace[] = [PRIMARY, RUN_3F1],
) => ({
  instances: [CLAUDE],
  runners: [LOCAL, OTHER],
  localRunnerId: LOCAL.id,
  projects,
  resources,
  workspaces,
  // The threads the workspaces hold: what a draft joining one names (D-19).
  sessions: SESSIONS,
});

/** The catalogs every case below reads unless it says otherwise. */
const FULL = withRepos([WEBSHOP_PROJECT, OPS_PROJECT, EMPTY_PROJECT], [WEBSHOP, INFRA, RUNBOOKS]);

const draft = (overrides: Record<string, unknown> = {}) =>
  config({ projectId: null, workspace: null, preferredWorkspace: null, ...overrides });

describe("composerFields: the workspace a draft defaults to (AC-17)", () => {
  it("takes the one repo's main workspace in a project that holds one repo", () => {
    const fields = composerFields(FULL, draft({ projectId: WEBSHOP_PROJECT.id }), "draft");

    expect(fields.workspace.value).toEqual({ kind: "primary", resourceId: WEBSHOP.id });
  });

  it("takes a worktree of each repo in a project that holds several", () => {
    const fields = composerFields(FULL, draft({ projectId: OPS_PROJECT.id }), "draft");

    expect(fields.workspace.value).toEqual({
      kind: "ephemeral",
      checkouts: [{ resourceId: INFRA.id }, { resourceId: RUNBOOKS.id }],
    });
  });

  it("follows the stored thread.workspace over the repo count", () => {
    const fields = composerFields(
      FULL,
      draft({ projectId: WEBSHOP_PROJECT.id, preferredWorkspace: "ephemeral" }),
      "draft",
    );

    expect(fields.workspace.value).toEqual({
      kind: "ephemeral",
      checkouts: [{ resourceId: WEBSHOP.id }],
    });
  });

  // D-20d: None is honoured only where None is offered, which is a project
  // with no repo; one that holds a repo falls back to the rule.
  it("ignores a stored none in a project that holds a repo", () => {
    const fields = composerFields(
      FULL,
      draft({ projectId: WEBSHOP_PROJECT.id, preferredWorkspace: "none" }),
      "draft",
    );

    expect(fields.workspace.value).toEqual({ kind: "primary", resourceId: WEBSHOP.id });
  });

  it("works without a checkout when the stored setting says none and there is no repo", () => {
    const fields = composerFields(
      FULL,
      draft({ projectId: EMPTY_PROJECT.id, preferredWorkspace: "none" }),
      "draft",
    );

    expect(fields.workspace.value).toEqual({ kind: "none" });
  });

  it("works without a checkout in a project with no repo, whatever the setting asks for", () => {
    const fields = composerFields(
      FULL,
      draft({ projectId: EMPTY_PROJECT.id, preferredWorkspace: "primary" }),
      "draft",
    );

    expect(fields.workspace.value).toEqual({ kind: "none" });
  });

  it("works without a checkout on a draft that belongs to no project at all", () => {
    const fields = composerFields(FULL, draft({ preferredWorkspace: "primary" }), "draft");

    expect(fields.workspace.value).toEqual({ kind: "none" });
  });

  it("keeps the pick the user made over the default", () => {
    const fields = composerFields(
      FULL,
      draft({
        projectId: WEBSHOP_PROJECT.id,
        workspace: { kind: "existing", workspaceId: RUN_3F1.id },
      }),
      "draft",
    );

    expect(fields.workspace.value).toEqual({ kind: "existing", workspaceId: RUN_3F1.id });
  });
});

describe("composerFields: one machine, read by everything that names one", () => {
  it("resolves the machine a draft with nothing selectable would really be placed on", () => {
    // Nothing is logged in anywhere, so no row is selectable and the draft has
    // picked no machine - but it would still be placed on the local one, and
    // the sentence, the workspace menu and the branch list all have to ask
    // about that one machine rather than about "none".
    const catalogs = {
      ...FULL,
      instances: [LOGGED_OUT],
      workspaces: [PRIMARY],
    };
    const fields = composerFields(
      catalogs,
      draft({ instanceId: LOGGED_OUT.id, runnerId: null, projectId: WEBSHOP_PROJECT.id }),
      "draft",
    );

    expect(fields.machine.runnerId).toBe(LOCAL.id);
    expect(fields.machine.label).toBe("moss · not logged in");
    // The lead reads the main workspace on that same machine, rather than
    // reading nothing because no machine was picked.
    expect(phraseText(fields.lead ?? [])).toBe(
      "It works in the main workspace of webshop on moss, on main. You and the agent share the files.",
    );
  });
});

describe("composerFields: the machine a joined workspace settles (AC-19)", () => {
  it("names the workspace that decided it, while the draft can still change its mind", () => {
    const fields = composerFields(
      FULL,
      draft({
        projectId: WEBSHOP_PROJECT.id,
        workspace: { kind: "existing", workspaceId: RUN_3F1.id },
      }),
      "draft",
    );

    expect(fields.machine.label).toBe("set by the workspace hydra/run-3f1");
    expect(fields.machine.locked).toBe("The workspace it joins decides the machine");
  });

  it("keeps naming the machine on a thread that has started, locked because it started", () => {
    const fields = composerFields(
      FULL,
      draft({
        projectId: WEBSHOP_PROJECT.id,
        workspace: { kind: "existing", workspaceId: RUN_3F1.id },
      }),
      "active",
    );

    expect(fields.machine.label).toBe("moss");
    expect(fields.machine.locked).toBe("Create a new thread to change the machine");
  });
});

describe("composerFields: the lead sentence follows the workspace (AC-17)", () => {
  it("names the repo, the machine and the branch on the main workspace", () => {
    const fields = composerFields(
      FULL,
      draft({
        projectId: WEBSHOP_PROJECT.id,
        workspace: { kind: "primary", resourceId: WEBSHOP.id, branch: "release/2.4" },
      }),
      "draft",
    );

    expect(phraseText(fields.lead ?? [])).toBe(
      "It works in the main workspace of webshop on moss, on release/2.4. You and the agent share the files.",
    );
  });

  it("reads the main workspace's own branch when the draft has picked none", () => {
    const fields = composerFields(
      FULL,
      draft({
        projectId: WEBSHOP_PROJECT.id,
        workspace: { kind: "primary", resourceId: WEBSHOP.id },
      }),
      "draft",
    );

    expect(phraseText(fields.lead ?? [])).toBe(
      "It works in the main workspace of webshop on moss, on main. You and the agent share the files.",
    );
  });

  it("names the repo and the base branch on a worktree of its own", () => {
    const fields = composerFields(
      FULL,
      draft({
        projectId: WEBSHOP_PROJECT.id,
        workspace: {
          kind: "ephemeral",
          checkouts: [{ resourceId: WEBSHOP.id, baseBranch: "release/2.4" }],
        },
      }),
      "draft",
    );

    expect(phraseText(fields.lead ?? [])).toBe(
      "It gets its own worktree of webshop, on a new branch from release/2.4.",
    );
  });

  it("falls back to the repo's default branch as the base when the draft has picked none", () => {
    const fields = composerFields(
      FULL,
      draft({
        projectId: WEBSHOP_PROJECT.id,
        workspace: { kind: "ephemeral", checkouts: [{ resourceId: WEBSHOP.id }] },
      }),
      "draft",
    );

    expect(phraseText(fields.lead ?? [])).toBe(
      "It gets its own worktree of webshop, on a new branch from main.",
    );
  });

  // D-19: the draft names the work it is joining, not the workspace's own name.
  it("names the threads it joins, and what joining them means", () => {
    const fields = composerFields(
      FULL,
      draft({
        projectId: WEBSHOP_PROJECT.id,
        workspace: { kind: "existing", workspaceId: RUN_3F1.id },
      }),
      "draft",
    );

    expect(phraseText(fields.lead ?? [])).toBe(
      "It joins “Fix flaky webhook tests” and “Write the retry runbook” there: the agents see each other's edits, on one branch.",
    );
  });

  // D-19: two titles at most; the rest are counted.
  it("counts the threads past the second rather than naming them all", () => {
    const three = { ...RUN_3F1, sessionIds: ["s-flaky", "s-runbook", "s-third"] };
    const fields = composerFields(
      withRepos([WEBSHOP_PROJECT], [WEBSHOP], [PRIMARY, three]),
      draft({
        projectId: WEBSHOP_PROJECT.id,
        workspace: { kind: "existing", workspaceId: three.id },
      }),
      "draft",
    );

    expect(phraseText(fields.lead ?? [])).toBe(
      "It joins “Fix flaky webhook tests”, “Write the retry runbook” and 1 more there: the agents see each other's edits, on one branch.",
    );
  });

  // D-19: a workspace holding no thread has no work to name, so it names itself.
  it("names the workspace itself when it holds no thread yet", () => {
    const empty = { ...RUN_3F1, sessionIds: [] };
    const fields = composerFields(
      withRepos([WEBSHOP_PROJECT], [WEBSHOP], [PRIMARY, empty]),
      draft({
        projectId: WEBSHOP_PROJECT.id,
        workspace: { kind: "existing", workspaceId: empty.id },
      }),
      "draft",
    );

    expect(phraseText(fields.lead ?? [])).toBe(
      "It joins “hydra/run-3f1” there: the agents see each other's edits, on one branch.",
    );
  });

  // D-20d: a thread works without a checkout where the project has no repo.
  it("says a thread with no checkout works without one", () => {
    const fields = composerFields(
      FULL,
      draft({ projectId: EMPTY_PROJECT.id, preferredWorkspace: "none" }),
      "draft",
    );

    expect(phraseText(fields.lead ?? [])).toBe("It works without a checkout.");
  });
});
