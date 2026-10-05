/**
 * What a fresh database gets at first run: the three shipped permission
 * profiles and the controller-scope settings defaults.
 *
 * Seeding is idempotent and runs on every boot, so a database created before
 * a new default gains it. It only inserts what is absent: a shipped profile the
 * user has edited and a setting the user has changed both stay unchanged,
 * because otherwise a restart would silently revert them.
 *
 * As a deliberate consequence, a shipped profile stays as the boot that first
 * seeded it wrote it. The three shipped profiles are editable, so a later
 * Hercule that adds a grant to one of them cannot overwrite the user's
 * version; adding the grant takes a migration, not a seed.
 */
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { ALL_GRANTS, type Grant } from "@hercule/contract";
import { withTransaction } from "./db";
import { PermissionProfiles, type GrantsError } from "./permissions";
import { Settings, type SettingError } from "./settings";

/**
 * The shipped profiles.
 *
 * The assistant profile gets `connection.use`, so an assistant can act
 * through the user's Connections as the user would: start a run that picks
 * the Connection a step acts through, or post an event of a plugin's kind.
 * Its sessions already get the token of the user's default GitHub
 * Connection, so on GitHub the grant adds little the token did not give.
 *
 * The worker profile gets `notification.read` as well as `notification.write`:
 * every other family lists its read verb explicitly, and without it a worker
 * could create a notification it cannot read back.
 */
export const SHIPPED_PROFILES: ReadonlyArray<{
  readonly name: string;
  readonly grants: ReadonlyArray<Grant>;
}> = [
  {
    name: "assistant",
    grants: [
      "task.read",
      "task.create",
      "task.update",
      "task.delete",
      "workflow.read",
      "run.read",
      "run.start",
      "run.write",
      "session.read",
      "session.spawn",
      "session.steer",
      "subscription.read",
      "subscription.write",
      "notification.read",
      "notification.write",
      "settings.read",
      "event.read",
      "event.emit",
      "connection.read",
      "connection.use",
      "infra.read",
      "workspace.read",
      "agent.read",
      "memory.read",
      "memory.write",
      "permission.read",
      "project.read",
      "resource.read",
    ],
  },
  {
    name: "worker",
    grants: [
      "task.read",
      "task.create",
      "task.update",
      "run.read",
      "subscription.read",
      "subscription.write",
      "notification.read",
      "notification.write",
      "event.read",
    ],
  },
  // Everything the user can do, with nothing withheld.
  { name: "unrestricted", grants: ALL_GRANTS },
];

/**
 * Brings the database up to the shipped defaults. Runs in one transaction, so a
 * boot interrupted halfway leaves nothing half-seeded.
 */
export const seed: Effect.Effect<
  void,
  SettingError | GrantsError | SqlError,
  Settings | PermissionProfiles | SqlClient
> = Effect.gen(function* () {
  const sql = yield* SqlClient;
  return yield* withTransaction(
    sql,
    Effect.gen(function* () {
      const profiles = yield* PermissionProfiles;
      const settings = yield* Settings;

      for (const profile of SHIPPED_PROFILES) {
        yield* profiles.ensureShipped(profile.name, profile.grants);
      }
      yield* settings.setIfAbsent("retention.events", 90);
      yield* settings.setIfAbsent("retention.security", 90);
      yield* settings.setIfAbsent("retention.conversations", 90);
      yield* settings.setIfAbsent("backup.time", "03:30");
      yield* settings.setIfAbsent("backup.keep", 14);
    }),
  );
});
