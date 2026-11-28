/**
 * The boot step that copies each plugin's status tables onto the External
 * Entities stored before.
 *
 * A status is copied onto an entity when the entity is observed, so a card
 * draws from its row with no plugin running. A thing that stopped changing at
 * its source, such as a merged pull request, is not observed again. Without
 * this step, a status table that a newer plugin changed (a new word, icon or
 * colour) would never reach it.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import { absorbFailures } from "../absorbing";
import { withTransaction } from "../db";
import { PluginHost } from "../plugins";
import { externalEntityRepository } from "./repository";
import { buildStoredStatus } from "./slots";

/**
 * Copies the status tables of every loaded plugin, active or not, onto the
 * stored entities whose status key they declare, and returns how many
 * entities changed. All of it is one transaction.
 */
export const refreshStoredStatuses: Effect.Effect<
  number,
  SqlError,
  SqlClient.SqlClient | PluginHost
> = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const host = yield* PluginHost;
  const entities = yield* externalEntityRepository;
  const loaded = yield* host.loaded();
  const kinds = (yield* Effect.forEach(loaded, (plugin) => host.listEntityKinds(plugin.id))).flat();
  return yield* withTransaction(
    sql,
    Effect.gen(function* () {
      let changed = 0;
      for (const kind of kinds) {
        for (const [key, status] of Object.entries(kind.status ?? {})) {
          changed += yield* entities.rewriteStatus(kind.word, key, buildStoredStatus(kind, status));
        }
      }
      return changed;
    }),
  );
});

/**
 * Runs `refreshStoredStatuses` once the plugins are loaded at boot. A failure
 * is logged and the boot goes on: the stored statuses then stay as they were
 * until each thing is observed again.
 */
export const refreshStoredStatusesOrLog: Effect.Effect<
  void,
  never,
  SqlClient.SqlClient | PluginHost
> = absorbFailures(
  "The stored statuses of External Entities could not be refreshed from the plugins at start",
  Effect.flatMap(refreshStoredStatuses, (changed) =>
    changed === 0
      ? Effect.void
      : Effect.logInfo(
          `Refreshed the stored status of ${String(changed)} External Entities from the plugins`,
        ),
  ),
);
