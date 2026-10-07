/**
 * Test fixtures for the workspace functions: two runners, a one-repo project
 * and a two-repo project, a main workspace and a live worktree. Every test
 * suite that needs them shares them (client-core's own, and the web app's
 * through the `@hercule/client-core/threads/testing` export), because five
 * copies of the fixtures would drift apart.
 *
 * By default the ids are readable words. A suite that sends the records
 * through the API needs UUIDv7 ids, because the contract accepts nothing
 * else, so `buildThreadsWorld` accepts an id for each record.
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
 * Returns a repo resource, with both its remote and its canonical remote given
 * explicitly. Neither is derived from the other: canonicalizing a remote is the
 * controller's rule, and a fixture that re-implemented it would be a second
 * copy to keep in sync.
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
  /** `null` when the runner could not read the checkout's branch. */
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
  remoteBranches: [],
  headCommit: null,
  baseCommit: null,
  startingRevision: null,
  // Started from the repo's default branch, as a checkout is when the caller
  // names no base. A main workspace's clone has no base either.
  baseBranch: null,
});

export const buildWorkspace = (over: Partial<Workspace> & { id: string }): Workspace => ({
  runnerId: SLOTS.moss,
  kind: "primary",
  status: "ready",
  ownership: "managed",
  path: null,
  observedAt: null,
  warnings: [],
  checkouts: [],
  designatedConnectionId: null,
  message: null,
  sessionIds: [],
  keptUntil: null,
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
  resumeHeld: false,
  permissionProfileId: "p-unrestricted",
  agentId: null,
  conversationId: null,
  runId: null,
  stepId: null,
  instanceId: "i-claude",
  runnerId: SLOTS.moss,
  workspaceId: null,
  projectId: null,
  requestedAccessMode: "approval-required",
  accessMode: "approval-required",
  nativeSessionId: null,
  modelSelection: { model: "claude-sonnet-5", options: {} },
  parentSessionId: null,
  openRequests: [],
  createdAt: AT,
  startedAt: AT,
  exitedAt: null,
  lastActivityAt: AT,
  unenforced: [],
  ...over,
});

/** One id for each fixture record, and for each of the two threads in `THREAD_3F1`. */
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
  readonly thread3f1: string;
  readonly thread3f1Checkout: string;
  /** The two threads working in `THREAD_3F1`. */
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
  thread3f1: "ws-thread-3f1",
  thread3f1Checkout: "co-ws-thread-3f1",
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
  readonly THREAD_3F1: Workspace;
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
          ...buildCheckout(WEBSHOP.id, "main", ["main", "release/2.4", "hercule/thread-3f1"]),
          checkoutId: id.primaryCheckout,
        },
      ],
    }),
    THREAD_3F1: buildWorkspace({
      id: id.thread3f1,
      runnerId: id.moss,
      kind: "ephemeral",
      checkouts: [
        {
          ...buildCheckout(WEBSHOP.id, "hercule/thread-3f1"),
          checkoutId: id.thread3f1Checkout,
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
  THREAD_3F1,
} = buildThreadsWorld();
