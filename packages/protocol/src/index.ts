/**
 * The controller-runner protocol: one versioned catalogue of the messages that
 * cross the single WebSocket a runner holds with its controller.
 *
 * When a hello cannot be accepted, the other side closes the socket with a
 * reason rather than sending a message, which is why the catalogue has no
 * error message.
 *
 * This package sits on the runner's import path, so it depends on nothing but
 * `effect`.
 */
import { Schema } from "effect";

import {
  Fact,
  InstanceId,
  InstanceSecrets,
  MAX_FACT_ITEMS,
  MAX_FACT_LENGTH,
  Seq,
  Sequenced,
  StorageId,
  Subdirectory,
  Timestamp,
  WorkspaceStepKey,
} from "./primitives";
import {
  SessionEvent,
  SessionInput,
  SessionInputResult,
  SessionInterrupt,
  SessionRespondToApprovalRequest,
  SessionRespondToQuestion,
  SessionsReport,
  SessionStart,
  SessionStop,
} from "./sessions";
import {
  CredentialAnswer,
  CredentialRequest,
  WorkspaceDispose,
  WorkspaceDetach,
  WorkspaceProvision,
  WorkspaceReport,
  WorkspaceInspect,
  WorkspaceInspection,
} from "./workspaces";
import {
  WorkspaceStepResult,
  WorkspaceStepsReport,
  WorkspaceStepStart,
  WorkspaceStepSettle,
} from "./workspace-steps";

export * from "./output-schema";
export * from "./remote";
export * from "./sessions";
export * from "./workspace-steps";
export * from "./workspaces";
export {
  Fact,
  InstanceId,
  MAX_FACT_ITEMS,
  MAX_FACT_LENGTH,
  Sequenced,
  StorageId,
  Subdirectory,
  Timestamp,
  WorkspaceStepKey,
};

/**
 * The runner protocol version. A runner on any other version is refused at
 * hello, with a message telling the user to upgrade it.
 *
 * - Version 2 put a session's first input on `SessionStart`.
 * - Version 4 prevents older peers from displaying incomplete usage as exact.
 * - Version 3 added subagents: the `subagentId` on session events and on
 *   `SessionInterrupt`. A capability with a fallback would not be safe here.
 *   A controller that ignored `subagentId` would book a subagent's turns to
 *   the session's own agent, and a runner that ignored it would stop the
 *   whole session where the user asked to stop one subagent (spec 03
 *   section 2.2).
 */
export const PROTOCOL_VERSION = 4;

/**
 * The close code and reason the controller uses to end the connection of a
 * runner it has just retired; this is the only close reason the runner reads.
 * Retiring revokes the credential, so a runner that receives this stops rather
 * than reconnecting with a revoked credential. The code is RFC 6455's policy
 * violation: the connection works, but this controller no longer accepts the
 * runner.
 */
export const RETIRED_CLOSE_CODE = 1008;

export const RETIRED_CLOSE_REASON = "RETIRED";

/** RFC 6455's "going away": the connection works, but this side is closing it. */
export const GOING_AWAY_CLOSE_CODE = 1001;

/**
 * The protocol version a peer claims. Any version that could exist decodes,
 * ours or not, so a mismatch is rejected with a clear reason rather than
 * reported as an unreadable frame.
 *
 * Any other version difference between the two binaries only causes a
 * warning, never a block. That is why the runner sends its binary version and
 * the controller only stores it.
 */
const ProtocolVersion = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

/** The extension point: a feature is used only when both hellos list it. */
export const Capabilities = Schema.Array(Fact).check(Schema.isMaxLength(MAX_FACT_ITEMS));

/**
 * Standard base64, with padding. The URL-safe alphabet is a different encoding,
 * and it is rejected here rather than later as a signature that fails to
 * verify.
 */
const Base64 = Schema.String.check(
  Schema.isLengthBetween(4, 1024),
  Schema.isPattern(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/, {
    title: "base64",
    description: "standard base64",
  }),
);

const Bytes = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const Toolchain = Schema.Struct({
  name: Fact,
  /** The output of `--version`, unparsed when the runner could not parse it. */
  version: Fact,
  path: Fact,
});

export type Toolchain = Schema.Schema.Type<typeof Toolchain>;

export const ProviderBinary = Schema.Struct({
  name: Fact,
  present: Schema.Boolean,
  path: Schema.optionalKey(Fact),
});

export type ProviderBinary = Schema.Schema.Type<typeof ProviderBinary>;

