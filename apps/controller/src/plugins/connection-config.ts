/**
 * Decodes the config a Connection stores against the schema of its
 * Connection type, for the code that hands that config to a plugin.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { decodeAgainst, PluginError } from "@hercule/plugin-host";
import type { ConnectionTypes, StoredConnection } from "../connections";
import { describeFieldIssues } from "./errors";

/**
 * Decodes the connection's config against its type's config schema and
 * returns the decoded value. A type that has left the catalog or declares no
 * schema returns the config as stored. Fails with a `PluginError` naming
 * each field that no longer fits, which happens when the schema changed since
 * the config was saved.
 */
export const decodeConnectionConfig = (
  connectionTypes: ConnectionTypes["Service"],
  connection: StoredConnection,
): Effect.Effect<unknown, PluginError> =>
  Effect.flatMap(connectionTypes.named(connection.type), (type) => {
    const configSchema = Option.getOrUndefined(type)?.contribution.configSchema;
    return configSchema === undefined
      ? Effect.succeed(connection.config)
      : Effect.mapError(
          decodeAgainst(configSchema, connection.config),
          (error) =>
            new PluginError({
              message: `the Connection's config does not fit its type: ${describeFieldIssues(error)}`,
            }),
        );
  });
