/**
 * Runs a signal kind's `build` on one event: the one piece of plugin code in
 * raising a signal (spec 10 §9.2). The caller runs it outside any
 * transaction, because `build` may call the source.
 *
 * The result is the plugin's draft, checked only for its shape. The caller
 * binds the draft's actions and checks the whole signal against the
 * contract, because only the caller knows the core's own actions.
 */
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { Event } from "@hercule/contract";
import { decodeAgainst, PluginError, SignalDraft } from "@hercule/plugin-host";
import { ConnectionTypes, type StoredConnection } from "../connections";
import { describeFieldIssues, summarizeCause } from "./errors";
import type { RegisteredSignalKind } from "./signal-kinds";

/**
 * How long one `build` may run, in seconds. The signal raise step waits for
 * each `build` before it moves on to the next raise, so a `build` that hangs
 * would otherwise hold back every signal behind it.
 */
export const BUILD_TIMEOUT_SECONDS = 30;

const decodeSignalDraft = Schema.decodeUnknownEffect(SignalDraft, { errors: "all" });

export const signalBuilds = Effect.gen(function* () {
  const connectionTypes = yield* ConnectionTypes;

  return {
    /**
     * Runs `kind`'s `build` on `event`, which arrived through `connection`,
     * and returns the draft. Fails with a `PluginError` whose message names
     * the problem when:
     *
     * - the Connection's config no longer fits its type's schema;
     * - `build` fails, throws, or runs longer than `BUILD_TIMEOUT_SECONDS`;
     * - the draft does not have the shape of a `SignalDraft`.
     */
    run: (
      kind: RegisteredSignalKind,
      event: Event,
      connection: StoredConnection,
    ): Effect.Effect<SignalDraft, PluginError> =>
      Effect.gen(function* () {
        const type = yield* connectionTypes.named(connection.type);
        const configSchema = Option.getOrUndefined(type)?.contribution.configSchema;
        const config =
          configSchema === undefined
            ? connection.config
            : yield* Effect.mapError(
                decodeAgainst(configSchema, connection.config),
                (error) =>
                  new PluginError({
                    message: `the Connection's config does not fit its type: ${describeFieldIssues(error)}`,
                  }),
              );
        const build = Effect.suspend(() =>
          kind.build(
            {
              id: event.id,
              kind: event.kind,
              occurredAt: event.occurredAt,
              payload: event.payload,
              refs: event.refs,
              url: event.url,
              title: event.title,
              author: event.author,
            },
            {
              connection: {
                id: connection.id,
                config,
                accountId: connection.accountId,
                displayName: connection.displayName,
              },
              credentials: () =>
                connectionTypes.runtimeFor(kind.pluginId).credentials(connection.id),
            },
          ),
        );
        const built = yield* Effect.exit(
          Effect.timeoutOrElse(Effect.interruptible(build), {
            duration: Duration.seconds(BUILD_TIMEOUT_SECONDS),
            orElse: () =>
              Effect.fail(
                new PluginError({
                  message: `build did not return within ${BUILD_TIMEOUT_SECONDS} seconds`,
                }),
              ),
          }),
        );
        if (Exit.isFailure(built)) {
          // The controller is stopping: the raise stays pending for the next start.
          if (Cause.hasInterrupts(built.cause)) return yield* Effect.failCause(built.cause);
          return yield* Effect.fail(new PluginError({ message: summarizeCause(built.cause) }));
        }
        return yield* Effect.mapError(
          decodeSignalDraft(built.value),
          (error) =>
            new PluginError({
              message: `the draft build returned is not a signal draft: ${describeFieldIssues(error)}`,
            }),
        );
      }),
  };
});
