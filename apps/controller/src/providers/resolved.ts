/**
 * Resolves a provider instance to its row and the provider definition behind
 * it, and checks from a runner's stored snapshot whether the runner can run it.
 *
 * Opening, forking and steering a session all need both, so they are
 * defined once here rather than in each caller.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { ProviderDefinition } from "@hercule/plugin-host";
import { createValidationError, type Validation } from "@hercule/contract";
import { PluginHost } from "../plugins";
import { providerRepository, type StoredSnapshot } from "./repository";

/** The error message when no runner can take a session on this instance, because none is logged in to it. */
export const NO_PLACEMENT =
  "no connected runner is logged in to that provider instance; log in on a machine first";

/** A provider instance's provider definition and its stored snapshots, one per runner. */
export interface Resolved {
  readonly definition: ProviderDefinition;
  readonly snapshots: ReadonlyArray<StoredSnapshot>;
}

/**
 * Checks whether a runner's stored capability snapshot shows it is logged in
 * to the instance, which means it can run the instance. Reads the stored
 * snapshot and never probes the runner.
 */
export const isLoggedIn = (snapshot: StoredSnapshot): boolean => snapshot.auth.status === "ok";

/**
 * Builds a function that resolves an instance id to its provider definition
 * and snapshots. The function fails with a validation error if the instance
 * does not exist, or if this build has no such provider. Each service builds
 * it once, as it does a repository, so the plugin catalog and the rows are
 * read through the caller's own context.
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
          createValidationError([{ path: ["instanceId"], message: "no such provider instance" }]),
        );
      }
      const registered = yield* host.providers();
      const definition = registered.find((one) => one.id === found.value.providerId);
      if (definition === undefined) {
        return yield* Effect.fail(
          createValidationError([
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
