/**
 * `controller.read` and `controller.update`: information about this
 * controller, and the one field a caller may change.
 *
 * `controller.read` returns four values today:
 *
 * - the identity the runners verify against;
 * - the version built into the binary;
 * - the default runner, which placement falls back to;
 * - the local runner, which this controller started on its own machine.
 *
 * The local runner's id is not stored anywhere. It is read from the running
 * child on every call, through `LocalRunnerId`, so it is null until the child
 * has joined and whenever this controller starts no local runner.
 *
 * Update availability belongs here too, but there is no update check yet, so
 * it is not returned; it will get its field here once it is built.
 *
 * The default runner is stored as a controller setting, because there is no
 * controller table to add a column to. `runners/` also writes that key, when
 * the first runner joins and when the default runner retires. Only this file
 * takes the id from a caller, though, so the check that the id is a runner work
 * can be placed on lives only here. That is why the settings API does not
 * expose the key.
 *
 * The version comes from `@hercule/home/version`, which `scripts/gen-version.ts`
 * generates at build time: a compiled binary has no `package.json` on disk to
 * read. It is generated into `@hercule/home` because that is the one leaf
 * package every role links: the dispatcher prints it for `hercule --version`
 * and the controller returns it here, and neither may depend on the other.
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
import { requireUserActor, USER_ACTOR } from "../actor";
import { nowIso, withTransaction } from "../db";
import { AuditLog } from "../events";
import { ControllerIdentity } from "../identity";
import { LocalRunnerId, RETIRED, runnerRepository } from "../runners";
import { Settings, type SettingError } from "../settings";

const decodeUpdate = Schema.decodeUnknownEffect(ControllerUpdateInput);

const NO_SUCH_RUNNER = "no runner has that id";

/**
 * A reserved runner cannot be the default runner. `runner.update` enforces the
 * same rule from the other side: it rejects reserving the default runner.
 */
const RESERVED = "that runner is reserved, so nothing lands on it by default";

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const identity = yield* ControllerIdentity;
  const settings = yield* Settings;
  const runners = yield* runnerRepository;
  const audit = yield* AuditLog;
  const localRunner = yield* LocalRunnerId;

  const readControllerInfo = (): Effect.Effect<ControllerInfo, SettingError | SqlError> =>
    Effect.gen(function* () {
      const record = yield* identity.read;
      if (Option.isNone(record)) {
        // The boot creates the identity before the controller listens, so a
        // controller serving requests without one is a bug, not something a
        // caller can fix.
        return yield* Effect.die("the controller has no identity row");
      }
      return {
        id: record.value.id,
        publicKey: Buffer.from(record.value.publicKey).toString("base64"),
        version: VERSION,
        defaultRunnerId: yield* settings.defaultRunnerId(),
        localRunnerId: localRunner.read() ?? null,
      };
    });

  return {
    /** Returns the controller's identity, version, default runner and local runner. */
    read: (): Effect.Effect<
      ControllerInfo,
      Unauthenticated | Forbidden | SettingError | SqlError
    > => Effect.flatMap(requireUserActor("controller.read"), readControllerInfo),

    /**
     * Sets or clears the default runner, which placement falls back to, and
     * returns the updated controller information. A patch with no fields is
     * accepted and writes nothing, so a form can send it even when nothing
     * changed.
     *
     * Fails with `Validation` when no runner has the id, and with `Conflict`
     * when the runner is reserved or retired.
     */
    update: (
      input: ControllerUpdateInput,
    ): Effect.Effect<
      ControllerInfo,
      Unauthenticated | Forbidden | Validation | Conflict | SettingError | SqlError
    > =>
      Effect.gen(function* () {
        yield* requireUserActor("controller.update");
        const patch = yield* Effect.mapError(decodeUpdate(input), createDecodeValidationError);
        if (patch.defaultRunnerId === undefined) return yield* readControllerInfo();
        const chosen = patch.defaultRunnerId;
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            // Read the clock once, inside the transaction, so the setting and
            // the audit entry that records it have the same timestamp.
            const at = yield* nowIso;
            // Choosing the runner that is already the default is not a change.
            // Without this check it would write a `controller.updated` entry
            // that describes nothing.
            if (chosen === (yield* settings.defaultRunnerId())) return yield* readControllerInfo();
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
            return yield* readControllerInfo();
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