/**
 * The first loopback port a runner tries for `GET /identity`, and how many
 * consecutive ports it tries.
 *
 * The set is small and fixed rather than "whatever is free", because the web
 * app's Content-Security-Policy has to list the ports in advance, and a policy
 * listing every port would let any script in the app reach every service on the
 * user's machine.
 */
export const IDENTITY_PORT = 4939;

export const IDENTITY_PORT_COUNT = 10;

/**
 * What a runner knows about the machine it is on. This is state where the
 * latest value wins, not a series of events: it is sent with the hello and sent
 * again only when a value changed. The controller stores a report whole and
 * returns it on its public API, which is why `@hercule/contract` exports this
 * schema rather than a copy of it.
 */
export const RunnerFacts = Schema.Struct({
  os: Fact,
  arch: Fact,
  totalMemoryBytes: Bytes,
  docker: Schema.Boolean,
  toolchains: Schema.Array(Toolchain).check(Schema.isMaxLength(MAX_FACT_ITEMS)),
  providers: Schema.Array(ProviderBinary).check(Schema.isMaxLength(MAX_FACT_ITEMS)),
  /**
   * The provider ids this runner build has an adapter for. A fact about the
   * binary rather than the machine, so the fleet view can show "no adapter in
   * this runner build" instead of finding out by trying and failing.
   */
  adapters: Schema.Array(Fact).check(Schema.isMaxLength(MAX_FACT_ITEMS)),
  /** The port that serves `GET /identity`, which is used to resolve the "local" alias. */
  identityPort: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
});

export type RunnerFacts = Schema.Schema.Type<typeof RunnerFacts>;

/**
 * The fast-changing part of a runner's state. Never buffered: only the latest
 * value matters. The controller decides what a reading means for placement,
 * by comparing it with the watermark it holds, so the runner reports only what
 * the machine has left.
 */
export const RunnerWatermark = Schema.Struct({
  diskFreeBytes: Bytes,
  availableMemoryBytes: Bytes,
});

export type RunnerWatermark = Schema.Schema.Type<typeof RunnerWatermark>;

/**
 * What a machine reports about itself when it presents a join token: only what
 * the controller cannot work out for itself. Everything else about a runner is
 * probed or assigned. When `reserved` is absent, the machine is not reserved.
 *
 * The only decoder of this schema rejects unknown keys, so a misspelled
 * `reserved` is an error rather than a machine silently enrolled as a shared
 * one.
 */
export const JoinRequest = Schema.Struct({
  reserved: Schema.optionalKey(Schema.Boolean),
});

export type JoinRequest = Schema.Schema.Type<typeof JoinRequest>;

/**
 * What the controller returns to a machine that presented a valid join token.
 * The credential appears in this response and nowhere else. The runner stores
 * the identity and key and trusts only them: a controller is a logical
 * identity, not an address, so a hello signed by another key is rejected
 * wherever it comes from.
 */
export const JoinAnswer = Schema.Struct({
  runnerId: Fact,
  name: Fact,
  credential: Fact,
  controllerIdentityId: Fact,
  controllerPublicKey: Base64,
});

export type JoinAnswer = Schema.Schema.Type<typeof JoinAnswer>;

/**
 * The first line a runner started by a controller writes to its stdout: the id
 * it already holds, or a request to be enrolled. No stored record tells the
 * controller which runner is the local one, and `runner.json` belongs to the
 * runner, so the child reports its identity over the pipe they share.
 *
 * After a request to be enrolled, the child writes a second line once the join
 * succeeds: the `runnerId` form, with the id the join gave it.
 */
export const LocalAnnouncement = Schema.Union([
  Schema.Struct({ runnerId: Fact }),
  Schema.Struct({ join: Schema.Literal(true) }),
]);

export type LocalAnnouncement = Schema.Schema.Type<typeof LocalAnnouncement>;

/**
 * What the controller writes back on the child's stdin. This is the only place
 * the token appears: not in the argv, which `ps` shows to every account on the
 * machine, and not in the environment, which every process the child starts
 * inherits.
 */
export const LocalEnrolment = Schema.Struct({
  /** The controller's URL, as a process on this machine reaches it. */
  controllerUrl: Fact,
  token: Fact,
});

export type LocalEnrolment = Schema.Schema.Type<typeof LocalEnrolment>;

/**
 * Just enough of any frame to read its protocol version. A newer peer's hello
 * may have fields this build's schema rejects, so the full decode fails before
 * the version can be read. Reading the version first lets this build reject an
 * incompatible peer with a clear reason. It has to exist in version 1, because
 * version 2 cannot add it to an older build it is talking to.
 */
