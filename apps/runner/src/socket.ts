/**
 * The runner's end of one connection to the controller. `./reconnect.ts`
 * opens a new one when it ends.
 *
 * The credential is sent in a header on the WebSocket upgrade request. The
 * runner controls its own HTTP client, so it can set that header, which a
 * browser cannot.
 *
 * A controller is a logical identity, not an address. So the runner sends a
 * fresh nonce, and the controller's hello must match all three of:
 *
 * - the pinned identity id;
 * - the pinned public key;
 * - a valid signature over the nonce and this runner's id.
 *
 * A known id alone is not enough to trust whatever key comes with it.
 */
import { mkdirSync } from "node:fs";
import { join as joinPath } from "node:path";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Socket from "effect/unstable/socket/Socket";
import { VERSION } from "@hercule/home/version";
import {
  AGENT_STEPS_CAPABILITY,
  ATTACHMENTS_CAPABILITY,
  WORKSPACE_LIFECYCLE_CAPABILITY,
  ControllerToRunner,
  PeerVersion,
  PROTOCOL_VERSION,
  RETIRED_CLOSE_CODE,
  RETIRED_CLOSE_REASON,
  RunnerToController,
  LOGIN_ENDED_CAPABILITY,
  buildWorkspaceActionCapability,
  encodeChallengeBytes,
  type ControllerHello,
  MAX_FACT_LENGTH,
  type InstallRequest,
  type LoginStart,
  type ProbeRequest,
  type ProbeResult,
  type RunnerFacts,
  type RunnerWatermark,
  MAX_MESSAGE_LENGTH,
  MAX_WORKSPACE_STEPS,
  type WorkspaceReport,
} from "@hercule/protocol";
import type { AttachmentCache, ToolImageUploader } from "./attachments";
import type { CredentialRelay } from "./credentials";
import { refreshFacts } from "./probe";
import { describeCause } from "./report";
import {
  findAdapter,
  describeMissingAdapter,
  buildFailedProbe,
  type InstallOutcome,
  type ProviderAdapter,
  type ProviderRunnerContext,
} from "./providers";
import type { LoginAnswer, Logins } from "./providers/login";
import type { Supervising } from "./sessions";
import { reportWatermark } from "./watermark";
import { WORKSPACE_ACTION_IDS } from "./workspace-actions";
import type { WorkspaceSteps } from "./workspace-steps";
import type { Workspaces } from "./workspaces";

const SOCKET_PATH = "/api/v1/runners/socket";

const NONCE_BYTES = 16;

/**
 * The capabilities this runner offers at hello:
 *
 * - one for each workspace action its build implements. The controller pins a
 *   run only to a runner that lists every workspace action in the run's plan.
 * - `LOGIN_ENDED_CAPABILITY`: this runner reports the end of a device login.
 * - `AGENT_STEPS_CAPABILITY`: this runner runs an agent step's turn, sends
 *   how it ended, and answers a start sent again for the step.
 * - `ATTACHMENTS_CAPABILITY`: this runner fetches the images an input refers
 *   to and gives them to the harness.
 */
const CAPABILITIES: ReadonlyArray<string> = [
  ...WORKSPACE_ACTION_IDS.map(buildWorkspaceActionCapability),
  LOGIN_ENDED_CAPABILITY,
  AGENT_STEPS_CAPABILITY,
  WORKSPACE_LIFECYCLE_CAPABILITY,
  ATTACHMENTS_CAPABILITY,
];

const ED25519 = { name: "Ed25519" } as const;

/** The RFC 6455 protocol-error close code. */
const PROTOCOL_ERROR = 1002;

/**
 * How long the controller has to prove its identity after the connection
 * opens. Until then the connection has passed no check, so there is no reason
 * to wait long.
 */
export const PROOF_DEADLINE: Duration.Duration = Duration.seconds(10);

/** The fields of `runner.json` that identify the controller this runner belongs to. */
export interface ControllerPin {
  /** This runner's id at that controller. The controller's hello signs it together with the nonce. */
  readonly runnerId: string;
  readonly controllerUrl: string;
  readonly credential: string;
  readonly controllerIdentityId: string;
  /** The raw SPKI bytes, in standard base64. */
  readonly controllerPublicKey: string;
}

