/**
 * `controller.read` and `controller.update`: what this controller says about
 * itself, and the one thing a caller may say back.
 *
 * Three facts today - the identity the runners verify against, the version
 * baked into the binary, and the runner a placement falls back to. Update
 * availability belongs here too, but there is no update check yet, so it is not
 * answered; it gains its field here once it is built.
 *
 * The default runner is stored as a controller setting, because there is no
 * controller table to widen. `runners/` writes that key too, when the first
 * runner joins and when the named one retires. Only this file takes the id from
 * a caller, though, so the check that it names a placeable runner sits here
 * alone, and that is why the settings API does not carry the key.
 *
 * The version comes from `@hercule/home/version`, which `scripts/gen-version.ts`
 * generates at build time: a compiled binary has no `package.json` on disk to
 * read. It is generated into `@hercule/home` because that is the one leaf every
 * role links - the dispatcher prints it for `hercule --version` and the
 * controller answers it here, and neither may depend on the other.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  ControllerUpdateInput,
  createConflictError,
  createDecodeValidationError,
  createValidationError,
  type Conflict,
  type ControllerInfo,
  type Forbidden,
  type Unauthenticated,
  type Validation,
} from "@hercule/contract";
import { VERSION } from "@hercule/home/version";
import { currentUser, USER_ACTOR } from "../actor";
import { nowIso, withTransaction } from "../db";
import { AuditLog } from "../events";
import { ControllerIdentity } from "../identity";
import { RETIRED, runnerRepository } from "../runners";
import { Settings, type SettingError } from "../settings";

const decodeUpdate = Schema.decodeUnknownEffect(ControllerUpdateInput);

const NO_SUCH_RUNNER = "no runner has that id";

/** The other half of the rule `runner.update` enforces: the two never meet. */
const RESERVED = "that runner is reserved, so nothing lands on it by default";

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const identity = yield* ControllerIdentity;
  const settings = yield* Settings;
  const runners = yield* runnerRepository;
  const audit = yield* AuditLog;

  const info = (): Effect.Effect<ControllerInfo, SettingError | SqlError> =>
    Effect.gen(function* () {
      const record = yield* identity.read;
      if (Option.isNone(record)) {
        // The boot creates the identity before anything binds, so a controller
        // answering requests without one is a bug, not a state a caller can do
        // anything about.
        return yield* Effect.die("the controller has no identity row");
      }
      return {
        id: record.value.id,
        publicKey: Buffer.from(record.value.publicKey).toString("base64"),
        version: VERSION,
        defaultRunnerId: yield* settings.defaultRunnerId(),
      };
    });

  return {
    /** The controller's identity, version and default runner. */
    read: (): Effect.Effect<
      ControllerInfo,
      Unauthenticated | Forbidden | SettingError | SqlError
    > => Effect.flatMap(currentUser("controller.read"), info),

    /**
     * Names the runner a placement falls back to. A patch that names no field
     * is accepted and writes nothing, which is what makes this safe to send
     * from a form that may have nothing to say.
     */
    update: (
      input: ControllerUpdateInput,
    ): Effect.Effect<
      ControllerInfo,
      Unauthenticated | Forbidden | Validation | Conflict | SettingError | SqlError
    > =>
      Effect.gen(function* () {
        yield* currentUser("controller.update");
        const patch = yield* Effect.mapError(decodeUpdate(input), createDecodeValidationError);
        if (patch.defaultRunnerId === undefined) return yield* info();
        const chosen = patch.defaultRunnerId;
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            // One clock read, inside the transaction: the row and the event
            // that records it carry the same instant.
            const at = yield* nowIso;
            // Naming the runner already named is not a change: it would
            // otherwise stamp a `controller.updated` row describing nothing.
            if (chosen === (yield* settings.defaultRunnerId())) return yield* info();
            if (chosen !== null) {
              const runner = yield* runners.read(chosen);
              if (Option.isNone(runner)) {
                return yield* Effect.fail(
                  createValidationError([{ path: ["defaultRunnerId"], message: NO_SUCH_RUNNER }]),
                );
              }
              if (runner.value.reserved) return yield* Effect.fail(createConflictError(RESERVED));
              if (runner.value.lifecycle === "retired") {
                return yield* Effect.fail(createConflictError(RETIRED));
              }
            }
            yield* settings.setDefaultRunnerId(chosen, at);
            yield* audit.append({
              kind: "controller.updated",
              actor: USER_ACTOR,
              payload: { defaultRunnerId: chosen },
              at,
            });
            return yield* info();
          }),
        );
      }),
  };
});

/** The controller service. */
export class Controller extends Context.Service<Controller, Effect.Success<typeof make>>()(
  "hercule/controller/controller/Controller",
) {}

export const ControllerLayer: Layer.Layer<
  Controller,
  never,
  SqlClient.SqlClient | ControllerIdentity | Settings | AuditLog
> = Layer.effect(Controller)(make);
