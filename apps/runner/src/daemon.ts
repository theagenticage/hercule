/**
 * The runner daemon: `hydra runner`. Holding the connection is all it does yet;
 * hosting sessions is what the connection is for.
 */
import { networkInterfaces } from "node:os";
import { join as joinPath } from "node:path";
import * as Effect from "effect/Effect";
import { runnerDirIn } from "@hydra/home";
import { IDENTITY_PORT } from "@hydra/protocol";
import { identityListener } from "./identity";
import { probeFacts, thisMachine } from "./probe";
import { reconnect, reconnectSignals } from "./reconnect";
import { readRunnerFile, type NotEnrolled } from "./runner-file";
import { connect, type RunnerRetired } from "./socket";
import { machineHeadroom } from "./watermark";

/** Sorted, so two readings can be compared. */
const addresses = (): ReadonlyArray<string> =>
  Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .map((entry) => entry.address)
    .sort();

/**
 * The facts are read afresh per attempt, so a machine that gained memory between
 * two connections says so in the second hello.
 */
export const daemon = (home: string): Effect.Effect<never, NotEnrolled | RunnerRetired> =>
  Effect.scoped(
    Effect.gen(function* () {
      const pin = yield* readRunnerFile(home);
      // Before the first probe, so the port the facts report is the one a
      // browser will find this runner on.
      const identityPort = yield* identityListener({
        runnerId: pin.runnerId,
        controllerUrl: pin.controllerUrl,
        port: IDENTITY_PORT,
      });
      const probe = probeFacts(thisMachine, identityPort);
      const headroom = machineHeadroom(home);
      // Under the runner's own storage directory, so re-enlisting the machine
      // leaves every provider login behind with the identity it belonged to.
      const providersDir = joinPath(runnerDirIn(home), pin.storageDirectory, "providers");
      return yield* reconnect({
        attempt: Effect.flatMap(probe, (facts) =>
          connect({ pin, facts, probe, headroom, providersDir }),
        ),
        signals: reconnectSignals({ now: () => Date.now(), addresses }),
      });
    }),
  );
