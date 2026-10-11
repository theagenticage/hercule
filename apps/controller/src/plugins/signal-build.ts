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
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { TaskPriority, type Event } from "@hercule/contract";
import { decodeAgainst, PluginError } from "@hercule/plugin-host";
import { connectionRepository, ConnectionTypes } from "../connections";
import { describeFieldIssues, summarizeCause } from "./errors";
import type { RegisteredSignalKind } from "./signal-kinds";

/**
 * The shape a draft must have before the core reads it. The values are
 * checked later, against the `Signal` schema, once the core has added its
 * own actions.
 */
const SignalDraftShape = Schema.Struct({
  title: Schema.String,
  asker: Schema.optionalKey(Schema.String),
  place: Schema.optionalKey(Schema.String),
  priority: Schema.optionalKey(TaskPriority),
  blocks: Schema.Array(Schema.Unknown),
  actions: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      label: Schema.String,
      description: Schema.optionalKey(Schema.String),
      action: Schema.String,
      input: Schema.Record(Schema.String, Schema.Unknown),
      primary: Schema.optionalKey(Schema.Boolean),
      field: Schema.optionalKey(Schema.Struct({ name: Schema.String, placeholder: Schema.String })),
    }),
  ),
});

/** A draft `build` returned, with the shape the core reads. */
export type SignalDraftContent = Schema.Schema.Type<typeof SignalDraftShape>;

const decodeSignalDraft = Schema.decodeUnknownEffect(SignalDraftShape, { errors: "all" });

export const signalBuilds = Effect.gen(function* () {
  const connections = yield* connectionRepository;
  const connectionTypes = yield* ConnectionTypes;

  return {
    /**
     * Runs `kind`'s `build` on `event`, which arrived through the Connection
     * `connectionId`, and returns the draft. Fails with a `PluginError`
     * whose message says why when:
     *
     * - the Connection no longer exists, or its config no longer fits its
     *   type's schema;
     * - `build` fails, or throws;
     * - the draft does not have the shape of a `SignalDraft`.
     */
    run: (
      kind: RegisteredSignalKind,
      event: Event,
      connectionId: string,
    ): Effect.Effect<SignalDraftContent, PluginError | SqlError> =>
      Effect.gen(function* () {
        const connection = yield* connections.one(connectionId);
        if (Option.isNone(connection)) {
          return yield* Effect.fail(
            new PluginError({ message: `the Connection ${connectionId} no longer exists` }),
          );
        }
        const stored = connection.value;
        const type = yield* connectionTypes.named(stored.type);
        const configSchema = Option.getOrUndefined(type)?.contribution.configSchema;
        const config =
          configSchema === undefined
            ? stored.config
            : yield* Effect.mapError(
                decodeAgainst(configSchema, stored.config),
                (error) =>
                  new PluginError({
                    message: `the Connection's config does not fit its type: ${describeFieldIssues(error)}`,
                  }),
              );
        const built = yield* Effect.exit(
          Effect.suspend(() =>
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
                  id: stored.id,
                  config,
                  accountId: stored.accountId,
                  displayName: stored.displayName,
                },
                credentials: () => connectionTypes.runtimeFor(kind.pluginId).credentials(stored.id),
              },
            ),
          ),
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