export interface ConnectOptions {
  readonly pin: ControllerPin;
  readonly facts: RunnerFacts;
  readonly probe: Effect.Effect<RunnerFacts>;
  readonly headroom: Effect.Effect<RunnerWatermark, Cause.UnknownError>;
  /**
   * The directory that holds one config directory per provider instance on
   * this machine. Each instance has its own, so two accounts of one harness
   * never read each other's credentials, or the user's own.
   */
  readonly providersDir: string;
  /**
   * The directory that holds the empty working directory of each session
   * without a workspace. Each one is removed when its session exits
   * (spec 06 section 9.1).
   */
  readonly scratchDir: string;
  /**
   * The directory that holds the cached images of each session, one
   * directory per session, removed when its session exits.
   */
  readonly attachmentsDir: string;
  /** Fetches the images of an input from the controller. It outlives this connection. */
  readonly attachments: AttachmentCache;
  /** Uploads the images a session's tools return to the controller. It outlives this connection. */
  readonly toolImages: ToolImageUploader;
  /** The workspaces on this machine. Creates new ones when the controller asks. */
  readonly workspaces: Workspaces;
  /** The workspace steps on this machine. They outlive this connection. */
  readonly workspaceSteps: WorkspaceSteps;
  /** The socket this machine's credential helper asks for tokens on. */
  readonly socketPath: string;
  /** Forwards a credential helper's request to the controller, and the response back. */
  readonly credentials: CredentialRelay;
  /** The provider logins on this machine. They outlive this connection. */
  readonly providerLogins: Logins;
  /** The sessions on this machine. They outlive this connection. */
  readonly sessions: Supervising;
  /** `<home>/runner/bin`, holding the `hercule` symlink every session gets on `PATH`. */
  readonly binDir: string;
  /** How sessions call Hercule as a tool, resolved once at runner start (spec 06 section 9.3). */
  readonly herculeTool: ProviderRunnerContext["herculeTool"];
  /** Defaults to `PROOF_DEADLINE`. Tests set a shorter one. */
  readonly proofDeadline?: Duration.Duration;
}

/**
 * The peer did not prove it is the controller this runner joined. This is its
 * own error because retrying will not fix it: something is impersonating the
 * controller, the URL points at the wrong one, or `runner.json` is invalid.
 */
export class ControllerNotRecognised extends Schema.TaggedError<ControllerNotRecognised>()(
  "ControllerNotRecognised",
  { message: Schema.String },
) {}

/**
 * The controller has retired this runner and revoked its credential. This is
 * its own error because reconnecting is exactly the wrong response: the
 * reconnect loop stops, and the daemon tells the operator what to do.
 */
export class RunnerRetired extends Schema.TaggedError<RunnerRetired>()("RunnerRetired", {
  message: Schema.String,
}) {}

export const RETIRED_MESSAGE =
  "this runner was retired; run `hercule runner join` to join the fleet again";

/**
 * The controller uses another protocol version. This is its own error because
 * the operator can fix it by running the same Hercule version on both sides.
 */
export class ProtocolMismatch extends Schema.TaggedError<ProtocolMismatch>()("ProtocolMismatch", {
  message: Schema.String,
}) {}

const decodeFrame = Schema.decodeUnknownEffect(ControllerToRunner);
const decodePeerVersion = Schema.decodeUnknownEffect(PeerVersion);

const UNREADABLE = "the controller sent a message this version of the runner cannot parse";
const encodeFrame = Schema.encodeUnknownSync(RunnerToController);

const encodeFrameText = (message: typeof RunnerToController.Type): string =>
  JSON.stringify(encodeFrame(message));

/** Decodes base64 into the `Uint8Array<ArrayBuffer>` WebCrypto's types require. A Node `Buffer` does not fit that type. */
const decodeBase64 = (encoded: string): Uint8Array<ArrayBuffer> => {
  const decoded = Buffer.from(encoded, "base64");
  const bytes = new Uint8Array(decoded.byteLength);
  bytes.set(decoded);
  return bytes;
};

const encodeBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

