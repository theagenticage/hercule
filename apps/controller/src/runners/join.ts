/**
 * Enlisting a machine that presented a join token.
 *
 * This is not an operation and it is not on `RunnerService`: no grant reaches
 * it, because a machine holding a join token is not a user and holds nothing on
 * the public API. What it presents is the token itself, which is why the method
 * takes it as an argument and answers `unauthenticated` when it is not one to
 * spend.
 *
 * The row it writes is stamped `system`: nothing holding a credential asked for
 * it. A runner is never an actor.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { unauthenticated, type Unauthenticated } from "@hydra/contract";
import type { JoinAnswer } from "@hydra/protocol";
import { SYSTEM_ACTOR } from "../actor";
import { hashToken, mintToken } from "../credentials";
import { nowIso, withTransaction } from "../db";
import { AuditLog } from "../events";
// Taken from the identity repository rather than from that domain's index,
// which also reaches the service that reads runners: importing through it would
// make the two domains circular.
import { ControllerIdentity } from "../identity/repository";
import { Settings, type SettingError } from "../settings";
import { JoinTokens } from "./join-tokens";
import { pickName } from "./names";
import { runnerRepository } from "./repository";

/**
 * What a machine is told when its token is refused. It never says which of
 * unminted, already spent and expired it was: the presenter has the same
 * nothing to do in all three cases, and the difference is a probe.
 */
const NO_JOIN = "that is not a join token";

/** One, until the machine has said how much memory it has. */
const INITIAL_MAX_CONCURRENT_SESSIONS = 1;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const runners = yield* runnerRepository;
  const joinTokens = yield* JoinTokens;
  const identity = yield* ControllerIdentity;
  const settings = yield* Settings;
  const audit = yield* AuditLog;

  return {
    /**
     * Enlists the machine that presented this token, and hands it the durable
     * credential it will hold its socket with.
     *
     * One transaction spends the token and writes the row, so a token cannot be
     * spent by an enlistment that then fails, and two machines racing with the
     * same token cannot both be enlisted.
     *
     * The runner is `offline` because joining is not connecting: it becomes
     * `online` when it holds a socket, which is its own exchange.
     */
    join: (token: string): Effect.Effect<JoinAnswer, Unauthenticated | SettingError | SqlError> =>
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
            // The boot creates the identity before anything binds, so serving a
            // join without one is a bug rather than a state to answer.
            return yield* Effect.die("the controller has no identity row");
          }
          const credential = mintToken();
          const fleet = yield* runners.names();
          const name = pickName(fleet);
          const enlisted = yield* runners.insert({
            name,
            state: "offline",
            labels: [],
            maxConcurrentSessions: INITIAL_MAX_CONCURRENT_SESSIONS,
            credentialHash: hashToken(credential),
            at,
          });
          // The fleet's first member is what work falls back to until somebody
          // chooses otherwise. Only the first: a default a person set, and a
          // default a person cleared, are both choices, and the next machine to
          // join may take neither. The entry below says when it happened,
          // because nothing else would - this is the one writer of the setting
          // that no user asked for.
          const tookTheDefault = fleet.size === 0 && (yield* settings.defaultRunnerId()) === null;
          if (tookTheDefault) yield* settings.setDefaultRunnerId(enlisted.id, at);
          yield* audit.append({
            kind: "runner.joined",
            actor: SYSTEM_ACTOR,
            record: { topic: "runner", id: enlisted.id },
            payload: {
              runnerId: enlisted.id,
              name,
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

/** The join exchange. */
export class RunnerJoin extends Context.Service<RunnerJoin, Effect.Success<typeof make>>()(
  "hydra/controller/runners/RunnerJoin",
) {}

export const RunnerJoinLayer: Layer.Layer<
  RunnerJoin,
  never,
  SqlClient.SqlClient | JoinTokens | ControllerIdentity | Settings | AuditLog
> = Layer.effect(RunnerJoin)(make);
