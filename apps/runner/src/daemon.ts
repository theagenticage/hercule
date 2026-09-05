/**
 * The runner daemon: `hydra runner`.
 *
 * It reads what this machine joined, then holds a connection with that
 * controller for as long as the process lives, dialling again whenever the last
 * one ended. There is nothing else to it yet - hosting sessions is what the
 * connection is for, and none can be placed on a fleet that has just learned to
 * connect.
 */
import { networkInterfaces } from "node:os";
import * as Effect from "effect/Effect";
import { DEFAULT_IDENTITY_PORT, probeFacts, thisMachine } from "./probe";
import { reconnect, reconnectSignals } from "./reconnect";
import { readRunnerFile, type NotEnrolled } from "./runner-file";
import { connect } from "./socket";
import { machineHeadroom } from "./watermark";

/** Every address this machine holds, in an order two readings can be compared in. */
const addresses = (): ReadonlyArray<string> =>
  Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .map((entry) => entry.address)
    .sort();

/**
 * Runs until the process is stopped.
 *
 * The facts are read afresh for each attempt rather than once at start, so a
 * machine that gained memory or a network address between two connections says
 * so in the hello of the second.
 */
export const daemon = (home: string): Effect.Effect<never, NotEnrolled> =>
  Effect.gen(function* () {
    const pin = yield* readRunnerFile(home);
    const probe = probeFacts(thisMachine, DEFAULT_IDENTITY_PORT);
    const headroom = machineHeadroom(home);
    return yield* reconnect({
      attempt: Effect.flatMap(probe, (facts) => connect({ pin, facts, probe, headroom })),
      signals: reconnectSignals({ now: () => Date.now(), addresses }),
    });
  });
