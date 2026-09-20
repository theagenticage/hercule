/**
 * What a provider instance is once the row and the provider behind it are both
 * in hand, and what a machine's stored snapshot says about running it.
 *
 * Whoever opens, forks or steers a session needs the same two answers, so they
 * are given once here rather than re-derived per caller.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { ProviderDefinition } from "@hercule/plugin-host";
import { validation, type Validation } from "@hercule/contract";
import { PluginHost } from "../plugins";
import { providerRepository, type StoredSnapshot } from "./repository";

/** Why no machine can take a session on this instance: none of them is logged in to it. */
export const NO_PLACEMENT =
  "no connected runner is logged in to that provider instance; log in on a machine first";

/** What an instance is, once the row and the provider behind it are both in hand. */
export interface Resolved {
  readonly definition: ProviderDefinition;
  readonly snapshots: ReadonlyArray<StoredSnapshot>;
}

/**
 * A machine's own word that it can run an instance: the stored capability
 * snapshot saying it is logged in. Read, never probed.
 */
export const loggedIn = (snapshot: StoredSnapshot): boolean => snapshot.auth.status === "ok";

/**
 * An instance and the provider definition behind it, or a `validation` saying
 * why not. Built once per service, the way a repository is, so the catalog and
 * the rows behind it are reached through the caller's own context.
 */
export const resolvedInstance: Effect.Effect<
  (instanceId: string) => Effect.Effect<Resolved, Validation | SqlError | Schema.SchemaError>,
  never,
  SqlClient.SqlClient | PluginHost
> = Effect.gen(function* () {
  const instances = yield* providerRepository;
  const host = yield* PluginHost;

  return (instanceId: string) =>
    Effect.gen(function* () {
      const found = yield* instances.one(instanceId);
      if (Option.isNone(found)) {
        return yield* Effect.fail(
          validation([{ path: ["instanceId"], message: "no such provider instance" }]),
        );
      }
      const registered = yield* host.providers();
      const definition = registered.find((one) => one.id === found.value.providerId);
      if (definition === undefined) {
        return yield* Effect.fail(
          validation([
            {
              path: ["instanceId"],
              message: `this build carries no ${found.value.providerId} provider`,
            },
          ]),
        );
      }
      return {
        definition,
        snapshots: yield* instances.snapshotsOf(instanceId),
      };
    });
});
