/**
 * Joins a runner that presented a join token.
 *
 * This is not an operation and not on `RunnerService`, and it checks no grant,
 * because a runner holding a join token is not a user. The runner presents the
 * token itself, which is why the method takes it as an argument. The audit
 * entry is stamped `system`, because a runner is never an actor.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { createUnauthenticatedError, type Unauthenticated } from "@hercule/contract";
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
 * The message does not say which case applies (never created, revoked, already
 * used, or expired). The caller has to do the same thing in every case, and
 * telling them apart would help someone probing for valid tokens.
 */
const NO_JOIN =
  "that join token is not valid: it was never created, was revoked, was already used, or has expired. " +
  "Create a new join token and try again";

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const runners = yield* runnerRepository;
  const joinTokens = yield* JoinTokens;
  const identity = yield* ControllerIdentity;
  const settings = yield* Settings;
  const audit = yield* AuditLog;

  return {
    /**
     * Spends the join token and stores the new runner, and returns the
     * runner's id, name and credential. Fails with `Unauthenticated` when the
     * token is not valid.
     *
     * One transaction spends the token and writes the row, so a join that
     * fails does not use up the token, and two runners racing with the same
     * token cannot both join. The runner starts `offline`, because joining is
     * not connecting.
     *
     * `reserved` is set here rather than updated afterwards, so a runner the
     * owner marked as personal is never, even briefly, available for placement.
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
            return yield* Effect.fail(createUnauthenticatedError(NO_JOIN));
          }
          const controller = yield* identity.readOrDie;
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
          // Only the first runner becomes the default, and never a reserved
          // one. A default a person set, or one they cleared, is their choice,
          // and a joining runner must not override either. The audit entry
          // below records it, because this is the one change to the default
          // that no user asked for.
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
            controllerIdentityId: controller.id,
            controllerPublicKey: Buffer.from(controller.publicKey).toString("base64"),
          };
        }),
      ),
  };
});

export class RunnerJoin extends Context.Service<RunnerJoin, Effect.Success<typeof make>>()(
  "hercule/controller/runners/RunnerJoin",
) {}

export const RunnerJoinLayer: Layer.Layer<
  RunnerJoin,
  never,
  SqlClient.SqlClient | JoinTokens | ControllerIdentity | Settings | AuditLog
> = Layer.effect(RunnerJoin)(make);
