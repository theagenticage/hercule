/**
 * What a fresh database gets at first run: the three shipped permission
 * profiles (spec 13 section 6.2) and the controller-scope settings defaults
 * (spec 04, spec 15 section 6).
 *
 * Seeding is idempotent and runs on every boot, so a database that predates a
 * new default gains it. It is insert-if-absent throughout: a shipped profile
 * the user has edited and a setting the user has changed both survive
 * untouched, because the alternative is a silent revert on restart.
 *
 * The consequence, and it is deliberate: a shipped profile is frozen at the
 * boot that first seeded it. Spec 13 section 6.2 makes the three shipped
 * profiles editable, so a later Hydra that adds a grant to one of them cannot
 * write it over the user's version; that upgrade is a migration, not a seed.
 */
import { Effect } from "effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { withTransaction } from "./db/client";
import {
  ALL_GRANTS,
  PermissionProfiles,
  type Grant,
  type GrantsError,
} from "./repositories/permissionProfiles";
import { Settings, type SettingError } from "./repositories/settings";

/**
 * The shipped profiles, verbatim from the table in spec 13 section 6.2.
 *
 * One amendment: the worker profile's cell reads `notification` (write) while
 * every other family lists its read verb explicitly, which would leave a worker
 * able to create a notification it cannot read back. It is granted
 * `notification.read` here and the spec table is amended to match (ticket #56).
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
      "workflow.run",
      "workflow.submit",
      "run.read",
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
  // User parity: everything the user can do, withholding nothing.
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
> = withTransaction(
  Effect.gen(function* () {
    const profiles = yield* PermissionProfiles;
    const settings = yield* Settings;

    for (const profile of SHIPPED_PROFILES) {
      yield* profiles.ensureShipped(profile.name, profile.grants);
    }
    yield* settings.setIfAbsent("controller", "retention.events", 90);
    yield* settings.setIfAbsent("controller", "retention.security", 90);
    yield* settings.setIfAbsent("controller", "retention.conversations", 90);
    yield* settings.setIfAbsent("controller", "backup.time", "03:30");
    yield* settings.setIfAbsent("controller", "backup.keep", 14);
  }),
);
