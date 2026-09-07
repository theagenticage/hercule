/**
 * The instance every registered provider starts with.
 *
 * A fresh install has to be able to offer "Log in to Claude Code" before the
 * user has ever met the instance concept, so the boot opens one instance per
 * provider with the definition's own default config. It is idempotent by "at
 * least one instance per provider": a second boot adds nothing, and a provider
 * whose only instance was deleted gets a fresh one. Seeding only on an empty
 * table was rejected because a provider added in a later release would then
 * never get its default.
 *
 * Nothing holding a credential asked for these rows, so the entry each one
 * writes says the system did: an instance the user can delete, rename and
 * reconfigure would otherwise appear in the log with no beginning.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { SYSTEM_ACTOR } from "../actor";
import { nowIso, withTransaction } from "../db";
import { AuditLog } from "../events";
import { PluginHost } from "../plugins";
import { providerRepository } from "./repository";

export const ensureProviderInstances: Effect.Effect<
  void,
  SqlError,
  SqlClient.SqlClient | PluginHost | AuditLog
> = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const instances = yield* providerRepository;
  const host = yield* PluginHost;
  const audit = yield* AuditLog;
  const registered = yield* host.providers();
  // Keyed by provider id, so two plugins contributing one provider still leave
  // that provider with a single instance.
  const missing = new Map(registered.map((definition) => [definition.id, definition]));
  for (const providerId of yield* instances.providersWithInstance()) missing.delete(providerId);
  if (missing.size === 0) return;
  const at = yield* nowIso;
  yield* withTransaction(
    sql,
    Effect.forEach(
      missing.values(),
      (definition) =>
        Effect.gen(function* () {
          const instance = yield* instances.insert({
            providerId: definition.id,
            name: definition.displayName,
            config: definition.defaultConfig,
            at,
          });
          yield* audit.append({
            kind: "provider.created",
            actor: SYSTEM_ACTOR,
            payload: { instanceId: instance.id, providerId: instance.providerId },
            record: { topic: "provider", id: instance.id },
            at,
          });
        }),
      { discard: true },
    ),
  );
});
