/**
 * The records the workspace readings are written against: a fleet of two
 * machines, a one-repo project and a two-repo one, a shared checkout and a
 * live worktree. Shared by the five suites around them because they all speak
 * about the same small world, and a world written five times drifts.
 */
import type { Project, Resource, Runner, Session, Workspace } from "@hydra/contract";

export const AT = "2026-09-10T09:00:00.000Z";

export const runner = (id: string, name: string): Runner => ({
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

export const MOSS = runner("r-moss", "moss");
export const COVE = runner("r-cove", "cove");

export const project = (id: string, name: string): Project => ({
  id,
  name,
  createdAt: AT,
  updatedAt: AT,
});

export const WEBSHOP_PROJECT = project("p-webshop", "webshop");
export const OPS_PROJECT = project("p-ops", "ops");

export const repo = (
  id: string,
  canonicalRemote: string | null,
  projectIds: readonly string[] = [],
): Resource => ({
  id,
  kind: "repo",
  remote: canonicalRemote === null ? null : `git@${canonicalRemote.replace("/", ":")}.git`,
  canonicalRemote,
  label: null,
  connectionId: null,
  setupCommand: null,
  workspaceInclude: true,
  projectIds,
  createdAt: AT,
  updatedAt: AT,
});

export const WEBSHOP = repo("res-webshop", "github.com/acme/webshop", [WEBSHOP_PROJECT.id]);
export const INFRA = repo("res-infra", "github.com/acme/ops-infra", [OPS_PROJECT.id]);
export const RUNBOOKS = repo("res-runbooks", "github.com/acme/ops-runbooks", [OPS_PROJECT.id]);

export const checkout = (
  resourceId: string,
  branch: string,
  branches: readonly string[] = [branch],
  defaultBranch: string | null = "main",
) => ({
  checkoutId: `co-${resourceId}-${branch}`,
  resourceId,
  form: "clone" as const,
  subdirectory: null,
  branch,
  branches,
  defaultBranch,
});

export const workspace = (over: Partial<Workspace> & { id: string }): Workspace => ({
  runnerId: MOSS.id,
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

/** webshop's shared checkout on moss, sitting on `main`. */
export const PRIMARY = workspace({
  id: "ws-primary",
  checkouts: [checkout(WEBSHOP.id, "main", ["main", "release/2.4", "hydra/run-3f1"])],
});

/** A live worktree of webshop on moss, which two threads are working in. */
export const RUN_3F1 = workspace({
  id: "ws-run-3f1",
  kind: "ephemeral",
  checkouts: [{ ...checkout(WEBSHOP.id, "hydra/run-3f1"), form: "worktree" }],
  sessionIds: ["s-flaky", "s-runbook"],
});

export const session = (over: Partial<Session> & { id: string }): Session => ({
  title: "A thread",
  status: "idle",
  resumable: false,
  permissionProfileId: "p-unrestricted",
  instanceId: "i-claude",
  runnerId: MOSS.id,
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
  ...over,
});
