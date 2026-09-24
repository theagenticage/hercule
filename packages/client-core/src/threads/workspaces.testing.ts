/**
 * The records the workspace readings are written against: a fleet of two
 * machines, a one-repo project and a two-repo one, a main workspace and a
 * live worktree. Shared by every suite that speaks about them - client-core's
 * own and the web app's, through the `@hercule/client-core/threads/testing`
 * export - because a world written five times drifts.
 *
 * The ids read as words by default. A suite whose records travel over the API
 * is decoded against the contract, which takes UUIDv7 and nothing else, so
 * `buildThreadsWorld` takes one id per slot and the world is built around them.
 */
import type { Project, Resource, Runner, Session, Workspace } from "@hercule/contract";

export const AT = "2026-09-10T09:00:00.000Z";

export const buildRunner = (id: string, name: string): Runner => ({
  id,
  name,
  connectivity: "online",
  lifecycle: "active",
  reserved: false,
  version: "0.4.2",
  labels: [],
  facts: null,
  watermark: null,
  maxConcurrentSessions: 4,
  diskWatermarkBytes: 1024,
  lastSeenAt: AT,
});

export const buildProject = (id: string, name: string): Project => ({
  id,
  name,
  createdAt: AT,
  updatedAt: AT,
});

/**
 * A repo, with both spellings of its remote written out. Neither is derived
 * from the other: canonicalizing a remote is the system's own rule, and a
 * fixture that re-implements it backwards is a second rule to keep in step.
 */
export const buildRepo = (
  id: string,
  remote: string | null,
  canonicalRemote: string | null,
  projectIds: readonly string[] = [],
): Resource => ({
  id,
  kind: "repo",
  remote,
  canonicalRemote,
  label: null,
  connectionId: null,
  setupCommand: null,
  workspaceInclude: true,
  projectIds,
  createdAt: AT,
  updatedAt: AT,
});

export const buildCheckout = (
  resourceId: string,
  /** Null where the machine could not read one, which the record carries (D-21). */
  branch: string | null,
  branches: readonly string[] = branch === null ? [] : [branch],
  defaultBranch: string | null = "main",
) => ({
  checkoutId: `co-${resourceId}-${branch ?? "unknown"}`,
  resourceId,
  form: "clone" as const,
  subdirectory: null,
  branch,
  branches,
  defaultBranch,
});

export const buildWorkspace = (over: Partial<Workspace> & { id: string }): Workspace => ({
  runnerId: SLOTS.moss,
  kind: "primary",
  status: "ready",
  checkouts: [],
  designatedConnectionId: null,
  message: null,
  sessionIds: [],
  createdAt: AT,
  provisionedAt: AT,
  lastUsedAt: AT,
  disposedAt: null,
  ...over,
});

export const buildSession = (over: Partial<Session> & { id: string }): Session => ({
  title: "A thread",
  status: "idle",
  resumable: false,
  permissionProfileId: "p-unrestricted",
  agentId: null,
  instanceId: "i-claude",
  runnerId: SLOTS.moss,
  workspaceId: null,
  projectId: null,
  requestedAccessMode: "approval-required",
  accessMode: "approval-required",
  nativeSessionId: null,
  modelSelection: { model: "claude-sonnet-5", options: {} },
  parentSessionId: null,
  openRequest: null,
  createdAt: AT,
  startedAt: AT,
  exitedAt: null,
  lastActivityAt: AT,
  unenforced: [],
  ...over,
});

/** One id per record the world holds, and per thread the two workspaces list. */
export interface WorldIds {
  readonly moss: string;
  readonly cove: string;
  readonly webshopProject: string;
  readonly opsProject: string;
  readonly webshop: string;
  readonly infra: string;
  readonly runbooks: string;
  readonly primary: string;
  readonly primaryCheckout: string;
  readonly run3f1: string;
  readonly run3f1Checkout: string;
  /** The two threads working in `RUN_3F1`. */
  readonly flakyThread: string;
  readonly runbookThread: string;
}

const SLOTS: WorldIds = {
  moss: "r-moss",
  cove: "r-cove",
  webshopProject: "p-webshop",
  opsProject: "p-ops",
  webshop: "res-webshop",
  infra: "res-infra",
  runbooks: "res-runbooks",
  primary: "ws-primary",
  primaryCheckout: "co-ws-primary",
  run3f1: "ws-run-3f1",
  run3f1Checkout: "co-ws-run-3f1",
  flakyThread: "s-flaky",
  runbookThread: "s-runbook",
};

export interface ThreadsWorld {
  readonly MOSS: Runner;
  readonly COVE: Runner;
  readonly WEBSHOP_PROJECT: Project;
  readonly OPS_PROJECT: Project;
  readonly WEBSHOP: Resource;
  readonly INFRA: Resource;
  readonly RUNBOOKS: Resource;
  /** webshop's main workspace on moss, sitting on `main`. */
  readonly PRIMARY: Workspace;
  /** A live worktree of webshop on moss, which two threads are working in. */
  readonly RUN_3F1: Workspace;
}

export const buildThreadsWorld = (ids: Partial<WorldIds> = {}): ThreadsWorld => {
  const id = { ...SLOTS, ...ids };
  const WEBSHOP = buildRepo(
    id.webshop,
    "git@github.com:acme/webshop.git",
    "github.com/acme/webshop",
    [id.webshopProject],
  );
  return {
    MOSS: buildRunner(id.moss, "moss"),
    COVE: buildRunner(id.cove, "cove"),
    WEBSHOP_PROJECT: buildProject(id.webshopProject, "webshop"),
    OPS_PROJECT: buildProject(id.opsProject, "ops"),
    WEBSHOP,
    INFRA: buildRepo(id.infra, "git@github.com:acme/ops-infra.git", "github.com/acme/ops-infra", [
      id.opsProject,
    ]),
    RUNBOOKS: buildRepo(
      id.runbooks,
      "git@github.com:acme/ops-runbooks.git",
      "github.com/acme/ops-runbooks",
      [id.opsProject],
    ),
    PRIMARY: buildWorkspace({
      id: id.primary,
      runnerId: id.moss,
      checkouts: [
        {
          ...buildCheckout(WEBSHOP.id, "main", ["main", "release/2.4", "hercule/run-3f1"]),
          checkoutId: id.primaryCheckout,
        },
      ],
    }),
    RUN_3F1: buildWorkspace({
      id: id.run3f1,
      runnerId: id.moss,
      kind: "ephemeral",
      checkouts: [
        {
          ...buildCheckout(WEBSHOP.id, "hercule/run-3f1"),
          checkoutId: id.run3f1Checkout,
          form: "worktree",
        },
      ],
      sessionIds: [id.flakyThread, id.runbookThread],
    }),
  };
};

export const {
  MOSS,
  COVE,
  WEBSHOP_PROJECT,
  OPS_PROJECT,
  WEBSHOP,
  INFRA,
  RUNBOOKS,
  PRIMARY,
  RUN_3F1,
} = buildThreadsWorld();
