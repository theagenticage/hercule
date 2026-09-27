/**
 * The operations `settings.read` and `settings.update`.
 *
 * There are two scopes, each with a fixed set of keys declared once in the
 * contract. A key that is not set is absent from the response rather than
 * given a default: the default lives in the code that reads the key, so
 * nothing here needs to know it.
 *
 * The payload schema rejects an unknown key before `update` runs (see
 * `closedStruct` in the contract), so a patch that reaches `update` holds only
 * declared keys.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  createValidationError,
  type Forbidden,
  type SettingsPatch,
  type SettingsState,
  type Unauthenticated,
  type Validation,
} from "@hercule/contract";
import { requireUserActor, USER_ACTOR } from "../actor";
import { connectionRepository, isGithubConnection } from "../connections";
import { withTransaction } from "../db";
import { AuditLog } from "../events";
import { Settings, type SettingError, type TypedScope } from "./repository";

/** One key a patch writes, with its scope. The audit entry records a list of these. */
interface WrittenKey {
  readonly scope: TypedScope;
  readonly key: string;
}

/** The only key whose value is the id of another record, so it must be checked. */
const GITHUB_DEFAULT = "github.defaultConnectionId";

const NOT_GITHUB = "that connection is not a GitHub connection";

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const settings = yield* Settings;
  const connections = yield* connectionRepository;
  const audit = yield* AuditLog;

  /**
   * Checks that `github.defaultConnectionId`, when the patch sets it, is the
   * id of a GitHub connection. Fails with a validation error otherwise.
   *
   * A Thread with no workspace, and an assistant's conversation session, push
   * as this account, so any other id would be a setting that only fails
   * later, on a runner.
   */
  const validateGithubConnection = (
    patch: SettingsPatch,
  ): Effect.Effect<void, Validation | SqlError> =>
    Effect.gen(function* () {
      const connectionId = patch.user?.[GITHUB_DEFAULT];
      if (connectionId === undefined || connectionId === null) return;
      const found = yield* connections.one(connectionId);
      if (Option.isNone(found) || !isGithubConnection(found.value)) {
        return yield* Effect.fail(
          createValidationError([{ path: ["user", GITHUB_DEFAULT], message: NOT_GITHUB }]),
        );
      }
    });

  const readSettingsState = (
    userId: string,
  ): Effect.Effect<SettingsState, SettingError | SqlError> =>
    Effect.all({ controller: settings.all(), user: settings.allForUser(userId) });

  /**
   * `settings.set` and `settings.setForUser`, with the key typed as a plain
   * string. The transport already decoded each value with its key's schema,
   * and the store encodes it again with the same schema. So the casts only
   * work around types that TypeScript cannot follow through a loop over keys;
   * they do not skip any check of the value.
   */
  const setController = settings.set as (
    key: string,
    value: unknown,
  ) => Effect.Effect<void, SettingError | SqlError>;

  const setUser = settings.setForUser as (
    userId: string,
    key: string,
    value: unknown,
  ) => Effect.Effect<void, SettingError | SqlError>;

  const writeScope = (
    scope: TypedScope,
    userId: string,
    values: Readonly<Record<string, unknown>>,
  ): Effect.Effect<ReadonlyArray<WrittenKey>, SettingError | SqlError> =>
    Effect.forEach(Object.keys(values).sort(), (key) =>
      Effect.as(
        scope === "controller"
          ? setController(key, values[key])
          : setUser(userId, key, values[key]),
        { scope, key },
      ),
    );

  return {
    /** Returns every setting that is set: the controller's settings and the caller's own. */
    read: (): Effect.Effect<SettingsState, Unauthenticated | Forbidden | SettingError | SqlError> =>
      Effect.flatMap(requireUserActor("settings.read"), (actor) => readSettingsState(actor.userId)),

    /**
     * Writes the keys in the patch and leaves every other key unchanged, then
     * returns all settings, so one call both writes and shows the result.
     *
     * The audit entry lists the keys but not their values. A setting is not a
     * secret, but the Intake views read the event log and it is kept for at
     * least 90 days, and a reader only needs to know which keys changed and who
     * changed them.
     *
     * A patch with no key fails with a validation error. Otherwise it would
     * succeed and write an audit entry for a change that did not happen. To
     * read the settings without writing, use `settings.read`.
     */
    update: (
      patch: SettingsPatch,
    ): Effect.Effect<
      SettingsState,
      Unauthenticated | Forbidden | Validation | SettingError | SqlError
    > =>
      Effect.gen(function* () {
        const actor = yield* requireUserActor("settings.update");
        if (
          Object.keys(patch.controller ?? {}).length === 0 &&
          Object.keys(patch.user ?? {}).length === 0
        ) {
          return yield* Effect.fail(
            createValidationError([{ path: [], message: "name at least one setting to write" }]),
          );
        }
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            // Check inside the transaction that writes: a connection deleted
            // between the check and the write would leave the setting pointing
            // at nothing.
            yield* validateGithubConnection(patch);
            const written = [
              ...(patch.controller === undefined
                ? []
                : yield* writeScope("controller", actor.userId, patch.controller)),
              ...(patch.user === undefined
                ? []
                : yield* writeScope("user", actor.userId, patch.user)),
            ];
            yield* audit.append({
              kind: "settings.updated",
              actor: USER_ACTOR,
              payload: { keys: written },
            });
            return yield* readSettingsState(actor.userId);
          }),
        );
      }),
  };
});

/** The settings service. */
export class SettingsOperations extends Context.Service<
  SettingsOperations,
  Effect.Success<typeof make>
>()("hercule/controller/settings/SettingsOperations") {}

export const SettingsOperationsLayer: Layer.Layer<
  SettingsOperations,
  never,
  SqlClient.SqlClient | Settings | AuditLog
> = Layer.effect(SettingsOperations)(make);
