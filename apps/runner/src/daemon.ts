/**
 * Runs the runner daemon, `hercule runner`. It prepares the machine, then keeps
 * the connection to the controller open. Sessions are hosted through that
 * connection.
 */
import { mkdirSync, rmSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join as joinPath } from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { locateCompiledBinary, locateRunnerDir, locateRunnerFile } from "@hercule/home";
import { IDENTITY_PORT, type ForwardingPointer } from "@hercule/protocol";
import {
  buildGitCredentialEnv,
  makeCredentialRelay,
  serveCredentialSocket,
  buildSocketPath,
} from "./credentials";
import { makeAttachmentCache, makeAttachmentUploader } from "./attachments";
import { serveIdentity } from "./identity";
import { probeFacts, thisMachine } from "./probe";
import { providerLogins } from "./providers";
import { sessions } from "./sessions";
import { HERCULE_SKILL } from "./sessions/skill";
import { prepareTooling, type Tooling } from "./sessions/tooling";
import { reconnect, streamReconnectSignals } from "./reconnect";
import { CONTROLLER_URL_SCHEMES, NotEnrolled, readRunnerFile } from "./runner-file";
import { acceptControllerMove } from "./repoint";
import { connect, type RunnerRetired } from "./socket";
import { readMachineHeadroom } from "./watermark";
import { makeWorkspaceSteps } from "./workspace-steps";
import { makeWorkspaces } from "./workspaces";

/** Lists this machine's network addresses, sorted so two readings can be compared. */
const listNetworkAddresses = (): ReadonlyArray<string> =>
  Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .map((entry) => entry.address)
    .sort();

/**
 * Checks that the stored controller URL is an http or https URL. Fails with
 * `NotEnrolled` when it is not.
 *
 * This is the only place the stored URL is checked. Every later step builds a
 * request URL from it, so an invalid hand-edited value is reported here with
 * the field name, instead of failing deep inside a connection attempt.
 */
const validateControllerUrl = (
  home: string,
  controllerUrl: string,
): Effect.Effect<void, NotEnrolled> => {
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
        `controllerUrl in ${locateRunnerFile(home)} ${wrong}: ${controllerUrl}. ` +
        "Run `hercule runner set-controller <controller-url>` to point this machine at a valid controller URL.",
    }),
  );
};

/**
 * The runner could not install the `hercule` link and the session skill. This
 * is its own error because reconnecting will not fix it: the user has to make
 * the directory writable, or remove whatever is in the way.
 */
export class ToolingUnavailable extends Schema.TaggedError<ToolingUnavailable>()(
  "ToolingUnavailable",
  { message: Schema.String },
) {}

/**
 * Installs the `hercule` link and the session skill on this machine. Fails with
 * `ToolingUnavailable` when they cannot be written.
 *
 * The daemon does not start without them, because sessions on a runner
 * without them cannot call Hercule at all.
 */
const prepareRunnerTooling = (
  home: string,
  storageDir: string,
): Effect.Effect<Tooling, ToolingUnavailable> =>
  Effect.tap(
    Effect.try({
      try: () =>
        prepareTooling({ home, storageDir, execPath: process.execPath, skill: HERCULE_SKILL }),
      catch: (error) =>
        new ToolingUnavailable({
          message:
            `could not install hercule and the session skill under ${locateRunnerDir(home)}: ` +
            `${error instanceof Error ? error.message : String(error)}. ` +
            "Without them, no session on this machine can call Hercule.",
        }),
    }),
    () =>
      // The link points at this process's executable. That is the `hercule`
      // CLI only in a compiled build; from a source checkout it is bun. Warn
      // once here, instead of leaving a session to find out when its first
      // call runs bun instead of hercule.
      locateCompiledBinary() !== undefined
        ? Effect.void
        : Effect.logWarning(
            `This runner is not the compiled binary, so ${joinPath(locateRunnerDir(home), "bin", "hercule")} ` +
              `points at ${process.execPath}: a session calling \`hercule\` gets bun.`,
          ),
  );

/**
 * Runs the runner daemon until the controller retires this runner. Fails with
 * `NotEnrolled` when `runner.json` is missing or invalid, or the credential
 * socket cannot be served, and with `ToolingUnavailable` when the tooling
 * cannot be installed.
 *
 * The facts are probed again for each connection attempt, so a machine that
 * gained memory between two connections reports it in the second hello.
 */
