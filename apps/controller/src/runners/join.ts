/**
 * Enlisting a machine that presented a join token.
 *
 * Not an operation and not on `RunnerService`: no grant reaches it, because a
 * machine holding a join token is not a user. It presents the token itself,
 * which is why the method takes it as an argument, and the row it writes is
 * stamped `system` because a runner is never an actor.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { unauthenticated, type Unauthenticated } from "@hercule/contract";
import type { JoinAnswer } from "@hercule/protocol";
import { SYSTEM_ACTOR } from "../actor";
import { hashToken, mintToken } from "../credentials";
import { nowIso, withTransaction } from "../db";
import { AuditLog } from "../events";
import { ControllerIdentity } from "../identity";
import { Settings, type SettingError } from "../settings";
import { JoinTokens } from "./join-tokens";
import { pickName } from "./names";
import { runnerRepository } from "./repository";

/**
 * Never says which of unminted, spent and expired it was: the presenter has the
 * same nothing to do in all three, and the difference is a probe.
 */
const NO_JOIN = "that is not a join token";

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const runners = yield* runnerRepository;
  const joinTokens = yield* JoinTokens;
  const identity = yield* ControllerIdentity;
  const settings = yield* Settings;
  const audit = yield* AuditLog;

  return {
    /**
     * One transaction spends the token and writes the row, so a token cannot be
     * spent by an enlistment that fails, and two machines racing with the same
     * token cannot both be enlisted. The runner is `offline` because joining is
     * not connecting.
     *
     * `reserved` is taken here rather than patched afterwards so a machine the
     * owner called personal is never, for an instant, one the fleet may place on.
     */
    join: (
      token: string,
      reserved: boolean,
    ): Effect.Effect<JoinAnswer, Unauthenticated | SettingError | SqlError> =>
      withTransaction(
        sql,
        Effect.gen(function* () {
          const at = yield* nowIso;
          const invitation = yield* joinTokens.spend(token, at);
          if (Option.isNone(invitation)) {
            return yield* Effect.fail(unauthenticated(NO_JOIN));
          }
          const controller = yield* identity.read;
          if (Option.isNone(controller)) {
            // The boot creates the identity before anything binds, so this is a
            // bug rather than a state to answer.
            return yield* Effect.die("the controller has no identity row");
          }
          const credential = mintToken();
          const fleet = yield* runners.names();
          const name = pickName(fleet);
          const enlisted = yield* runners.insert({
            name,
            connectivity: "offline",
            lifecycle: "active",
            reserved,
            labels: [],
            credentialHash: hashToken(credential),
            at,
          });
          // Only the first, and never a reserved one: a default a person set and
          // one they cleared are both choices, and the next machine to join may
          // take neither. The entry below records it, since this is the one
          // writer no user asked for.
          const tookTheDefault =
            !reserved && fleet.size === 0 && (yield* settings.defaultRunnerId()) === null;
          if (tookTheDefault) yield* settings.setDefaultRunnerId(enlisted.id, at);
          yield* audit.append({
            kind: "runner.joined",
            actor: SYSTEM_ACTOR,
            record: { topic: "runner", id: enlisted.id },
            payload: {
              runnerId: enlisted.id,
              name,
              reserved,
              joinTokenId: invitation.value,
              becameDefaultRunner: tookTheDefault,
            },
            at,
          });
          return {
            runnerId: enlisted.id,
            name,
            credential,
            controllerIdentityId: controller.value.id,
            controllerPublicKey: Buffer.from(controller.value.publicKey).toString("base64"),
          };
        }),
      ),
  };
});

export class RunnerJoin extends Context.Service<RunnerJoin, Effect.Success<typeof make>>()(
  "hydra/controller/runners/RunnerJoin",
) {}

export const RunnerJoinLayer: Layer.Layer<
  RunnerJoin,
  never,
  SqlClient.SqlClient | JoinTokens | ControllerIdentity | Settings | AuditLog
> = Layer.effect(RunnerJoin)(make);
