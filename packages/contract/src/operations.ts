/**
 * The operation table.
 *
 * One row per operation: its id (`<entity>.<verb>`, the same word the CLI and
 * the built-in workflow actions use), what a caller must hold to reach it, and
 * its explicit `{ method, path }`. Path nouns are plural although operation ids
 * are singular; that is the one place the two spellings differ.
 *
 * This table is load-bearing at request time, not documentation: the static
 * grant check runs in HTTP middleware before the payload is decoded, so
 * `unauthenticated` precedes `forbidden` precedes `validation`, the order the
 * error envelope requires. The middleware finds the row by joining the
 * group and endpoint identifiers with a dot. `api.test.ts` asserts the table
 * and the HttpApi declaration are one-to-one.
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

  "project.query": { requires: "project.read", method: "GET", path: "/api/v1/projects" },
  "project.read": { requires: "project.read", method: "GET", path: "/api/v1/projects/:id" },
  "project.create": { requires: "project.write", method: "POST", path: "/api/v1/projects" },
  "project.update": { requires: "project.write", method: "PATCH", path: "/api/v1/projects/:id" },
  "project.delete": { requires: "project.write", method: "DELETE", path: "/api/v1/projects/:id" },

  "event.query": { requires: "event.read", method: "GET", path: "/api/v1/events" },
  "event.read": { requires: "event.read", method: "GET", path: "/api/v1/events/:id" },

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

  "session.query": { requires: "session.read", method: "GET", path: "/api/v1/sessions" },
  "session.read": { requires: "session.read", method: "GET", path: "/api/v1/sessions/:id" },
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
  "session.stop": {
    requires: "session.steer",
    method: "POST",
    path: "/api/v1/sessions/:id/stop",
  },
  // Opening a second session against one native transcript, so it is spawning
  // and not steering, whatever the id in the path says.
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

  "controller.read": { requires: "infra.read", method: "GET", path: "/api/v1/controller" },
  "controller.update": { requires: "infra.write", method: "PATCH", path: "/api/v1/controller" },
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

/** True when the string names an operation. */
export const isOperationId = (id: string): id is OperationId => id in TABLE;

/** What a caller must hold to reach this operation. */
export const requirementOf = (id: OperationId): Requirement => TABLE[id].requires;
