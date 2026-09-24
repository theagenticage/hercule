/**
 * Creates one instance for each registered provider that has none, so a fresh
 * install can offer "Log in to Claude Code" before the user knows about
 * instances. The check is per provider, not "is the table empty", so a
 * provider added in a later release still gets its default instance.
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
  // A map, so two plugins that register the same provider still get one instance.
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