export const runDaemon = (
  home: string,
): Effect.Effect<never, NotEnrolled | RunnerRetired | ToolingUnavailable> =>
  Effect.scoped(
    Effect.gen(function* () {
      const pin = yield* readRunnerFile(home);
      yield* validateControllerUrl(home, pin.controllerUrl);
      // Refreshed on a verified re-point so B's web app can read /identity
      // without restarting this daemon.
      let controllerUrl = pin.controllerUrl;
      const applyControllerMove = (message: ForwardingPointer) =>
        Effect.gen(function* () {
          const move = yield* acceptControllerMove({
            home,
            publicKey: pin.controllerPublicKey,
            newAddress: message.newAddress,
            signature: message.signature,
          });
          if (move === "accepted") controllerUrl = message.newAddress;
          return move;
        });
      // Start the listener before the first probe, so the facts report the
      // port a browser will actually find this runner on.
      const identityPort = yield* serveIdentity({
        runnerId: pin.runnerId,
        readControllerUrl: () => controllerUrl,
        port: IDENTITY_PORT,
      });
      const probe = probeFacts(thisMachine, identityPort);
      const headroom = readMachineHeadroom(home);
      // Everything this machine stores for its controller lives in this
      // directory. So when the machine joins again, every provider login,
      // workspace and cache stays behind with the old runner identity.
      const storageDir = joinPath(locateRunnerDir(home), pin.storageDirectory);
      // No other user on the machine may read a session's workspace or the
      // credential socket.
      mkdirSync(storageDir, { recursive: true, mode: 0o700 });
      const providersDir = joinPath(storageDir, "providers");
      // The working directories of sessions without a workspace, one per
      // session. They can be deleted at any time.
      const scratchDir = joinPath(storageDir, "scratch");
      // The images attached to each session's input, one directory per
      // session, removed when the session exits.
      const attachmentsDir = joinPath(storageDir, "attachments");
      const socketPath = buildSocketPath(storageDir);
      // The runner's own git gets its credentials the same way a session's git
      // does: through this socket, with nothing written to disk.
      const workspaces = yield* makeWorkspaces({
        storageDir,
        gitEnv: buildGitCredentialEnv({ socketPath }),
      });
      const workspaceSteps = makeWorkspaceSteps({
        storageDir,
        workspaces,
        socketPath,
        baseEnv: process.env,
      });
      const credentials = makeCredentialRelay();
      yield* Effect.acquireRelease(
        // A second daemon on the same Hercule Home could give this machine's
        // credential helpers another controller's credentials. So the daemon
        // fails to start instead of taking over the socket.
        Effect.tryPromise({
          try: () => serveCredentialSocket({ path: socketPath, ask: credentials.ask }),
          catch: (error) =>
            new NotEnrolled({
              message: error instanceof Error ? error.message : String(error),
            }),
        }),
        (server) => Effect.promise(() => server.close()),
      );
      // No session outlives this process, so anything in the scratch and
      // attachments directories was left behind by the last run. Delete both
      // here, so they do not grow with every crash.
      rmSync(scratchDir, { recursive: true, force: true });
      rmSync(attachmentsDir, { recursive: true, force: true });
      // Install, once per start, the link and skill every session on this
      // machine uses to call Hercule. Doing it at every start means an upgraded
      // binary replaces the previous build's symlink and skill text
      // (spec 15 section 2, spec 06 section 9.3).
      const { binDir, herculeTool } = yield* prepareRunnerTooling(
        home,
        joinPath(locateRunnerDir(home), pin.storageDirectory),
      );
      return yield* reconnect({
        // Re-read runner.json on every attempt so a re-point that rewrote
        // controllerUrl is used on the next dial, including A's local runner.
        attempt: Effect.gen(function* () {
          const pin = yield* readRunnerFile(home);
          yield* validateControllerUrl(home, pin.controllerUrl);
          const facts = yield* probe;
          return yield* connect({
            pin,
            facts,
            probe,
            headroom,
            providersDir,
            scratchDir,
            attachmentsDir,
            attachments: makeAttachmentCache({
              controllerUrl: pin.controllerUrl,
              credential: pin.credential,
            }),
            attachmentUploader: makeAttachmentUploader({
              controllerUrl: pin.controllerUrl,
              credential: pin.credential,
            }),
            workspaces,
            workspaceSteps,
            socketPath,
            credentials,
            providerLogins,
            sessions,
            binDir,
            herculeTool,
            followForwardingPointer: applyControllerMove,
          });
        }),
        signals: streamReconnectSignals({ now: () => Date.now(), addresses: listNetworkAddresses }),
      });
    }),
  );
