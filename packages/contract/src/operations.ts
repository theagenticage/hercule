/**
 * The operation table.
 *
 * One row per operation: its id (`<entity>.<verb>`, the same word the CLI and
 * the built-in workflow actions use), what a caller must hold to reach it, and
 * its explicit `{ method, path }`. Path nouns are plural although operation ids
 * are singular; that is the one place the two spellings differ.
 *
 * The controller reads this table on every request; it is not documentation.
 * The static grant check runs in HTTP middleware before the payload is
 * decoded, so `unauthenticated` comes before `forbidden`, which comes before
 * `validation`, the order the error envelope requires. The middleware finds
 * the row by joining the group and endpoint identifiers with a dot.
 * `api.test.ts` checks that the table and the HttpApi declaration match one
 * to one.
 */
import type { Grant } from "./grants";

/** The prefix every route carries. */
export const API_PREFIX = "/api/v1";

/**
 * What a caller must hold. A grant always contains a dot, so the three markers
 * can never collide with one:
 *
 * - `unauthenticated` - reachable with no credential at all.
 * - `setup-token` - reachable only with the one-time setup token.
 * - `authenticated` - any credential of any kind; no grant is checked.
 */
export type Requirement = Grant | "unauthenticated" | "setup-token" | "authenticated";

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * Routes use Effect's `:param` path syntax; the published API documents the
 * same routes with `{param}`.
 */
