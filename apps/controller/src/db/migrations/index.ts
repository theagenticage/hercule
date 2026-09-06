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

export const migrations: ReadonlyArray<ResolvedMigration> = [
  [1, "initial", Effect.succeed(initial)],
  [2, "users-and-credentials", Effect.succeed(usersAndCredentials)],
  [3, "tasks-and-projects", Effect.succeed(tasksAndProjects)],
  [4, "reading-the-event-log", Effect.succeed(readingTheEventLog)],
  [5, "runners", Effect.succeed(runners)],
  [6, "runner-join-tokens", Effect.succeed(runnerJoinTokens)],
  [7, "plugins", Effect.succeed(plugins)],
];

/** The schema version this binary carries: the highest embedded migration id. */
export const binaryVersion: number = migrations.reduce((highest, [id]) => Math.max(highest, id), 0);
