/**
 * `controller.read`: what this controller says about itself (spec 11 section 2).
 *
 * Two facts today - the identity the runners verify against (ADR 0005) and the
 * version baked into the binary. Spec 11 also lists update availability and the
 * default runner here; neither subsystem exists yet, so neither is answered.
 * The tickets that build them add their fields to the contract and a line here,
 * rather than this returning nulls in the meantime.
 *
 * The version comes from `@hydra/home/version`, which `scripts/gen-version.ts`
 * generates at build time: a compiled binary has no `package.json` on disk to
 * read (spec 15 section 11). It is generated into `@hydra/home` because that is
 * the one leaf every role links - the dispatcher prints it for `hydra
 * --version` and the controller answers it here, and neither may depend on the
 * other.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { ControllerInfo, Forbidden, Unauthenticated } from "@hydra/contract";
import { VERSION } from "@hydra/home/version";
import { currentUser } from "../actor";
import { ControllerIdentity } from "./repository";

const make = Effect.gen(function* () {
  const identity = yield* ControllerIdentity;

  return {
    /** The controller's identity and version. */
    read: (): Effect.Effect<ControllerInfo, Unauthenticated | Forbidden | SqlError> =>
      Effect.gen(function* () {
        yield* currentUser("controller.read");
        const record = yield* identity.read;
        if (Option.isNone(record)) {
          // The boot creates the identity before anything binds, so a
          // controller answering requests without one is a bug, not a state a
          // caller can do anything about.
          return yield* Effect.die("the controller has no identity row");
        }
        return {
          id: record.value.id,
          publicKey: Buffer.from(record.value.publicKey).toString("base64"),
          version: VERSION,
        };
      }),
  };
});

/** The controller service (ADR 0031: every operation is a method on an Effect service). */
export class Controller extends Context.Service<Controller, Effect.Success<typeof make>>()(
  "hydra/controller/identity/Controller",
) {}

export const ControllerLayer: Layer.Layer<Controller, never, ControllerIdentity> =
  Layer.effect(Controller)(make);