const isRetiredClose = (error: unknown): boolean =>
  error instanceof Socket.SocketError &&
  error.reason._tag === "SocketCloseError" &&
  error.reason.code === RETIRED_CLOSE_CODE &&
  error.reason.closeReason === RETIRED_CLOSE_REASON;

const buildSocketUrl = (controllerUrl: string): string => {
  const url = new URL(SOCKET_PATH, controllerUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
};

/**
 * Checks that a controller hello matches the pinned identity id and public key
 * and carries a valid signature over the nonce and this runner's id. The
 * signature is checked last, because the key is only trusted once the id and
 * the key match the pin.
 */
const isOurs = (
  hello: ControllerHello,
  pin: ControllerPin,
  nonce: string,
): Effect.Effect<boolean> =>
  hello.identityId !== pin.controllerIdentityId || hello.publicKey !== pin.controllerPublicKey
    ? Effect.succeed(false)
    : Effect.promise(async () => {
        const key = await crypto.subtle.importKey(
          "spki",
          decodeBase64(pin.controllerPublicKey),
          ED25519,
          false,
          ["verify"],
        );
        return crypto.subtle.verify(
          ED25519,
          key,
          decodeBase64(hello.signature),
          encodeChallengeBytes(pin.runnerId, nonce),
        );
      }).pipe(
        // A pinned key that cannot be imported cannot verify anything.
        Effect.catchCause(() => Effect.succeed(false)),
      );

/**
 * Opens one connection to the controller, checks its identity, and serves it
 * until it ends. Every ending is a failure, even a normal close, because a
 * disconnected runner must reconnect. Fails with:
 *
 * - `ControllerNotRecognised` when the peer does not prove it is this runner's controller;
 * - `ProtocolMismatch` when the controller uses another protocol version;
 * - `RunnerRetired` when the controller has retired this runner;
 * - `SocketError` for any other ending.
 */
export const connect = (
  options: ConnectOptions,
): Effect.Effect<
  void,
  ControllerNotRecognised | ProtocolMismatch | RunnerRetired | Socket.SocketError
> =>
  Effect.gen(function* () {
    const { pin } = options;
    const url = buildSocketUrl(pin.controllerUrl);
    const socket = yield* Socket.fromWebSocket(
      Effect.acquireRelease(
        Effect.sync(
          () =>
            new WebSocket(url, {
              headers: { authorization: `Bearer ${pin.credential}` },
            } as unknown as string[]),
        ),
        // A socket still open when this scope closes means the runner is
        // leaving on purpose, not losing the connection. The goodbye frame lets
        // the controller tell a clean shutdown from a lost connection. It is
        // sent on the raw socket, because everything above it is already
        // shutting down.
        (ws) =>
          Effect.sync(() => {
            if (ws.readyState === WebSocket.OPEN) ws.send(encodeFrameText({ _tag: "goodbye" }));
            ws.close(1000);
          }),
      ),
    );
    const write = yield* socket.writer;
    // A probe, an install, a facts report or a session's work runs longer
    // than the handling of the frame that asked for it, so it is forked into
    // the connection's scope, and the next frame is handled at once.
    const connection = yield* Effect.scope;

    const nonce = encodeBase64(crypto.getRandomValues(new Uint8Array(NONCE_BYTES)));
    let greeted = false;
    // The machine's facts as this connection last reported them. An install
    // changes the machine, and the probe after it must find the binary that
    // was just installed, not the one listed in the hello.
    let facts = options.facts;
    const proven = Latch.makeUnsafe(false);
    // The proof deadline starts when the socket opens. It limits how long the
    // peer takes to respond, not how long the network takes to connect.
    // Otherwise a slow connect could leave a valid controller no time to
    // prove its identity.
    const opened = Latch.makeUnsafe(false);
    let impostor: ControllerNotRecognised | undefined;

    const disown = (message: string) =>
      Effect.gen(function* () {
        impostor = new ControllerNotRecognised({ message });
        yield* write(new Socket.CloseEvent(PROTOCOL_ERROR, "unrecognised controller"));
      });

    // Facts are probed one at a time. A request, an install and the hourly
    // report can each ask for a probe, and two probes that ran side by side
    // could finish in either order, so the older result could overwrite the
    // newer one in `facts`.
    const probeLock = Semaphore.makeUnsafe(1);
    const reportFacts = probeLock.withPermits(1)(
      Effect.tap(options.probe, (probed) =>
        Effect.sync(() => {
          facts = probed;
        }),
      ),
    );

    const findBinaryPath = (binaryName: string): string | undefined =>
      facts.providers.find((provider) => provider.name === binaryName && provider.present)?.path;

    /**
     * Builds the context for a probe, login or install of one provider
     * instance. Creates the instance's private directory, where the harness
     * keeps its credentials.
     */
    const buildContext = (
      adapter: ProviderAdapter,
      instanceId: string,
      secrets: Readonly<Record<string, string>>,
    ): ProviderRunnerContext => {
      const home = joinPath(options.providersDir, instanceId);
      mkdirSync(home, { recursive: true, mode: 0o700 });
      // Probes, logins and installs have no working directory. Only sessions
      // have one, and the session supervisor builds its own context
      // (spec 06 section 4.2).
      return {
        cwd: null,
        home,
        binary: findBinaryPath(adapter.binaryName),
        env: process.env,
        secrets,
        // Required by the shared context type, although a probe, an install and
        // a login never load the skill.
        herculeTool: options.herculeTool,
        attachmentsDir: null,
        toolImages: options.toolImages,
      };
    };

    // The connection gives the supervisor a way to send frames, the paths
    // this machine resolved and the workspace steps. The sessions themselves
    // belong to the process, not to this connection.
    const supervisor = options.sessions.forConnection({
      scope: connection,
      send: (frame) => write(encodeFrameText(frame)),
      workspaceSteps: options.workspaceSteps,
      machine: {
        providersDir: options.providersDir,
        scratchDir: options.scratchDir,
        attachmentsDir: options.attachmentsDir,
        attachments: options.attachments,
        toolImages: options.toolImages,
        binDir: options.binDir,
        herculeTool: options.herculeTool,
        controllerUrl: pin.controllerUrl,
        baseEnv: process.env,
        findBinary: findBinaryPath,
        workspaces: options.workspaces,
        socketPath: options.socketPath,
      },
    });

    // Credential requests go out on this connection while it is up. With no
    // connection there is no credential, which git treats as "try the next
    // helper", not as a failure.
    yield* options.credentials.attachConnection((frame) => write(encodeFrameText(frame)));

    /**
     * Runs a workspace operation and sends its report. Provisioning takes as
     * long as a clone, so the caller forks this and the report is sent when
     * it is done. The controller waits for a report for every workspace frame
     * it sent, so even a crash sends a failed report.
     */
    const answerWorkspace = (
      workspaceId: string,
      making: Effect.Effect<WorkspaceReport>,
      requestId?: string,
    ): Effect.Effect<void> =>
      making.pipe(
        Effect.flatMap((report) => write(encodeFrameText(report))),
        Effect.catchCause((cause) =>
          Effect.ignore(
            write(
              encodeFrameText({
                _tag: "workspaceReport",
                workspaceId,
                status: "failed",
                ...(requestId === undefined ? {} : { requestId }),
                message: describeCause(cause, MAX_MESSAGE_LENGTH),
              }),
            ),
          ),
        ),
        Effect.ignore,
      );

    const answerProbe = (request: ProbeRequest) => {
      const sendProbeReport = (result: ProbeResult) =>
        write(
          encodeFrameText({
            _tag: "probeReport",
            requestId: request.requestId,
            instanceId: request.instanceId,
            result,
          }),
        );
      return Effect.gen(function* () {
        const adapter = findAdapter(request.providerId);
        return yield* sendProbeReport(
          adapter === undefined
            ? buildFailedProbe(null, describeMissingAdapter(request.providerId))
            : yield* adapter.probe(
                buildContext(adapter, request.instanceId, request.secrets),
                request.config,
              ),
        );
      }).pipe(
        // The encoding happens inside the catch, so a result that cannot be
        // encoded reaches the controller as an error, not as silence. The
        // fallback message is truncated, so it always encodes.
        Effect.catchCause((cause) =>
          Effect.ignore(
            sendProbeReport(buildFailedProbe(null, describeCause(cause, MAX_FACT_LENGTH))),
          ),
        ),
        // If the write itself failed, the connection is closing and there is
        // nowhere left to report to.
        Effect.ignore,
      );
    };

    /**
     * Runs an install and sends its result. After a successful install, the
     * new facts are sent first, so a controller that reads the runner row
     * after the `ok` sees the machine with the harness installed.
     */
    const answerInstall = (request: InstallRequest) => {
      const sendInstallResult = (outcome: InstallOutcome) =>
        write(
          encodeFrameText({
            _tag: "installResult",
            requestId: request.requestId,
            ok: outcome.ok,
            ...(outcome.message === undefined ? {} : { message: outcome.message }),
          }),
        );
      return Effect.gen(function* () {
        const install = findAdapter(request.providerId)?.install;
        if (install === undefined) {
          return yield* sendInstallResult({
            ok: false,
            message: describeMissingAdapter(request.providerId),
          });
        }
        const outcome = yield* install(process.env);
        if (outcome.ok) {
          yield* write(encodeFrameText({ _tag: "factsReport", facts: yield* reportFacts }));
        }
        return yield* sendInstallResult(outcome);
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.ignore(
            sendInstallResult({ ok: false, message: describeCause(cause, MAX_FACT_LENGTH) }),
          ),
        ),
        Effect.ignore,
      );
    };

    /**
     * Sends the response to one step of a login: the start or the code. The
     * login process belongs to the runner, not to this connection, so a
     * connection that drops between the two steps does not end it.
     */
    const answerLogin = (requestId: string, answering: Effect.Effect<LoginAnswer>) => {
      const sendLoginAnswer = (answer: LoginAnswer) =>
        write(encodeFrameText({ ...answer, requestId }));
      return Effect.flatMap(answering, sendLoginAnswer).pipe(
        Effect.catchCause((cause) =>
          Effect.ignore(
            sendLoginAnswer({
              _tag: "loginFailed",
              message: describeCause(cause, MAX_FACT_LENGTH),
            }),
          ),
        ),
        Effect.ignore,
      );
    };

    const startLogin = (request: LoginStart): Effect.Effect<LoginAnswer> =>
      Effect.suspend(() => {
        const adapter = findAdapter(request.providerId);
        return adapter === undefined
          ? Effect.succeed<LoginAnswer>({
              _tag: "loginFailed",
              message: describeMissingAdapter(request.providerId),
            })
          : options.providerLogins.start(
              request.requestId,
              request.instanceId,
              adapter,
              // A login is the harness writing its own credential on this
              // machine, so the instance's stored secrets are not passed in.
              buildContext(adapter, request.instanceId, {}),
            );
      });

    /**
     * The last frame queued for each session, by session id. Each frame of a
     * session waits for the one queued before it, so a session's frames run
     * one at a time in arrival order. An entry is removed when its frame
     * finishes and no later frame was queued behind it.
     */
    const sessionLanes = new Map<string, Deferred.Deferred<void>>();

    /**
     * Queues the work of one session frame behind the earlier frames of the
     * same session. Returns the effect that waits its turn, runs the work, and
     * then lets the session's next frame go. Call it from the frame loop, so
     * frames join their lanes in the order they arrived.
     */
    const queueSessionWork = (
      sessionId: string,
      work: Effect.Effect<void>,
    ): Effect.Effect<void> => {
      const previous = sessionLanes.get(sessionId);
      const finished = Deferred.makeUnsafe<void>();
      sessionLanes.set(sessionId, finished);
      return Effect.andThen(
        previous === undefined ? Effect.void : Deferred.await(previous),
        work,
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            Deferred.doneUnsafe(finished, Effect.void);
            if (sessionLanes.get(sessionId) === finished) sessionLanes.delete(sessionId);
          }),
        ),
      );
    };

    /**
     * Handles one frame in the frame loop. Returns the work of a session
     * frame, which the loop forks, or undefined when the frame is fully
     * handled. Fails with `ProtocolMismatch` when the controller uses another
     * protocol version.
     *
     * Everything done here is quick, because every later frame, pings
     * included, waits for it. Work that waits on a harness or on the network
     * is returned or forked instead.
     */
    const handleFrame = (raw: string) =>
      Effect.gen(function* () {
        if (impostor !== undefined) return;
        const parsed = yield* Effect.option(
          Effect.try({ try: () => JSON.parse(raw) as unknown, catch: () => undefined }),
        );
        if (Option.isNone(parsed)) return yield* disown(UNREADABLE);
        // Read the version before decoding the frame, because a newer
        // controller's hello may not decode here, and a version mismatch is
        // an error the operator can act on.
        const version = yield* Effect.option(decodePeerVersion(parsed.value));
        if (Option.isSome(version) && version.value.protocolVersion !== PROTOCOL_VERSION) {
          return yield* Effect.fail(
            new ProtocolMismatch({
              message: `the controller uses runner protocol version ${String(version.value.protocolVersion)}, but this runner uses version ${String(PROTOCOL_VERSION)}. Install the same Hercule version here as on the controller.`,
            }),
          );
        }
        const frame = yield* Effect.option(decodeFrame(parsed.value));
        if (Option.isNone(frame)) return yield* disown(UNREADABLE);
        const message = frame.value;
        if (message._tag === "controllerHello") {
          // Ignore a second hello: it could only undo the proof the first one gave.
          if (greeted) return;
          if (!(yield* isOurs(message, pin, nonce))) {
            return yield* disown(
              "the controller's identity does not match the controller this runner joined",
            );
          }
          greeted = true;
          // Step results go out on this connection from now on, before any
          // step frame is handled, so no answer is lost. Not earlier: a step
          // started on an earlier connection can finish at any moment, and a
          // peer that has not proved its identity must not learn of it.
          yield* options.workspaceSteps
            .attachConnection((frame) => write(encodeFrameText(frame)))
            .pipe(Scope.provide(connection));
          // An older controller closes the connection on a frame it cannot
          // read, so the end of a device login is reported only to a
          // controller that lists the frame.
          if (message.capabilities.includes(LOGIN_ENDED_CAPABILITY)) {
            yield* options.providerLogins
              .attachConnection((frame) => write(encodeFrameText(frame)))
              .pipe(Scope.provide(connection));
          }
          proven.openUnsafe();
          return;
        }
        // Send nothing to a peer that has not proved its identity, not even a sign that this runner is alive.
        if (!greeted) return;
        switch (message._tag) {
          case "ping":
            return yield* write(encodeFrameText({ _tag: "pong" }));
          case "factsRequest":
            // Unlike the hourly report, this is sent even when nothing changed,
            // because someone is waiting for the response. Forked, like a
            // probe, because the probe takes seconds.
            return yield* Effect.asVoid(
              Effect.forkIn(
                Effect.ignore(
                  Effect.flatMap(reportFacts, (probed) =>
                    write(encodeFrameText({ _tag: "factsReport", facts: probed })),
                  ),
                ),
                connection,
              ),
            );
          case "probeRequest":
            // Forked, because a probe takes seconds, and the connection must keep
            // handling pings and other requests while it runs.
            return yield* Effect.asVoid(Effect.forkIn(answerProbe(message), connection));
          case "installRequest":
            return yield* Effect.asVoid(Effect.forkIn(answerInstall(message), connection));
          case "loginStart":
            return yield* Effect.asVoid(
              Effect.forkIn(answerLogin(message.requestId, startLogin(message)), connection),
            );
          case "loginCode":
            return yield* Effect.asVoid(
              Effect.forkIn(
                answerLogin(
                  message.requestId,
                  options.providerLogins.submit(message.instanceId, message.code),
                ),
                connection,
              ),
            );
          // A session's frames are queued in its own lane, so input for a
          // session cannot overtake the frame that started it, while other
          // sessions and every other frame go on.
          case "sessionStart":
            // `start` records the start now, before the next frame is
            // handled, so a stop that arrives after this frame always finds
            // it.
            return queueSessionWork(message.sessionId, supervisor.start(message));
          case "sessionInput":
            return queueSessionWork(message.sessionId, supervisor.input(message));
          case "sessionInterrupt":
            // Stop must reach input preparation while that input is still
            // waiting on the harness. The supervisor waits only for binding.
            return yield* Effect.asVoid(Effect.forkIn(supervisor.interrupt(message), connection));
          case "sessionRespondToApprovalRequest":
            return queueSessionWork(
              message.sessionId,
              supervisor.respondToApprovalRequest(message),
            );
          case "sessionRespondToQuestion":
            return queueSessionWork(message.sessionId, supervisor.respondToQuestion(message));
          case "sessionStop":
            // A stop does not wait behind its session's frames, and nothing
            // waits behind it: it must reach a start that is still starting,
            // so the start refuses its input instead of handing it over
            // (spec 06 section 4.2). An input still waiting in the lane is
            // then refused too. `stop` records the stop now, and the effect
            // it returns asks the adapter to stop the harness.
            return supervisor.stop(message);
          case "ack":
            // Acks are for replayable events, which nothing sends yet.
            return;
          case "workspaceProvision": {
            // Start the fiber immediately so preparation is registered before
            // the next frame. A workspace step sent right after this frame must
            // wait for that preparation before looking for the working files.
            const provisioning = options.workspaces.provision(message);
            return yield* Effect.asVoid(
              Effect.forkIn(answerWorkspace(message.workspaceId, provisioning), connection, {
                startImmediately: true,
              }),
            );
          }
          case "workspaceInspect":
            return yield* Effect.asVoid(
              Effect.forkIn(
                options.workspaces.inspect(message.workspaceId).pipe(
                  Effect.flatMap((report) =>
                    write(
                      encodeFrameText({
                        _tag: "workspaceInspection",
                        requestId: message.requestId,
                        report,
                      }),
                    ),
                  ),
                  Effect.catchCause((cause) =>
                    write(
                      encodeFrameText({
                        _tag: "workspaceInspection",
                        requestId: message.requestId,
                        report: {
                          _tag: "workspaceReport",
                          workspaceId: message.workspaceId,
                          status: "failed",
                          observedAt: new Date().toISOString(),
                          message: describeCause(cause, MAX_MESSAGE_LENGTH),
                        },
                      }),
                    ).pipe(Effect.ignore),
                  ),
                ),
                connection,
              ),
            );
          case "workspaceDispose":
            return yield* Effect.asVoid(
              Effect.forkIn(
                answerWorkspace(
                  message.workspaceId,
                  options.workspaces.dispose(message),
                  message.requestId,
                ),
                connection,
              ),
            );
          case "workspaceDetach":
            return yield* Effect.asVoid(
              Effect.forkIn(
                answerWorkspace(
                  message.workspaceId,
                  options.workspaces.detach(message),
                  message.requestId,
                ),
                connection,
              ),
            );
          case "credentialAnswer":
            // A git process is waiting for this response. Nothing is kept after
            // it is delivered.
            return yield* Effect.sync(() => options.credentials.deliver(message));
          case "workspaceStepStart":
            // A request for an agent step's result waits in its session's
            // lane, behind the session start or input that carries the step's
            // prompt, so it is answered only once the harness has taken or
            // refused that prompt. It never overtakes the prompt.
            if (message.kind === "agent") {
              return queueSessionWork(message.sessionId, options.workspaceSteps.start(message));
            }
            // An action step runs in a fiber of its own, so this returns at
            // once.
            return yield* options.workspaceSteps.start(message);
          case "workspaceStepSettle":
            return yield* options.workspaceSteps.settle(message);
        }
        // Every frame the protocol defines is handled above. This fails to
        // compile when a new frame is added, so it cannot be dropped silently.
        return message satisfies never;
      });

    // The transport calls `receive` once per frame, in arrival order, and
    // `receive` only puts the frame in the inbox. One fiber, the frame loop,
    // takes the frames out and passes each through `handleFrame` before it
    // takes the next, so:
    //
    // - two frames arriving together cannot run the hello check at the same
    //   time over the same shared state;
    // - a frame that arrives while the hello is being checked waits for the
    //   check, instead of being dropped as if no hello had come;
    // - session frames join their lanes in arrival order.
    //
    // Nothing between the transport and the loop can reorder frames. A lock
    // taken by a fiber per frame could: a lock does not hand itself to its
    // waiters in the order they came.
    //
    // A session frame's work is forked into the connection's scope, so a
    // ping is never answered late because a harness is slow to start. The end
    // of the connection closes that scope, which interrupts the work and
    // waits for it.
    const inbox = yield* Queue.unbounded<string>();
    const receive = (raw: string): void => {
      Queue.offerUnsafe(inbox, raw);
    };
    const handleFrames = Effect.forever(
      Effect.flatMap(Queue.take(inbox), (raw) =>
        Effect.flatMap(handleFrame(raw), (sessionWork) =>
          Effect.isEffect(sessionWork)
            ? Effect.asVoid(Effect.forkIn(sessionWork, connection))
            : Effect.void,
        ),
      ),
    );

    /**
     * Waits for the proof, then starts the session relay and the periodic
     * reports. The deadline applies only until the proof arrives. A deadline
     * that could fire on a proven connection would disconnect a healthy
     * runner every ten seconds.
     */
    const reporting = Effect.gen(function* () {
      yield* opened.await;
      const proved = yield* Effect.raceFirst(
        Effect.as(proven.await, true),
        Effect.as(Effect.sleep(options.proofDeadline ?? PROOF_DEADLINE), false),
      );
      if (!proved) return yield* disown("the controller did not prove its identity in time");
      // Logged only now, because before the proof the peer may not be this
      // runner's controller. Every lost connection is logged as a warning, so
      // this line shows in the log when the runner got its connection back.
      yield* Effect.logInfo("The runner connected to the controller").pipe(
        Effect.annotateLogs({ controllerUrl: pin.controllerUrl, runnerId: pin.runnerId }),
      );
      // Start the relay only now. A session that survived a reconnect can
      // produce events at once, and a peer that has not proved its identity
      // must not receive any of them. The relay subscribes when it starts, so
      // events published before this point are lost, like everything produced
      // while the socket was down: the runner has no outbox yet that keeps
      // events for replay (spec 03 section 2.3).
      yield* Effect.forkIn(supervisor.relay, connection);
      yield* supervisor.report;
      // Like the sessions report: the controller settles every listed step
      // whose record ended while this runner was away. One frame holds at
      // most `MAX_WORKSPACE_STEPS` steps, so a longer list is sent in parts.
      const inFlight = options.workspaceSteps.listInFlight();
      for (let at = 0; at < inFlight.length; at += MAX_WORKSPACE_STEPS) {
        yield* write(
          encodeFrameText({
            _tag: "workspaceStepsReport",
            steps: inFlight.slice(at, at + MAX_WORKSPACE_STEPS),
          }),
        );
      }
      yield* Effect.all(
        [
          reportWatermark({
            read: options.headroom,
            send: (watermark) => write(encodeFrameText({ _tag: "watermarkReport", watermark })),
          }),
          refreshFacts({
            probe: reportFacts,
            reported: options.facts,
            send: (probed) => write(encodeFrameText({ _tag: "factsReport", facts: probed })),
          }),
        ],
        { concurrency: "unbounded" },
      );
    });

    // `raceFirst`, not `race`: the connection ending is a failure, and `race`
    // would ignore that failure and keep waiting for the other side. The
    // frame loop never ends on its own; it fails when the controller uses
    // another protocol version, and that ends the connection too.
    yield* Effect.raceFirst(
      Effect.raceFirst(
        socket.runString(receive, {
          onOpen: write(
            encodeFrameText({
              _tag: "runnerHello",
              protocolVersion: PROTOCOL_VERSION,
              capabilities: CAPABILITIES,
              binaryVersion: VERSION,
              nonce,
              facts: options.facts,
            }),
          ).pipe(Effect.ignore, Effect.andThen(Effect.sync(() => opened.openUnsafe()))),
        }),
        handleFrames,
      ),
      reporting,
    ).pipe(
      // When the runner closed the connection on an impostor, report that
      // instead of the close error that followed.
      Effect.catch((error) => (impostor === undefined ? Effect.fail(error) : Effect.void)),
      // The only close reason the runner checks. It means the credential is
      // revoked, and reconnecting will not bring it back.
      Effect.catch((error) =>
        Effect.fail(
          isRetiredClose(error) ? new RunnerRetired({ message: RETIRED_MESSAGE }) : error,
        ),
      ),
    );

    if (impostor !== undefined) return yield* Effect.fail(impostor);
  }).pipe(Effect.scoped);
