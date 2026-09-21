/**
 * `settings.read` and `settings.update`.
 *
 * Two scopes, one closed key set each, declared once in the contract. A key
 * that is not set is absent from the answer rather than defaulted: the default
 * lives with whoever reads the key, so nothing here has to know what one is.
 *
 * An unknown key is refused by the payload schema before this runs
 * (`closedStruct` in the contract says how), which is why a patch that reaches
 * this method holds only keys the store declares.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  validation,
  type Forbidden,
  type SettingsPatch,
  type SettingsState,
  type Unauthenticated,
  type Validation,
} from "@hercule/contract";
import { currentUser, USER_ACTOR } from "../actor";
import { connectionRepository, isGithubConnection } from "../connections";
import { withTransaction } from "../db";
import { AuditLog } from "../events";
import { Settings, type SettingError, type TypedScope } from "./repository";

/** One key a patch writes, named by its scope: what the audit entry records. */
interface WrittenKey {
  readonly scope: TypedScope;
  readonly key: string;
}

/** The one key whose value names another record, which has to be the right one. */
const THREAD_GITHUB = "thread.githubConnectionId";

const NOT_GITHUB = "that connection is not a github one";

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const settings = yield* Settings;
  const connections = yield* connectionRepository;
  const audit = yield* AuditLog;

  /**
   * A thread with no checkout of its own pushes as this account, so a key
   * naming something that is not a GitHub connection would be a setting that
   * can only fail later, on a machine.
   */
  const checkedGithubConnection = (
    patch: SettingsPatch,
  ): Effect.Effect<void, Validation | SqlError> =>
    Effect.gen(function* () {
      const connectionId = patch.user?.[THREAD_GITHUB];
      if (connectionId === undefined || connectionId === null) return;
      const found = yield* connections.one(connectionId);
      if (Option.isNone(found) || !isGithubConnection(found.value)) {
        return yield* Effect.fail(
          validation([{ path: ["user", THREAD_GITHUB], message: NOT_GITHUB }]),
        );
      }
    });

  const state = (userId: string): Effect.Effect<SettingsState, SettingError | SqlError> =>
    Effect.all({ controller: settings.all(), user: settings.allForUser(userId) });

  /**
   * Writes one key of a patch. The value came through the key's own schema at
   * the transport, and the store re-encodes it through the same declaration, so
   * the casts are a shape TypeScript cannot follow across an iteration rather
   * than a claim about the value.
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
    /** Everything that is set: the controller's settings, and the caller's own. */
    read: (): Effect.Effect<SettingsState, Unauthenticated | Forbidden | SettingError | SqlError> =>
      Effect.flatMap(currentUser("settings.read"), (actor) => state(actor.userId)),

    /**
     * Writes the keys the patch names and leaves every other key alone, then
     * answers with the whole state: one call is enough to write and to see what
     * the store now holds.
     *
     * The audit entry names the keys and not their values. A setting is not a
     * secret, but the event log is read by the Intake views and kept for at
     * least 90 days, and what a reader needs from it is that these keys changed
     * and who changed them.
     *
     * A patch that names no key is `validation`. It would otherwise answer 200
     * and write an audit row recording a change that did not happen, and the
     * operation that reads the state without writing is `settings.read`.
     */
    update: (
      patch: SettingsPatch,
    ): Effect.Effect<
      SettingsState,
      Unauthenticated | Forbidden | Validation | SettingError | SqlError
    > =>
      Effect.gen(function* () {
        const actor = yield* currentUser("settings.update");
        if (
          Object.keys(patch.controller ?? {}).length === 0 &&
          Object.keys(patch.user ?? {}).length === 0
        ) {
          return yield* Effect.fail(
            validation([{ path: [], message: "name at least one setting to write" }]),
          );
        }
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            // Inside the transaction that writes: a connection deleted between
            // the check and the write would leave a setting naming nothing.
            yield* checkedGithubConnection(patch);
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
            return yield* state(actor.userId);
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
