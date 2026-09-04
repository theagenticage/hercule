/**
 * `settings.read` and `settings.update` (spec 11 section 2, Settings).
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
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { Forbidden, SettingsPatch, SettingsState, Unauthenticated } from "@hydra/contract";
import { requireGrant, USER_ACTOR } from "../actor";
import { withTransaction } from "../db";
import { AuditLog } from "../events";
import { Settings, type SettingError, type TypedScope } from "./repository";

/** One key a patch writes, named by its scope: what the audit entry records. */
interface WrittenKey {
  readonly scope: TypedScope;
  readonly key: string;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const settings = yield* Settings;
  const audit = yield* AuditLog;

  const state = (): Effect.Effect<SettingsState, SettingError | SqlError> =>
    Effect.all({ controller: settings.all("controller"), user: settings.all("user") });

  /**
   * Writes one scope's half of a patch. The value came through the key's own
   * schema at the transport, and the store re-encodes it through the same
   * declaration, so the cast is a shape TypeScript cannot follow across an
   * iteration rather than a claim about the value.
   */
  const set = settings.set as (
    scope: TypedScope,
    key: string,
    value: unknown,
  ) => Effect.Effect<void, SettingError | SqlError>;

  const writeScope = (
    scope: TypedScope,
    values: Readonly<Record<string, unknown>>,
  ): Effect.Effect<ReadonlyArray<WrittenKey>, SettingError | SqlError> =>
    Effect.forEach(Object.keys(values).sort(), (key) =>
      Effect.as(set(scope, key, values[key]), { scope, key }),
    );

  return {
    /** Everything that is set, in both scopes. */
    read: (): Effect.Effect<SettingsState, Unauthenticated | Forbidden | SettingError | SqlError> =>
      Effect.andThen(requireGrant("settings.read"), state()),

    /**
     * Writes the keys the patch names and leaves every other key alone, then
     * answers with the whole state: one call is enough to write and to see what
     * the store now holds.
     *
     * The audit entry names the keys and not their values. A setting is not a
     * secret, but the event log is read by the Intake views and kept for at
     * least 90 days (spec 13 section 11), and what a reader needs from it is
     * that these keys changed and who changed them.
     */
    update: (
      patch: SettingsPatch,
    ): Effect.Effect<SettingsState, Unauthenticated | Forbidden | SettingError | SqlError> =>
      Effect.gen(function* () {
        yield* requireGrant("settings.update");
        return yield* withTransaction(
          Effect.gen(function* () {
            const written = [
              ...(patch.controller === undefined
                ? []
                : yield* writeScope("controller", patch.controller)),
              ...(patch.user === undefined ? [] : yield* writeScope("user", patch.user)),
            ];
            yield* audit.append({
              kind: "settings.updated",
              actor: USER_ACTOR,
              payload: { keys: written },
            });
            return yield* state();
          }),
        );
      }).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
  };
});

/** The settings service (ADR 0031: every operation is a method on an Effect service). */
export class SettingsOperations extends Context.Service<
  SettingsOperations,
  Effect.Success<typeof make>
>()("hydra/controller/settings/SettingsOperations") {}

export const SettingsOperationsLayer: Layer.Layer<
  SettingsOperations,
  never,
  SqlClient.SqlClient | Settings | AuditLog
> = Layer.effect(SettingsOperations)(make);
