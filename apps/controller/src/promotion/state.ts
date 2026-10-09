/**
 * Where this controller stands in a promotion (spec 03 section 8), and the
 * gate every writer passes through.
 *
 * The controller is in one of three phases:
 *
 * - **serving**: the normal phase. Requests and background work run.
 * - **frozen**: a machine holding a promotion token is pulling a copy of the
 *   data. Nothing may write, because a write after the copy would be lost on
 *   the new machine. Mutating requests are refused, and background work waits.
 *   The freeze ends with a seal, with a cancel from the new machine, with a
 *   transfer that broke, or at the token's expiry, whichever comes first.
 * - **sealed**: the new machine took over. The controller refuses every
 *   request and points runners at the new address. Only `hercule serve
 *   --force-unseal` leaves this phase.
 *
 * The freeze lives in memory only. A controller that restarts while frozen
 * comes back serving, and the switch for that transfer is refused, so the new
 * machine discards what it received. The seal is persisted before it takes
 * effect, so a sealed controller stays sealed across restarts.
 *
 * Work is counted while it runs. A freeze waits until the count reaches zero,
 * so the copy starts only after every request and background pass that began
 * before the freeze has finished. A workflow run passes the gate at each of
 * its transactions, not for its whole length, so a step that waits for an
 * hour never holds up a freeze. A runner's session reports pass the gate
 * too, so they wait while frozen. Those a runner sends between the copy and
 * the switch are written on neither machine, and are lost (spec 03 section
 * 8.2).
 *
 * Work started inside admitted work, on the same fiber or a forked one, is
 * let in and counted while the outer work runs. A forked fiber that outlives
 * the outer work passes the gate on its own for whatever it starts next.
 */
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  createControllerSealedError,
  createInvalidStateError,
  createPromotionInProgressError,
  type ControllerSealed,
  type InvalidState,
  type PromotionInProgress,
} from "@hercule/contract";
import { encodeForwardingPointerBytes, type ForwardingPointer } from "@hercule/protocol";
import { SYSTEM_ACTOR } from "../actor";
import { nowIso, uuidFromString, uuidToString, withTransaction } from "../db";
import { AuditLog } from "../events";
import { ControllerIdentity } from "../identity";
import type { SecretNameError } from "../secrets";

/** What a sealed controller tells runners and callers: where the data went, signed. */
export interface Seal {
  /** The promotion token whose transfer this seal ends. */
  readonly tokenId: string;
  readonly newAddress: string;
  /** The controller identity's Ed25519 signature over the forwarding pointer bytes. */
  readonly signature: Uint8Array<ArrayBuffer>;
}

/** Builds the frame that tells a runner where a sealed controller moved. */
export const buildForwardingPointer = (seal: Seal): ForwardingPointer => ({
  _tag: "forwardingPointer",
  newAddress: seal.newAddress,
  signature: Buffer.from(seal.signature).toString("base64"),
});

/** The three phases a controller can be in. */
export type PromotionPhase =
  | { readonly _tag: "Serving" }
  | { readonly _tag: "Frozen"; readonly tokenId: string }
  | { readonly _tag: "Sealed"; readonly seal: Seal };

/** A phase in which work does not run. */
type StoppedPhase = Exclude<PromotionPhase, { readonly _tag: "Serving" }>;

/** What the gate decides from: the phase, and how much admitted work is running. */
interface GateState {
  readonly phase: PromotionPhase;
  /** How many admitted requests and background passes are running now. */
  readonly running: number;
}

/**
 * How long a freeze waits for running work to finish. An ingest poll may take
 * minutes, but a controller that is that busy is not ready to move anyway.
 */
const DRAIN_TIMEOUT: Duration.Duration = Duration.seconds(60);

/** Lets tests set a drain timeout short enough to wait for. */
export const PromotionDrainTimeout = Context.Reference<Duration.Duration>(
  "hercule/controller/promotion/PromotionDrainTimeout",
  { defaultValue: (): Duration.Duration => DRAIN_TIMEOUT },
);

/** One unit of admitted work, which is running until it ends. */
interface Admission {
  running: boolean;
}

/**
 * The admitted work that the current work was started inside, if any.
 *
 * Work started inside admitted work is let in even while a freeze waits:
 * holding it would make the freeze wait for the outer work while the inner
 * work waits for the freeze to end. It is still counted, so the freeze also
 * waits for it. A fiber forked inside admitted work sees the same admission,
 * and may outlive it: once the outer work has ended, the fiber's next work
 * goes through the gate like any other.
 */