export const PeerVersion = Schema.Struct({ protocolVersion: ProtocolVersion });

export type PeerVersion = Schema.Schema.Type<typeof PeerVersion>;

/**
 * The runner's opening frame. It proves nothing: the credential was sent with
 * the upgrade request, and this frame carries the nonce the controller signs.
 */
export const RunnerHello = Schema.Struct({
  _tag: Schema.Literal("runnerHello"),
  protocolVersion: ProtocolVersion,
  capabilities: Capabilities,
  binaryVersion: Fact,
  nonce: Base64,
  facts: RunnerFacts,
});

export type RunnerHello = Schema.Schema.Type<typeof RunnerHello>;

/** The reply to a `Ping`. Receiving it updates `lastSeenAt`. */
export const Pong = Schema.Struct({ _tag: Schema.Literal("pong") });

export type Pong = Schema.Schema.Type<typeof Pong>;

/**
 * What the runner reports about its machine: hourly when something changed,
 * and whenever the controller asks. The name includes "runner" because the
 * controller has facts of its own that this frame does not carry.
 */
export const RunnerFactsReport = Schema.Struct({
  _tag: Schema.Literal("factsReport"),
  facts: RunnerFacts,
});

export type RunnerFactsReport = Schema.Schema.Type<typeof RunnerFactsReport>;

export const WatermarkReport = Schema.Struct({
  _tag: Schema.Literal("watermarkReport"),
  watermark: RunnerWatermark,
});

export type WatermarkReport = Schema.Schema.Type<typeof WatermarkReport>;

/**
 * One choice the composer offers for a model: a select over named values, or a
 * switch. Each harness decides what it accepts per model, so this is probed
 * from the harness rather than written by hand.
 */
export const ModelOption = Schema.Struct({
  id: Fact,
  label: Fact,
  kind: Schema.Literals(["select", "boolean"]),
  choices: Schema.optionalKey(
    Schema.Array(Schema.Struct({ value: Fact, label: Fact })).check(
      Schema.isMaxLength(MAX_FACT_ITEMS),
    ),
  ),
  default: Schema.Union([Schema.String, Schema.Boolean]),
});

export type ModelOption = Schema.Schema.Type<typeof ModelOption>;

/** One model a harness offers, and the per-model choices that come with it. */
export const ModelDescriptor = Schema.Struct({
  slug: Fact,
  name: Fact,
  isDefault: Schema.optionalKey(Schema.Boolean),
  /** A model the harness no longer lists but still forwards to the API. */
  isLegacy: Schema.optionalKey(Schema.Boolean),
  options: Schema.Array(ModelOption).check(Schema.isMaxLength(MAX_FACT_ITEMS)),
});

export type ModelDescriptor = Schema.Schema.Type<typeof ModelDescriptor>;

/** Whether the harness reports a usable login, and whose it is. */
export const SnapshotAuth = Schema.Struct({
  status: Schema.Literals(["ok", "unauthenticated", "error"]),
  identity: Schema.optionalKey(Fact),
  planLabel: Schema.optionalKey(Fact),
  backend: Schema.optionalKey(Fact),
  /** Why the probe failed, so an `error` is something the user can act on. */
  message: Schema.optionalKey(Fact),
});

export type SnapshotAuth = Schema.Schema.Type<typeof SnapshotAuth>;

/**
 * What one runner found out about one provider instance. A probe has no side
 * effects: it reads the harness's own account and model list and makes no API
 * call.
 */
export const ProbeResult = Schema.Struct({
  harnessVersion: Schema.NullOr(Fact),
  auth: SnapshotAuth,
  models: Schema.Array(ModelDescriptor).check(Schema.isMaxLength(MAX_FACT_ITEMS)),
});

export type ProbeResult = Schema.Schema.Type<typeof ProbeResult>;

/**
 * Matches a request with its reply: several exchanges can be in progress on
 * one connection.
 */
const RequestId = Fact;

/**
 * Asks the runner to probe one provider instance. The instance id and its
 * config live on the controller, so the runner cannot start this on its own.
 */
export const ProbeRequest = Schema.Struct({
  _tag: Schema.Literal("probeRequest"),
  requestId: RequestId,
  instanceId: InstanceId,
  providerId: Fact,
  config: Schema.Json,
  /** The instance's credentials, which its config never holds; `{}` when none. */
  secrets: InstanceSecrets,
});

export type ProbeRequest = Schema.Schema.Type<typeof ProbeRequest>;

