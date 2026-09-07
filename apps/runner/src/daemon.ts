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
import { CONTROLLER_URL_SCHEMES, NotEnrolled, readRunnerFile, runnerFileIn } from "./runner-file";
import { connect, type RunnerRetired } from "./socket";
import { machineHeadroom } from "./watermark";

/** Sorted, so two readings can be compared. */
const addresses = (): ReadonlyArray<string> =>
  Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .map((entry) => entry.address)
    .sort();

/**
 * The one place a stored controller URL is checked: every consumer downstream
 * builds a request URL off it, so a hand-edited value is refused here by name
 * rather than failing deep in a dial.
 */
const dialable = (home: string, controllerUrl: string): Effect.Effect<void, NotEnrolled> => {
  const url = URL.parse(controllerUrl);
  const wrong =
    url === null
      ? "is not a URL"
      : CONTROLLER_URL_SCHEMES.includes(url.protocol)
        ? undefined
        : "is not http or https";
  if (wrong === undefined) return Effect.void;
  return Effect.fail(
    new NotEnrolled({
      message:
        `controllerUrl in ${runnerFileIn(home)} ${wrong}: ${controllerUrl}. ` +
        "Run `hydra runner set-controller <controller-url>` to point this machine at one it can dial.",
    }),
  );
};

/**
 * The facts are read afresh per attempt, so a machine that gained memory between
 * two connections says so in the second hello.
 */
export const daemon = (home: string): Effect.Effect<never, NotEnrolled | RunnerRetired> =>
  Effect.scoped(
    Effect.gen(function* () {
      const pin = yield* readRunnerFile(home);
      yield* dialable(home, pin.controllerUrl);
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