const Inside = Context.Reference<Admission | undefined>("hercule/controller/promotion/Inside", {
  defaultValue: () => undefined,
});

/** Returns the message a sealed controller answers every request with. */
export const describeSeal = (newAddress: string): string =>
  `This controller has moved to ${newAddress} and no longer serves. Point your clients ` +
  `there: \`hercule login ${newAddress} --username <name>\`. Runners follow on their own. To serve ` +
  `from this machine again, run \`hercule serve --force-unseal\`.`;

const FROZEN =
  "A promotion is moving this controller's data to another machine, so nothing can be " +
  "changed right now. Reading still works. Try again once the promotion has finished or " +
  "was cancelled.";

/** Creates the error a sealed controller refuses a request with. */
export const createSealedError = (seal: Seal): ControllerSealed =>
  createControllerSealedError(describeSeal(seal.newAddress), seal.newAddress);

const ANOTHER_TRANSFER =
  "Another promotion transfer is already in progress. Wait for it to finish, or for its " +
  "token to expire, and try again.";

/** The controller's promotion phase, and the gate for writers. */
export class PromotionState extends Context.Service<
  PromotionState,
  {
    /** Returns the current phase. */
    readonly phase: Effect.Effect<PromotionPhase>;

    /**
     * Succeeds when a promotion transfer could start now. Fails with
     * `PromotionInProgress` while frozen for another transfer, and with
     * `ControllerSealed` once sealed. Changes nothing.
     */
    readonly refuseTransferUnlessServing: Effect.Effect<
      void,
      PromotionInProgress | ControllerSealed
    >;

    /**
     * Runs `work` counted, if the controller is serving. Fails at once with
     * `PromotionInProgress` while frozen and with `ControllerSealed` once
     * sealed. For requests, whose caller can retry.
     */
    readonly admit: <A, E, R>(
      work: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | PromotionInProgress | ControllerSealed, R>;

    /**
     * Runs `work` counted once the controller is serving. Waits while frozen.
     * Never runs it once sealed, and never returns either: a sealed
     * controller has handed its work to the new machine, and it stays sealed
     * until the process is restarted. For background work, which has no
     * caller to refuse.
     */
    readonly whenServing: <A, E, R>(work: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;

    /**
     * Freezes the controller for the transfer of `tokenId`, then waits for
     * the work that is running to finish. Does not schedule the token's
     * expiry: the caller asks `PromotionExpiry` to thaw at that deadline, so
     * the timer lives in the controller daemon (ADR 0033). Fails with
     * `PromotionInProgress` when another transfer holds the freeze, with
     * `ControllerSealed` when sealed, and with `InvalidState` when the
     * running work did not finish within the drain timeout, after thawing.
     */
    readonly freeze: (
      tokenId: string,
    ) => Effect.Effect<void, PromotionInProgress | ControllerSealed | InvalidState>;

    /**
     * Ends the freeze of `tokenId`, and returns whether it did. Returns false
     * when the controller is serving or frozen for another token. Fails with
     * `ControllerSealed` once sealed, because the data has moved and a thaw
     * can no longer undo that.
     */
    readonly thaw: (tokenId: string) => Effect.Effect<boolean, ControllerSealed | SqlError>;

    /**
     * Seals the controller for the transfer of `tokenId` and returns the seal.
     * Signs the forwarding pointer, persists the seal, and only then stops
     * serving. Returns the stored seal again when that token already sealed
     * it. Fails with `ControllerSealed` when another token sealed it, and
     * with `InvalidState` when the controller is not frozen for that token,
     * because the transfer was cancelled or timed out, or the controller
     * restarted.
     */
    readonly seal: (
      tokenId: string,
      newAddress: string,
    ) => Effect.Effect<Seal, InvalidState | ControllerSealed | SqlError | SecretNameError>;

    /**
     * Loads the seal at boot. With `forceUnseal`, deletes it instead and logs
     * that this machine serves again, which is disaster recovery: the machine
     * the data moved to may still be serving under the same identity.
     */
    readonly restore: (options: { readonly forceUnseal: boolean }) => Effect.Effect<void, SqlError>;
  }
>()("hercule/controller/promotion/PromotionState") {}

export const PromotionStateLayer: Layer.Layer<
  PromotionState,
  never,
  SqlClient.SqlClient | ControllerIdentity | AuditLog
> = Layer.effect(
  PromotionState,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const identity = yield* ControllerIdentity;
    const audit = yield* AuditLog;
    const gate = yield* SubscriptionRef.make<GateState>({
      phase: { _tag: "Serving" },
      running: 0,
    });
    // Freeze, thaw, seal and restore each read the phase and then change it,
    // and a seal writes the database in between. One at a time, so a thaw at
    // the deadline cannot land between a seal's check and its write.
    const transitions = yield* Semaphore.make(1);

    const setPhase = (phase: PromotionPhase) =>
      SubscriptionRef.update(gate, (current) => ({ ...current, phase }));

    const release = SubscriptionRef.update(gate, (current) => ({
      ...current,
      running: current.running - 1,
    }));

    /** Waits until the gate state matches, including when it already does. */
    const awaitGateState = (matches: (current: GateState) => boolean) =>
      SubscriptionRef.changes(gate).pipe(Stream.filter(matches), Stream.runHead, Effect.asVoid);

    /**
     * Counts one more running unit of work if the controller is serving, and
     * returns the phase that stopped it otherwise. One atomic step, so a
     * freeze cannot start between the phase check and the count.
     */
    const enter = SubscriptionRef.modify(
      gate,
      (current): readonly [StoppedPhase | undefined, GateState] =>
        current.phase._tag === "Serving"
          ? [undefined, { ...current, running: current.running + 1 }]
          : [current.phase, current],
    );

    /** Counts one more running unit of work, whatever the phase. */
    const enterInside = Effect.as(
      SubscriptionRef.update(gate, (current) => ({ ...current, running: current.running + 1 })),
      undefined,
    );

    const refuseTransferUnlessServing = Effect.flatMap(
      SubscriptionRef.get(gate),
      ({ phase }): Effect.Effect<void, PromotionInProgress | ControllerSealed> =>
        phase._tag === "Sealed"
          ? Effect.fail(createSealedError(phase.seal))
          : phase._tag === "Frozen"
            ? Effect.fail(createPromotionInProgressError(ANOTHER_TRANSFER))
            : Effect.void,
    );

    const thaw = (tokenId: string) =>
      transitions.withPermit(
        Effect.gen(function* () {
          // A seal that persisted and then lost its in-memory write still
          // owns the data. Memory may still say Frozen; the row wins.
          const stored = yield* readSeal;
          if (Option.isSome(stored)) {
            yield* setPhase({ _tag: "Sealed", seal: stored.value });
            return yield* createSealedError(stored.value);
          }
          const { phase } = yield* SubscriptionRef.get(gate);
          if (phase._tag === "Sealed") return yield* createSealedError(phase.seal);
          if (phase._tag !== "Frozen" || phase.tokenId !== tokenId) return false;
          yield* setPhase({ _tag: "Serving" });
          yield* Effect.logInfo("The promotion freeze has ended; this controller serves again.");
          return true;
        }),
      );

    const readSeal = Effect.map(
      sql<{
        readonly token_id: Uint8Array;
        readonly new_address: string;
        readonly signature: Uint8Array<ArrayBuffer>;
      }>`SELECT token_id, new_address, signature FROM sealed_state WHERE singleton = 1`,
      (rows) =>
        Option.map(Option.fromNullishOr(rows[0]), (row): Seal => ({
          tokenId: uuidToString(row.token_id),
          newAddress: row.new_address,
          signature: row.signature,
        })),
    );

    /**
     * Runs `work` counted if the controller is serving, and `otherwise` with
     * the phase that stopped it if not. Work started inside admitted work
     * that is still running is counted and runs whatever the phase. Only
     * `work` and `otherwise` can be interrupted, so the count never leaks.
     */
    const runCountedOr = <A, E, R, E2>(
      work: Effect.Effect<A, E, R>,
      otherwise: (stopped: StoppedPhase) => Effect.Effect<A, E2, R>,
    ): Effect.Effect<A, E | E2, R> =>
      Effect.flatMap(Inside, (outer) =>
        Effect.uninterruptibleMask((restore) =>
          Effect.flatMap(
            outer?.running === true ? enterInside : enter,
            (stopped): Effect.Effect<A, E | E2, R> => {
              if (stopped !== undefined) return restore(otherwise(stopped));
              const admission: Admission = { running: true };
              return restore(work).pipe(
                Effect.provideService(Inside, admission),
                Effect.ensuring(
                  Effect.andThen(
                    Effect.sync(() => {
                      admission.running = false;
                    }),
                    release,
                  ),
                ),
              );
            },
          ),
        ),
      );

    const whenServing = <A, E, R>(work: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      runCountedOr(work, (stopped) =>
        stopped._tag === "Sealed"
          ? Effect.never
          : Effect.andThen(
              awaitGateState((current) => current.phase._tag !== "Frozen"),
              whenServing(work),
            ),
      );

    return PromotionState.of({
      phase: Effect.map(SubscriptionRef.get(gate), (current) => current.phase),

      refuseTransferUnlessServing,

      admit: (work) =>
        runCountedOr(work, (stopped) =>
          Effect.fail(
            stopped._tag === "Sealed"
              ? createSealedError(stopped.seal)
              : createPromotionInProgressError(FROZEN),
          ),
        ),

      whenServing,

      freeze: (tokenId) =>
        Effect.gen(function* () {
          yield* transitions.withPermit(
            Effect.gen(function* () {
              yield* refuseTransferUnlessServing;
              yield* setPhase({ _tag: "Frozen", tokenId });
            }),
          );
          yield* Effect.logInfo(
            "A promotion transfer has started; this controller is read-only until it ends.",
          );
          const timeout = yield* PromotionDrainTimeout;
          yield* awaitGateState((current) => current.running === 0).pipe(
            Effect.timeoutOrElse({
              duration: timeout,
              orElse: () =>
                Effect.andThen(
                  Effect.ignore(thaw(tokenId)),
                  Effect.fail(
                    createInvalidStateError(
                      `The controller was still busy after ${Duration.format(timeout)}, so the ` +
                        "transfer did not start and the promotion token is used up. Create a new " +
                        "promotion token and promote when no agent or workflow is running.",
                    ),
                  ),
                ),
            }),
          );
        }),

      thaw,

      seal: (tokenId, newAddress) =>
        transitions.withPermit(
          Effect.gen(function* () {
            const { phase } = yield* SubscriptionRef.get(gate);
            if (phase._tag === "Sealed") {
              if (phase.seal.tokenId === tokenId) return phase.seal;
              return yield* createSealedError(phase.seal);
            }
            if (phase._tag !== "Frozen" || phase.tokenId !== tokenId) {
              return yield* createInvalidStateError(
                "This controller is not frozen for the transfer of this promotion token: the " +
                  "transfer was cancelled, its token expired, or the controller restarted. It " +
                  "serves again, so discard what was received and promote again with a new token.",
              );
            }
            const signature = yield* identity.sign(encodeForwardingPointerBytes(newAddress));
            const at = yield* nowIso;
            const seal: Seal = { tokenId, newAddress, signature };
            // Persist and take effect together. An interrupt after the row
            // commits and before memory updates would leave thaw able to
            // serve again over a sealed database.
            yield* Effect.uninterruptible(
              Effect.gen(function* () {
                yield* withTransaction(
                  sql,
                  Effect.gen(function* () {
                    yield* sql`
                      INSERT INTO sealed_state (singleton, token_id, sealed_at, new_address, signature)
                      VALUES (1, ${uuidFromString(tokenId)}, ${at}, ${newAddress}, ${signature})
                    `;
                    yield* audit.append({
                      kind: "controller.sealed",
                      actor: SYSTEM_ACTOR,
                      payload: { promotionTokenId: tokenId, newAddress },
                      at,
                    });
                  }),
                );
                yield* setPhase({ _tag: "Sealed", seal });
              }),
            );
            yield* Effect.logInfo(`This controller is sealed; it has moved to ${newAddress}.`);
            return seal;
          }),
        ),

      restore: ({ forceUnseal }) =>
        transitions.withPermit(
          Effect.gen(function* () {
            const stored = yield* readSeal;
            if (Option.isNone(stored)) return;
            if (forceUnseal) {
              yield* withTransaction(
                sql,
                Effect.gen(function* () {
                  yield* sql`DELETE FROM sealed_state WHERE singleton = 1`;
                  yield* audit.append({
                    kind: "controller.unsealed",
                    actor: SYSTEM_ACTOR,
                    payload: { newAddress: stored.value.newAddress },
                  });
                }),
              );
              yield* Effect.logWarning(
                `Unsealed this controller, which had moved to ${stored.value.newAddress}. If that ` +
                  "machine is still serving, two controllers now hold the same identity: stop one.",
              );
              return;
            }
            yield* setPhase({ _tag: "Sealed", seal: stored.value });
          }),
        ),
    });
  }),
);