export const ProbeReport = Schema.Struct({
  _tag: Schema.Literal("probeReport"),
  requestId: RequestId,
  instanceId: InstanceId,
  result: ProbeResult,
});

export type ProbeReport = Schema.Schema.Type<typeof ProbeReport>;

export const InstallRequest = Schema.Struct({
  _tag: Schema.Literal("installRequest"),
  requestId: RequestId,
  providerId: Fact,
});

export type InstallRequest = Schema.Schema.Type<typeof InstallRequest>;

export const MAX_INSTALL_MESSAGE_LENGTH = 4096;

/**
 * How an install ended. The runner reports its facts before this frame, so a
 * controller that reads the row after an `ok` sees the machine's current
 * state.
 */
export const InstallResult = Schema.Struct({
  _tag: Schema.Literal("installResult"),
  requestId: RequestId,
  ok: Schema.Boolean,
  /** The installer's error output when it failed, so an operator can act on it. */
  message: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(MAX_INSTALL_MESSAGE_LENGTH))),
});

export type InstallResult = Schema.Schema.Type<typeof InstallResult>;

/**
 * The longest authorize URL a vendor's login may print. OAuth URLs include a
 * challenge and a redirect. Exported because the runner rejects a longer one
 * rather than forwarding a link nobody can finish.
 */
export const MAX_AUTHORIZE_URL_LENGTH = 2048;

const AuthorizeUrl = Schema.String.check(Schema.isLengthBetween(1, MAX_AUTHORIZE_URL_LENGTH));

/**
 * Asks the runner to start the vendor's own login for one instance. The
 * credential lands in that instance's config directory, which is why this is
 * routed on the instance rather than on the provider.
 */
export const LoginStart = Schema.Struct({
  _tag: Schema.Literal("loginStart"),
  requestId: RequestId,
  instanceId: InstanceId,
  providerId: Fact,
});

export type LoginStart = Schema.Schema.Type<typeof LoginStart>;

export const LoginCode = Schema.Struct({
  _tag: Schema.Literal("loginCode"),
  requestId: RequestId,
  instanceId: InstanceId,
  code: Schema.String.check(Schema.isLengthBetween(1, MAX_FACT_LENGTH)),
});

export type LoginCode = Schema.Schema.Type<typeof LoginCode>;

/** The URL the user opens to authorize, in their own browser, on any machine. */
/** The longest a printed login code may stay valid, in seconds: one day. */
export const MAX_LOGIN_CODE_SECONDS = 86_400;

export const LoginUrl = Schema.Struct({
  _tag: Schema.Literal("loginUrl"),
  requestId: RequestId,
  url: AuthorizeUrl,
  /** Present when the vendor printed a code to type in the browser, instead of expecting a code back. */
  userCode: Schema.optionalKey(Fact),
  /**
   * How many seconds the printed code stays valid, counted from when this
   * frame was sent. Present with `userCode`. A duration rather than an instant,
   * so the runner's clock never has to agree with the controller's. Optional,
   * because a runner on an older build does not send it.
   *
   * At most a day. No vendor's code lasts that long, and the bound keeps the
   * instant the controller computes from it a valid date.
   */
  expiresInSeconds: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(MAX_LOGIN_CODE_SECONDS)),
  ),
});

export type LoginUrl = Schema.Schema.Type<typeof LoginUrl>;

/**
 * The capability for `LoginEnded`. The runner lists it at hello when it sends
 * the frame, and the controller when it reads it. A controller on an older
 * build closes the socket on a frame it cannot read, so the runner sends
 * `LoginEnded` only when the controller's hello lists this.
 */
export const LOGIN_ENDED_CAPABILITY = "loginEnded";

/**
 * Sent by the runner, unasked, when a device login stops waiting: its vendor
 * exited, or its code expired and the runner stopped it. A device login reads
 * nothing back, so this is the only way the controller learns that the user
 * finished it in the browser. The frame carries no outcome: the controller
 * probes the instance again, and the probe says whether the login worked.
 *
 * `requestId` is the request id of the `LoginStart` that started the login.
 * It names one login rather than an instance, so the controller can tell this
 * login's end from the end of an earlier login on the same instance. The
 * controller knows which instance the login belongs to, so the frame does not
 * repeat it.
 */
export const LoginEnded = Schema.Struct({
  _tag: Schema.Literal("loginEnded"),
  requestId: RequestId,
});

export type LoginEnded = Schema.Schema.Type<typeof LoginEnded>;

/**
 * The login cannot continue: no URL arrived, or there is no login in progress
 * to send a code to. This is different from a rejected code, which leaves the
 * login in progress.
 */
