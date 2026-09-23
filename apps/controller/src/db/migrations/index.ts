/**
 * The migration set, embedded in the binary.
 *
 * Migrations are forward-only and statically imported: a compiled binary has no
 * filesystem to load `.sql` files from. Adding one means writing the file,
 * importing it here, and appending an entry with the next id. Ids are never
 * reused and a landed migration is never edited.
 */
import * as Effect from "effect/Effect";
import type { ResolvedMigration } from "effect/unstable/sql/Migrator";
import initial from "./0001-initial";
import usersAndCredentials from "./0002-users-and-credentials";
import tasksAndProjects from "./0003-tasks-and-projects";
import readingTheEventLog from "./0004-reading-the-event-log";
import runners from "./0005-runners";
import runnerJoinTokens from "./0006-runner-join-tokens";
import plugins from "./0007-plugins";
import runnerLifecycle from "./0008-runner-lifecycle";
import providerInstances from "./0009-provider-instances";
import sessions from "./0010-sessions";
import queuedInputAndContinuation from "./0011-queued-input-and-continuation";
import diskWatermark from "./0012-disk-watermark";
import resumedSessionStreams from "./0013-resumed-session-streams";
import connections from "./0014-connections";
import oauthSetups from "./0015-oauth-setups";
import openRequest from "./0016-open-request";
import sessionTokens from "./0017-session-tokens";
import auditGrantOnUnrestricted from "./0018-audit-grant-on-unrestricted";
import resourcesAndWorkspaces from "./0019-resources-and-workspaces";
import agents from "./0020-agents";
import subscriptions from "./0021-subscriptions";
import eventCursorsAndMatchedInputs from "./0022-event-cursors-and-matched-inputs";
import sessionTokenOnlyWhileRunning from "./0023-session-token-only-while-running";
import workflowsAndTriggers from "./0024-workflows-and-triggers";

export const migrations: ReadonlyArray<ResolvedMigration> = [
  [1, "initial", Effect.succeed(initial)],
  [2, "users-and-credentials", Effect.succeed(usersAndCredentials)],
  [3, "tasks-and-projects", Effect.succeed(tasksAndProjects)],
  [4, "reading-the-event-log", Effect.succeed(readingTheEventLog)],
  [5, "runners", Effect.succeed(runners)],
  [6, "runner-join-tokens", Effect.succeed(runnerJoinTokens)],
  [7, "plugins", Effect.succeed(plugins)],
  [8, "runner-lifecycle", Effect.succeed(runnerLifecycle)],
  [9, "provider-instances", Effect.succeed(providerInstances)],
  [10, "sessions", Effect.succeed(sessions)],
  [11, "queued-input-and-continuation", Effect.succeed(queuedInputAndContinuation)],
  [12, "disk-watermark", Effect.succeed(diskWatermark)],
  [13, "resumed-session-streams", Effect.succeed(resumedSessionStreams)],
  [14, "connections", Effect.succeed(connections)],
  [15, "oauth-setups", Effect.succeed(oauthSetups)],
  [16, "open-request", Effect.succeed(openRequest)],
  [17, "session-tokens", Effect.succeed(sessionTokens)],
  [18, "audit-grant-on-unrestricted", Effect.succeed(auditGrantOnUnrestricted)],
  [19, "resources-and-workspaces", Effect.succeed(resourcesAndWorkspaces)],
  [20, "agents", Effect.succeed(agents)],
  [21, "subscriptions", Effect.succeed(subscriptions)],
  [22, "event-cursors-and-matched-inputs", Effect.succeed(eventCursorsAndMatchedInputs)],
  [23, "session-token-only-while-running", Effect.succeed(sessionTokenOnlyWhileRunning)],
  [24, "workflows-and-triggers", Effect.succeed(workflowsAndTriggers)],
];

/** The schema version this binary carries: the highest embedded migration id. */
export const binaryVersion: number = migrations.reduce((highest, [id]) => Math.max(highest, id), 0);
