/**
 * The runner daemon: `hercule runner`. Holding the connection is all it does yet;
 * hosting sessions is what the connection is for.
 */
import { mkdirSync, rmSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join as joinPath } from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { runnerDirIn } from "@hercule/home";
import { IDENTITY_PORT } from "@hercule/protocol";
import {
  gitCredentialEnv,
  makeCredentialRelay,
  serveCredentialSocket,
  socketPathIn,
} from "./credentials";
import { identityListener } from "./identity";
import { probeFacts, thisMachine } from "./probe";
import { HERCULE_SKILL } from "./sessions/skill";
import { prepareTooling, type Tooling } from "./sessions/tooling";
import { reconnect, reconnectSignals } from "./reconnect";
import { CONTROLLER_URL_SCHEMES, NotEnrolled, readRunnerFile, runnerFileIn } from "./runner-file";
import { connect, type RunnerRetired } from "./socket";
import { machineHeadroom } from "./watermark";
import { makeWorkspaces } from "./workspaces";

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
        "Run `hercule runner set-controller <controller-url>` to point this machine at one it can dial.",
    }),
  );
};

/** Bun's own marker for an entry script that lives inside a compiled binary. */
const EMBEDDED = "/$bunfs/";

/**
 * Its own error because nothing about the connection will fix it: the machine
 * has to be made writable, or the thing in the way removed.
 */
export class ToolingUnavailable extends Schema.TaggedError<ToolingUnavailable>()(
  "ToolingUnavailable",
  { message: Schema.String },
) {}

/**
 * Putting `hercule` and the session skill on this machine is a precondition, not
 * a step: a runner that came up without them hosts sessions that cannot call
 * Hercule at all. Reported by name, like every other precondition here.
 */
const tooling = (home: string, storageDir: string): Effect.Effect<Tooling, ToolingUnavailable> =>
  Effect.tap(
    Effect.try({
      try: () =>
        prepareTooling({ home, storageDir, execPath: process.execPath, skill: HERCULE_SKILL }),
      catch: (error) =>
        new ToolingUnavailable({
          message:
            `could not put hercule and the session skill under ${runnerDirIn(home)}: ` +
            `${error instanceof Error ? error.message : String(error)}. ` +
            "No session on this machine could reach Hercule.",
        }),
    }),
    () =>
      // The link points at this process's executable, which is the `hercule` CLI
      // only in a compiled build; from a checkout it is bun. Said once here
      // rather than left for a session to discover when its first call runs
      // bun instead of hercule.
      Bun.main.startsWith(EMBEDDED)
        ? Effect.void
        : Effect.logWarning(
            `This runner is not the compiled binary, so ${joinPath(runnerDirIn(home), "bin", "hercule")} ` +
              `points at ${process.execPath}: a session calling \`hercule\` gets bun.`,
          ),
  );

/**
 * The facts are read afresh per attempt, so a machine that gained memory between
 * two connections says so in the second hello.
 */
export const daemon = (
  home: string,
): Effect.Effect<never, NotEnrolled | RunnerRetired | ToolingUnavailable> =>
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
      // Everything this machine holds for its controller sits under here, so
      // re-enlisting it leaves every provider login, workspace and cache behind
      // with the identity it belonged to.
      const storageDir = joinPath(runnerDirIn(home), pin.storageDirectory);
      // Nobody else on the machine reads a session's workspace or the socket
      // its credentials are asked down.
      mkdirSync(storageDir, { recursive: true, mode: 0o700 });
      const providersDir = joinPath(storageDir, "providers");
      // Beside them, and just as disposable: what a workspace-less session gets
      // as a cwd, one directory per session.
      const scratchDir = joinPath(storageDir, "scratch");
      const socketPath = socketPathIn(storageDir);
      // The runner's own git asks for its credentials the same way a session's
      // does: down this socket, with nothing on disk.
      const workspaces = makeWorkspaces({ storageDir, gitEnv: gitCredentialEnv({ socketPath }) });
      const credentials = makeCredentialRelay();
      yield* Effect.acquireRelease(
        // A second daemon on one home would answer this machine's helpers with
        // another controller's credentials, so it refuses to start rather than
        // taking the socket over.
        Effect.tryPromise({
          try: () => serveCredentialSocket({ path: socketPath, ask: credentials.ask }),
          catch: (error) =>
            new NotEnrolled({
              message: error instanceof Error ? error.message : String(error),
            }),
        }),
        (server) => Effect.promise(() => server.close()),
      );
      // No session survives this process, so everything under there is what the
      // last one left behind: swept here rather than growing with every crash.
      rmSync(scratchDir, { recursive: true, force: true });
      // Once, here: what every session on this machine reaches Hercule through,
      // refreshed so an upgraded binary takes over the last build's symlink and
      // skill text (spec 15 section 2, spec 06 section 9.3).
      const { binDir, herculeTool } = yield* tooling(
        home,
        joinPath(runnerDirIn(home), pin.storageDirectory),
      );
      return yield* reconnect({
        attempt: Effect.flatMap(probe, (facts) =>
          connect({
            pin,
            facts,
            probe,
            headroom,
            providersDir,
            scratchDir,
            workspaces,
            socketPath,
            credentials,
            binDir,
            herculeTool,
          }),
        ),
        signals: reconnectSignals({ now: () => Date.now(), addresses }),
      });
    }),
  );