const TABLE = {
  "setup.read": { requires: "unauthenticated", method: "GET", path: "/api/v1/setup" },
  "setup.complete": { requires: "setup-token", method: "POST", path: "/api/v1/setup/complete" },

  "auth.login": { requires: "unauthenticated", method: "POST", path: "/api/v1/auth/login" },
  "auth.logout": { requires: "authenticated", method: "POST", path: "/api/v1/auth/logout" },
  "auth.wsTicket": { requires: "authenticated", method: "POST", path: "/api/v1/auth/ws-ticket" },

  "apiKey.query": { requires: "credential.read", method: "GET", path: "/api/v1/api-keys" },
  "apiKey.create": { requires: "credential.write", method: "POST", path: "/api/v1/api-keys" },
  "apiKey.revoke": {
    requires: "credential.write",
    method: "DELETE",
    path: "/api/v1/api-keys/:id",
  },

  // The username is half of what a person signs in with, so reading it is a
  // credential read, like listing API keys. The service lets only the user
  // call it, so a session is refused even when its profile holds the grant.
  "user.read": { requires: "credential.read", method: "GET", path: "/api/v1/user" },
  "user.setPassword": {
    requires: "credential.write",
    method: "POST",
    path: "/api/v1/user/password",
  },

  "settings.read": { requires: "settings.read", method: "GET", path: "/api/v1/settings" },
  "settings.update": { requires: "settings.write", method: "PATCH", path: "/api/v1/settings" },

  "profile.query": { requires: "permission.read", method: "GET", path: "/api/v1/profiles" },
  "profile.read": { requires: "permission.read", method: "GET", path: "/api/v1/profiles/:id" },
  "profile.create": { requires: "permission.write", method: "POST", path: "/api/v1/profiles" },
  "profile.update": {
    requires: "permission.write",
    method: "PATCH",
    path: "/api/v1/profiles/:id",
  },
  "profile.delete": {
    requires: "permission.write",
    method: "DELETE",
    path: "/api/v1/profiles/:id",
  },

  "secret.query": { requires: "secret.read", method: "GET", path: "/api/v1/secrets" },
  "secret.set": {
    requires: "secret.write",
    method: "PUT",
    path: "/api/v1/secrets/:ownerKind/:ownerId/:name",
  },
  "secret.delete": {
    requires: "secret.write",
    method: "DELETE",
    path: "/api/v1/secrets/:ownerKind/:ownerId/:name",
  },

  "task.query": { requires: "task.read", method: "GET", path: "/api/v1/tasks" },
  "task.read": { requires: "task.read", method: "GET", path: "/api/v1/tasks/:id" },
  "task.create": { requires: "task.create", method: "POST", path: "/api/v1/tasks" },
  "task.update": { requires: "task.update", method: "PATCH", path: "/api/v1/tasks/:id" },
  "task.delete": { requires: "task.delete", method: "DELETE", path: "/api/v1/tasks/:id" },

  "notification.query": {
    requires: "notification.read",
    method: "GET",
    path: "/api/v1/notifications",
  },
  "notification.read": {
    requires: "notification.read",
    method: "GET",
    path: "/api/v1/notifications/:id",
  },
  "notification.create": {
    requires: "notification.write",
    method: "POST",
    path: "/api/v1/notifications",
  },
  "notification.withdraw": {
    requires: "notification.write",
    method: "POST",
    path: "/api/v1/notifications/:id/withdraw",
  },
  "notification.act": {
    requires: "notification.write",
    method: "POST",
    path: "/api/v1/notifications/:id/act",
  },

  "project.query": { requires: "project.read", method: "GET", path: "/api/v1/projects" },
  "project.read": { requires: "project.read", method: "GET", path: "/api/v1/projects/:id" },
  "project.create": { requires: "project.write", method: "POST", path: "/api/v1/projects" },
  "project.update": { requires: "project.write", method: "PATCH", path: "/api/v1/projects/:id" },
  "project.delete": { requires: "project.write", method: "DELETE", path: "/api/v1/projects/:id" },

  "resource.query": { requires: "resource.read", method: "GET", path: "/api/v1/resources" },
  "resource.read": { requires: "resource.read", method: "GET", path: "/api/v1/resources/:id" },
  "resource.create": { requires: "resource.write", method: "POST", path: "/api/v1/resources" },
  "resource.update": {
    requires: "resource.write",
    method: "PATCH",
    path: "/api/v1/resources/:id",
  },
  "resource.delete": {
    requires: "resource.write",
    method: "DELETE",
    path: "/api/v1/resources/:id",
  },

  "workspace.query": { requires: "workspace.read", method: "GET", path: "/api/v1/workspaces" },
  "workspace.read": { requires: "workspace.read", method: "GET", path: "/api/v1/workspaces/:id" },
  "workspace.provision": {
    requires: "workspace.write",
    method: "POST",
    path: "/api/v1/workspaces",
  },
  "workspace.attach": {
    requires: "workspace.write",
    method: "POST",
    path: "/api/v1/workspaces/attach",
  },
  "workspace.inspect": {
    requires: "workspace.read",
    method: "POST",
    path: "/api/v1/workspaces/:id/inspect",
  },
  "workspace.dispose": {
    requires: "workspace.write",
    method: "DELETE",
    path: "/api/v1/workspaces/:id",
  },
  "workspace.detach": {
    requires: "workspace.write",
    method: "POST",
    path: "/api/v1/workspaces/:id/detach",
  },

  "event.query": { requires: "event.read", method: "GET", path: "/api/v1/events" },
  "event.read": { requires: "event.read", method: "GET", path: "/api/v1/events/:id" },
  "event.emit": { requires: "event.emit", method: "POST", path: "/api/v1/events/emit" },
  // Enriching an event writes to the event log, and `event.emit` is the log's
  // only write grant. There is no separate grant for amending an event.
  "event.enrich": { requires: "event.emit", method: "POST", path: "/api/v1/events/:id/enrich" },

  "subscription.query": {
    requires: "subscription.read",
    method: "GET",
    path: "/api/v1/subscriptions",
  },
  "subscription.create": {
    requires: "subscription.write",
    method: "POST",
    path: "/api/v1/subscriptions",
  },
  "subscription.cancel": {
    requires: "subscription.write",
    method: "DELETE",
    path: "/api/v1/subscriptions/:id",
  },

  "workflow.query": { requires: "workflow.read", method: "GET", path: "/api/v1/workflows" },
  "workflow.read": { requires: "workflow.read", method: "GET", path: "/api/v1/workflows/:id" },
  "workflow.create": { requires: "workflow.write", method: "POST", path: "/api/v1/workflows" },
  "workflow.update": {
    requires: "workflow.write",
    method: "PATCH",
    path: "/api/v1/workflows/:id",
  },
  "workflow.delete": {
    requires: "workflow.write",
    method: "DELETE",
    path: "/api/v1/workflows/:id",
  },
  // Validation stores nothing, so it needs only the read grant. Like a save,
  // it reports whether the Agents and Connections the workflow refers to
  // exist.
  "workflow.validate": {
    requires: "workflow.read",
    method: "POST",
    path: "/api/v1/workflows/validate",
  },

  // One operation starts a run, of a stored workflow or of one sent with the
  // request. It is a verb on runs with no run to act on yet, so its path is
  // the collection's plus the verb.
  "run.start": { requires: "run.start", method: "POST", path: "/api/v1/runs/start" },
  "run.query": { requires: "run.read", method: "GET", path: "/api/v1/runs" },
  "run.read": { requires: "run.read", method: "GET", path: "/api/v1/runs/:id" },
  "run.cancel": { requires: "run.write", method: "POST", path: "/api/v1/runs/:id/cancel" },
  // A re-run starts a run, so it needs the grant that starting one needs.
  "run.rerun": { requires: "run.start", method: "POST", path: "/api/v1/runs/:id/rerun" },

  // Every trigger belongs to a workflow, so listing triggers needs the workflow
  // read grant. Triggers have no grant family of their own.
  "trigger.query": { requires: "workflow.read", method: "GET", path: "/api/v1/triggers" },
  // Pausing a trigger changes its workflow's behaviour, so it needs the grant
  // that changing the workflow needs.
  "trigger.pause": {
    requires: "workflow.write",
    method: "POST",
    path: "/api/v1/workflows/:workflowId/triggers/:triggerId/pause",
  },
  "trigger.resume": {
    requires: "workflow.write",
    method: "POST",
    path: "/api/v1/workflows/:workflowId/triggers/:triggerId/resume",
  },

  // The two catalogs used to write a workflow: the actions a step can call and
  // the event kinds a trigger can listen for. They are only needed to write
  // workflows, so they use the workflow read grant instead of a grant family
  // of their own.
  "workflowAction.query": {
    requires: "workflow.read",
    method: "GET",
    path: "/api/v1/workflow-actions",
  },
  "eventKind.query": { requires: "workflow.read", method: "GET", path: "/api/v1/event-kinds" },

  "runner.query": { requires: "infra.read", method: "GET", path: "/api/v1/runners" },
  "runner.read": { requires: "infra.read", method: "GET", path: "/api/v1/runners/:id" },
  "runner.update": { requires: "infra.write", method: "PATCH", path: "/api/v1/runners/:id" },
  "runner.drain": { requires: "infra.write", method: "POST", path: "/api/v1/runners/:id/drain" },
  "runner.undrain": {
    requires: "infra.write",
    method: "POST",
    path: "/api/v1/runners/:id/undrain",
  },
  "runner.retire": { requires: "infra.write", method: "POST", path: "/api/v1/runners/:id/retire" },
  "runner.refreshFacts": {
    requires: "infra.write",
    method: "POST",
    path: "/api/v1/runners/:id/refresh-facts",
  },
  "runner.probe": {
    requires: "infra.write",
    method: "POST",
    path: "/api/v1/runners/:id/probe",
  },
  "runner.installHarness": {
    requires: "infra.write",
    method: "POST",
    path: "/api/v1/runners/:id/install-harness",
  },
  "runner.createJoinToken": {
    requires: "infra.write",
    method: "POST",
    path: "/api/v1/runners/join-tokens",
  },
  "runner.queryJoinTokens": {
    requires: "infra.write",
    method: "GET",
    path: "/api/v1/runners/join-tokens",
  },
  "runner.revokeJoinToken": {
    requires: "infra.write",
    method: "DELETE",
    path: "/api/v1/runners/join-tokens/:id",
  },

  "plugin.query": { requires: "infra.read", method: "GET", path: "/api/v1/plugins" },
  "plugin.read": { requires: "infra.read", method: "GET", path: "/api/v1/plugins/:id" },
  "plugin.enable": {
    requires: "infra.write",
    method: "POST",
    path: "/api/v1/plugins/:id/enable",
  },
  "plugin.disable": {
    requires: "infra.write",
    method: "POST",
    path: "/api/v1/plugins/:id/disable",
  },
  "plugin.retry": { requires: "infra.write", method: "POST", path: "/api/v1/plugins/:id/retry" },
  "plugin.resetState": {
    requires: "infra.write",
    method: "POST",
    path: "/api/v1/plugins/:id/reset-state",
  },
  "plugin.configure": {
    requires: "infra.write",
    method: "PUT",
    path: "/api/v1/plugins/:id/config",
  },

  "provider.query": { requires: "infra.read", method: "GET", path: "/api/v1/providers" },
  "provider.read": { requires: "infra.read", method: "GET", path: "/api/v1/providers/:id" },
  "provider.create": { requires: "infra.write", method: "POST", path: "/api/v1/providers" },
  "provider.update": { requires: "infra.write", method: "PATCH", path: "/api/v1/providers/:id" },
  "provider.login": {
    requires: "infra.write",
    method: "POST",
    path: "/api/v1/providers/:id/login",
  },
  "provider.submitLoginCode": {
    requires: "infra.write",
    method: "POST",
    path: "/api/v1/providers/:id/login-code",
  },
  "provider.delete": {
    requires: "infra.write",
    method: "DELETE",
    path: "/api/v1/providers/:id",
  },

  "connection.query": { requires: "connection.read", method: "GET", path: "/api/v1/connections" },
  "connection.read": {
    requires: "connection.read",
    method: "GET",
    path: "/api/v1/connections/:id",
  },
  "connection.create": {
    requires: "connection.manage",
    method: "POST",
    path: "/api/v1/connections",
  },
  "connection.update": {
    requires: "connection.manage",
    method: "PATCH",
    path: "/api/v1/connections/:id",
  },
  "connection.delete": {
    requires: "connection.manage",
    method: "DELETE",
    path: "/api/v1/connections/:id",
  },
  "connection.setCredentials": {
    requires: "connection.manage",
    method: "POST",
    path: "/api/v1/connections/:id/credentials",
  },
  "connection.startOAuth": {
    requires: "connection.manage",
    method: "POST",
    path: "/api/v1/oauth/start",
  },
  "connection.startDeviceFlow": {
    requires: "connection.manage",
    method: "POST",
    path: "/api/v1/oauth/device/start",
  },
  "connection.pollDeviceFlow": {
    requires: "connection.manage",
    method: "POST",
    path: "/api/v1/oauth/device/poll",
  },

  "agent.query": { requires: "agent.read", method: "GET", path: "/api/v1/agents" },
  "agent.read": { requires: "agent.read", method: "GET", path: "/api/v1/agents/:id" },
  "agent.create": { requires: "agent.write", method: "POST", path: "/api/v1/agents" },
  "agent.update": { requires: "agent.write", method: "PATCH", path: "/api/v1/agents/:id" },
  "agent.delete": { requires: "agent.write", method: "DELETE", path: "/api/v1/agents/:id" },

  "assistant.query": { requires: "agent.read", method: "GET", path: "/api/v1/assistants" },
  "assistant.read": { requires: "agent.read", method: "GET", path: "/api/v1/assistants/:id" },
  "assistant.create": { requires: "agent.write", method: "POST", path: "/api/v1/assistants" },
  "assistant.update": {
    requires: "agent.write",
    method: "PATCH",
    path: "/api/v1/assistants/:id",
  },
  "assistant.delete": {
    requires: "agent.write",
    method: "DELETE",
    path: "/api/v1/assistants/:id",
  },

  "conversation.query": { requires: "agent.read", method: "GET", path: "/api/v1/conversations" },
  "conversation.read": {
    requires: "agent.read",
    method: "GET",
    path: "/api/v1/conversations/:id",
  },
  "conversation.queryMessages": {
    requires: "agent.read",
    method: "GET",
    path: "/api/v1/conversations/:id/messages",
  },
  "conversation.send": {
    requires: "agent.write",
    method: "POST",
    path: "/api/v1/conversations/:id/messages",
  },

  "session.query": { requires: "session.read", method: "GET", path: "/api/v1/sessions" },
  "session.read": { requires: "session.read", method: "GET", path: "/api/v1/sessions/:id" },
  "session.querySubagents": {
    requires: "session.read",
    method: "GET",
    path: "/api/v1/sessions/:id/subagents",
  },
  "session.spawn": { requires: "session.spawn", method: "POST", path: "/api/v1/sessions" },
  "session.update": {
    requires: "session.steer",
    method: "PATCH",
    path: "/api/v1/sessions/:id",
  },
  "session.input": {
    requires: "session.steer",
    method: "POST",
    path: "/api/v1/sessions/:id/input",
  },
  "session.interrupt": {
    requires: "session.steer",
    method: "POST",
    path: "/api/v1/sessions/:id/interrupt",
  },
  "session.respondToApprovalRequest": {
    requires: "session.steer",
    method: "POST",
    path: "/api/v1/sessions/:id/respond-to-approval-request",
  },
  "session.respondToQuestion": {
    requires: "session.steer",
    method: "POST",
    path: "/api/v1/sessions/:id/respond-to-question",
  },
  "session.stop": {
    requires: "session.steer",
    method: "POST",
    path: "/api/v1/sessions/:id/stop",
  },
  // Continuing opens a new session on the same native transcript. That is
  // spawning, not steering, even though the path holds an existing session id.
  "session.continue": {
    requires: "session.spawn",
    method: "POST",
    path: "/api/v1/sessions/:id/continue",
  },

  // Owned sub-resources of a session: the id in the path is the session's, and
  // the grant is the session's, because an input is what that session was told.
  "input.query": {
    requires: "session.read",
    method: "GET",
    path: "/api/v1/sessions/:id/inputs",
  },
  "input.update": {
    requires: "session.steer",
    method: "PATCH",
    path: "/api/v1/sessions/:id/inputs/:inputId",
  },
  "input.cancel": {
    requires: "session.steer",
    method: "DELETE",
    path: "/api/v1/sessions/:id/inputs/:inputId",
  },
  "input.steer": {
    requires: "session.steer",
    method: "POST",
    path: "/api/v1/sessions/:id/inputs/:inputId/steer",
  },

  // An owned sub-resource: the id in the path is the session's, and the grant
  // is the session's own read, because a transcript is what that session said.
  "transcript.read": {
    requires: "session.read",
    method: "GET",
    path: "/api/v1/sessions/:id/transcript",
  },
  "attachment.create": {
    requires: "session.steer",
    method: "POST",
    path: "/api/v1/attachments",
  },
  "attachment.readContent": {
    requires: "session.read",
    method: "GET",
    path: "/api/v1/attachments/:id/content",
  },
  "attachment.delete": {
    requires: "session.steer",
    method: "DELETE",
    path: "/api/v1/attachments/:id",
  },

  "controller.read": { requires: "infra.read", method: "GET", path: "/api/v1/controller" },
  "controller.update": { requires: "infra.write", method: "PATCH", path: "/api/v1/controller" },
  "controller.createPromotionToken": {
    requires: "infra.write",
    method: "POST",
    path: "/api/v1/controller/promotion-tokens",
  },
} as const satisfies Record<string, { requires: Requirement; method: Method; path: string }>;

/** Every operation id in the public API. */
export type OperationId = keyof typeof TABLE;

export interface Operation {
  readonly id: OperationId;
  readonly requires: Requirement;
  readonly method: Method;
  readonly path: string;
}

export const OPERATIONS = TABLE;

/** Every operation, in table order: what the CLI enumerates for `--help`. */
export const ALL_OPERATIONS: ReadonlyArray<Operation> = Object.entries(TABLE).map(([id, row]) => ({
  id: id as OperationId,
  ...row,
}));

/** Checks whether the string is an operation id. */
export const isOperationId = (id: string): id is OperationId => id in TABLE;

/** Returns what a caller must hold to call the operation. */
export const readRequirement = (id: OperationId): Requirement => TABLE[id].requires;