export const LoginFailed = Schema.Struct({
  _tag: Schema.Literal("loginFailed"),
  requestId: RequestId,
  message: Fact,
});

export type LoginFailed = Schema.Schema.Type<typeof LoginFailed>;

/**
 * The result of a pasted code. `ok: false` means the vendor rejected the code,
 * and the login still accepts another one.
 */
export const LoginResult = Schema.Struct({
  _tag: Schema.Literal("loginResult"),
  requestId: RequestId,
  ok: Schema.Boolean,
  message: Schema.optionalKey(Fact),
});

export type LoginResult = Schema.Schema.Type<typeof LoginResult>;

/** A deliberate disconnect, which is how the controller tells `offline` apart from silence. */
export const Goodbye = Schema.Struct({ _tag: Schema.Literal("goodbye") });

export type Goodbye = Schema.Schema.Type<typeof Goodbye>;

export const RunnerToController = Schema.Union([
  RunnerHello,
  Pong,
  RunnerFactsReport,
  WatermarkReport,
  ProbeReport,
  InstallResult,
  LoginUrl,
  LoginFailed,
  LoginResult,
  LoginEnded,
  SessionEvent,
  SessionInputResult,
  SessionsReport,
  WorkspaceReport,
  WorkspaceInspection,
  CredentialRequest,
  WorkspaceStepResult,
  WorkspaceStepsReport,
  Goodbye,
]);

export type RunnerToController = Schema.Schema.Type<typeof RunnerToController>;

/**
 * The controller's opening frame. `signature` signs `encodeChallengeBytes` with
 * the key in `publicKey`, which is how a runner recognises its own controller
 * at whatever address it is reached.
 */
export const ControllerHello = Schema.Struct({
  _tag: Schema.Literal("controllerHello"),
  protocolVersion: ProtocolVersion,
  capabilities: Capabilities,
  /**
   * Compared byte for byte with the one `runner.json` holds. The public
   * contract defines its format, and this package depends on nothing but
   * `effect`, so this only checks that it is an identifier.
   */
  identityId: Fact,
  publicKey: Base64,
  nonce: Base64,
  signature: Base64,
});

export type ControllerHello = Schema.Schema.Type<typeof ControllerHello>;

/**
 * Returns the bytes a controller signs when it answers a hello.
 *
 * The bytes include the runner's own id next to the nonce. A signature over the
 * nonce alone would be valid on any connection: anyone holding any runner
 * credential could open a socket, forward a victim's nonce as its own, and
 * relay the reply as proof of an identity it does not have. The prefix keeps
 * these bytes from being mistaken for anything else the same key signs. A
 * nonce is standard base64, whose alphabet has no colon, so the last colon
 * always separates the id from the nonce.
 */
export const encodeChallengeBytes = (runnerId: string, nonce: string): Uint8Array<ArrayBuffer> =>
  new TextEncoder().encode(`hercule:runner-hello:${runnerId}:${nonce}`);

/**
 * Asks the runner to probe its machine now and report what it finds, whether or
 * not anything changed. The hourly report is sent only on a change, so without
 * this, an operator who presses "Refresh facts" on an unchanged machine would
 * wait for a frame that never comes.
 */
export const RunnerFactsRequest = Schema.Struct({ _tag: Schema.Literal("factsRequest") });

export type RunnerFactsRequest = Schema.Schema.Type<typeof RunnerFactsRequest>;

/** The liveness check. A protocol frame, so it proves the runner process is alive. */
export const Ping = Schema.Struct({ _tag: Schema.Literal("ping") });

export type Ping = Schema.Schema.Type<typeof Ping>;

export const Ack = Schema.Struct({
  _tag: Schema.Literal("ack"),
  lastAckedSeq: Seq,
});

export type Ack = Schema.Schema.Type<typeof Ack>;

export const ControllerToRunner = Schema.Union([
  ControllerHello,
  Ping,
  Ack,
  RunnerFactsRequest,
  ProbeRequest,
  InstallRequest,
  LoginStart,
  LoginCode,
  SessionStart,
  SessionStop,
  SessionInput,
  SessionInterrupt,
  SessionRespondToApprovalRequest,
  SessionRespondToQuestion,
  WorkspaceProvision,
  WorkspaceDispose,
  WorkspaceDetach,
  WorkspaceInspect,
  CredentialAnswer,
  WorkspaceStepStart,
  WorkspaceStepSettle,
]);

export type ControllerToRunner = Schema.Schema.Type<typeof ControllerToRunner>;
