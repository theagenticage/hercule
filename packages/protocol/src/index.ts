/**
 * The controller-runner protocol: one versioned catalogue of the messages that
 * cross the single WebSocket a runner holds with its controller.
 *
 * A hello that cannot be honoured is answered by closing the socket with a
 * reason rather than by a message, which is why the catalogue carries no error
 * member.
 *
 * This package sits on the runner's import path, so it depends on nothing but
 * `effect`.
 */
import { Schema } from "effect";

import {
  Fact,
  InstanceId,
  InstanceSecrets,
  MAX_FACT_LENGTH,
  Seq,
  Sequenced,
  StorageId,
  Subdirectory,
} from "./primitives";
import {
  SessionEvent,
  SessionInput,
  SessionInputResult,
  SessionInterrupt,
  SessionRespond,
  SessionsReport,
  SessionStart,
  SessionStop,
} from "./sessions";
import {
  CredentialAnswer,
  CredentialRequest,
  WorkspaceDispose,
  WorkspaceProvision,
  WorkspaceReport,
} from "./workspaces";

export * from "./output-schema";
export * from "./remote";
export * from "./sessions";
export * from "./workspaces";
export { Fact, InstanceId, MAX_FACT_LENGTH, Sequenced, StorageId, Subdirectory };

export const PROTOCOL_VERSION = 1;

/**
 * How the controller ends a connection whose runner it has just retired, and
 * the one close reason the runner reads. Retiring revokes the credential, so a
 * runner told this stops rather than dialling again with something dead. The
 * code is RFC 6455's policy violation: the connection is fine, the runner is
 * no longer one this controller will have.
 */
export const RETIRED_CLOSE_CODE = 1008;

export const RETIRED_CLOSE_REASON = "RETIRED";

/** RFC 6455's "going away": the connection is fine, this end is done with it. */
export const GOING_AWAY_CLOSE_CODE = 1001;

/**
 * A version a peer claims. Any version that could exist decodes, ours or not,
 * so a mismatch is refused by name rather than reported as an unreadable frame.
 *
 * Every other kind of skew between the two binaries is warn-don't-block, which
 * is why the runner sends its binary version and the controller only stores it.
 */
const ProtocolVersion = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

export const MAX_FACT_ITEMS = 64;

/** The extensibility seam: a feature is used only when both hellos name it. */
export const Capabilities = Schema.Array(Fact).check(Schema.isMaxLength(MAX_FACT_ITEMS));

/**
 * Standard base64, padding and all: the URL-safe alphabet is a different
 * encoding, refused here rather than later as a signature that will not verify.
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
  /** What `--version` said, raw when the runner could not parse it. */
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
 * The first loopback port a runner offers `GET /identity` on, and how many
 * consecutive ports it will settle for.
 *
 * The set is small and fixed rather than "whatever is free" because the web
 * app's Content-Security-Policy has to name the ports in advance, and a policy
 * naming every port would let any script in the app reach every service on the
 * reader's machine.
 */
export const IDENTITY_PORT = 4939;

export const IDENTITY_PORT_COUNT = 10;

/**
 * What a runner knows about the machine it is on. Latest-wins state, not
 * events: it rides the hello and is re-sent only when a value changed. The
 * controller stores a report whole and hands it back on its public API, which
 * is why `@hydra/contract` exports this schema rather than a copy of it.
 */
export const RunnerFacts = Schema.Struct({
  os: Fact,
  arch: Fact,
  totalMemoryBytes: Bytes,
  docker: Schema.Boolean,
  toolchains: Schema.Array(Toolchain).check(Schema.isMaxLength(MAX_FACT_ITEMS)),
  providers: Schema.Array(ProviderBinary).check(Schema.isMaxLength(MAX_FACT_ITEMS)),
  /**
   * The provider ids this runner build carries an adapter for. A fact about the
   * binary rather than the machine, so the fleet can say "no adapter in this
   * runner build" instead of finding out by asking and failing.
   */
  adapters: Schema.Array(Fact).check(Schema.isMaxLength(MAX_FACT_ITEMS)),
  /** Serves `GET /identity`, which is what resolves the "local" alias. */
  identityPort: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
});

export type RunnerFacts = Schema.Schema.Type<typeof RunnerFacts>;

/**
 * The fast-moving half of a runner's state. Never buffered: only the latest
 * matters. What a reading means for placement is the controller's to decide,
 * against the watermark it holds, so the runner reports only what the machine
 * has left.
 */
export const RunnerWatermark = Schema.Struct({
  diskFreeBytes: Bytes,
  availableMemoryBytes: Bytes,
});

export type RunnerWatermark = Schema.Schema.Type<typeof RunnerWatermark>;

/**
 * What a machine says about itself as it presents a join token. Only what the
 * controller cannot work out for itself: everything else about a runner is
 * probed or assigned. An absent `reserved` is a machine that is not personal.
 *
 * The one decoder of this refuses unknown keys, so a misspelled `reserved` is
 * an error rather than a machine quietly enlisted as a shared one.
 */
export const JoinRequest = Schema.Struct({
  reserved: Schema.optionalKey(Schema.Boolean),
});

export type JoinRequest = Schema.Schema.Type<typeof JoinRequest>;

/**
 * What the controller hands a machine that presented a valid join token. The
 * credential appears in this one answer and nowhere else, and the identity and
 * key are what the runner pins: a controller is a logical identity, not an
 * address, so a hello signed by another key is refused wherever it appears.
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
 * The first line a runner spawned by a controller writes to its stdout: the id
 * it already holds, or a request to be enlisted. Nothing durable says which
 * runner is the local one, and `runner.json` is the runner's own file, so the
 * child says on the one pipe they share who it turned out to be.
 */
export const LocalAnnouncement = Schema.Union([
  Schema.Struct({ runnerId: Fact }),
  Schema.Struct({ join: Schema.Literal(true) }),
]);

export type LocalAnnouncement = Schema.Schema.Type<typeof LocalAnnouncement>;

/**
 * What the controller writes back on the child's stdin. The only place that
 * token appears: not in the argv `ps` shows every account on the machine, and
 * not in the environment every process the child starts inherits.
 */
export const LocalEnrolment = Schema.Struct({
  /** Where the controller answers, as something on this machine reaches it. */
  controllerUrl: Fact,
  token: Fact,
});

export type LocalEnrolment = Schema.Schema.Type<typeof LocalEnrolment>;

/**
 * Just enough of any frame to read the version off it. A later peer's hello may
 * carry fields this build's schema refuses, so the full decode fails before the
 * version can be looked at; reading it first is what lets an incompatible peer
 * be refused by name. It has to exist in version 1, because version 2 cannot
 * add it retroactively to the build it is talking to.
 */
export const PeerVersion = Schema.Struct({ protocolVersion: ProtocolVersion });

export type PeerVersion = Schema.Schema.Type<typeof PeerVersion>;

/**
 * The runner's opening frame. It proves nothing: the credential rode the
 * upgrade request, and this carries the nonce the controller signs back.
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

/** The answer to a `Ping`. Its arrival is what advances `lastSeenAt`. */
export const Pong = Schema.Struct({ _tag: Schema.Literal("pong") });

export type Pong = Schema.Schema.Type<typeof Pong>;

/**
 * What the runner reports about its machine: hourly when something changed, and
 * whenever the controller asks. Named for the runner because the controller has
 * facts of its own that this frame does not carry.
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
 * switch. What a harness accepts per model is the harness's to say, so this is
 * probed rather than authored.
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
 * What one runner found out about one provider instance. Side-effect free: a
 * probe reads the harness's own account and model list and makes no API call.
 */
export const ProbeResult = Schema.Struct({
  harnessVersion: Schema.NullOr(Fact),
  auth: SnapshotAuth,
  models: Schema.Array(ModelDescriptor).check(Schema.isMaxLength(MAX_FACT_ITEMS)),
});

export type ProbeResult = Schema.Schema.Type<typeof ProbeResult>;

/**
 * Correlates a request with its answer: several exchanges can be in flight on
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
 * How an install ended. The runner reports its facts before this, so a
 * controller reading the row after an `ok` reads the machine as it now is.
 */
export const InstallResult = Schema.Struct({
  _tag: Schema.Literal("installResult"),
  requestId: RequestId,
  ok: Schema.Boolean,
  /** What the installer said when it failed, so an operator can act on it. */
  message: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(MAX_INSTALL_MESSAGE_LENGTH))),
});

export type InstallResult = Schema.Schema.Type<typeof InstallResult>;

/**
 * An authorize URL a vendor's login printed. OAuth URLs carry a challenge and a
 * redirect; exported because the runner refuses a longer one rather than
 * relaying a link nobody can finish.
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

/** Where the user has to go to authorize, in their own browser, on any machine. */
export const LoginUrl = Schema.Struct({
  _tag: Schema.Literal("loginUrl"),
  requestId: RequestId,
  url: AuthorizeUrl,
  /** Present when the vendor printed a code to type there instead of reading one back. */
  userCode: Schema.optionalKey(Fact),
});

export type LoginUrl = Schema.Schema.Type<typeof LoginUrl>;

/**
 * The exchange cannot go on: no URL came, or there is no login to hand a code
 * to. Distinct from a refused code, which leaves the login standing.
 */
export const LoginFailed = Schema.Struct({
  _tag: Schema.Literal("loginFailed"),
  requestId: RequestId,
  message: Fact,
});

export type LoginFailed = Schema.Schema.Type<typeof LoginFailed>;

/**
 * How a pasted code went. `ok: false` is the vendor's own complaint about the
 * code, and the login is still up for another paste.
 */
export const LoginResult = Schema.Struct({
  _tag: Schema.Literal("loginResult"),
  requestId: RequestId,
  ok: Schema.Boolean,
  message: Schema.optionalKey(Fact),
});

export type LoginResult = Schema.Schema.Type<typeof LoginResult>;

/** A deliberate departure, which is what tells `offline` from silence. */
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
  SessionEvent,
  SessionInputResult,
  SessionsReport,
  WorkspaceReport,
  CredentialRequest,
  Goodbye,
]);

export type RunnerToController = Schema.Schema.Type<typeof RunnerToController>;

/**
 * The controller's opening frame. `signature` is over `signedChallenge`, made
 * with the key `publicKey` names, which is how a runner recognises its own
 * controller at whatever address it answers on.
 */
export const ControllerHello = Schema.Struct({
  _tag: Schema.Literal("controllerHello"),
  protocolVersion: ProtocolVersion,
  capabilities: Capabilities,
  /**
   * Compared byte for byte with the one `runner.json` holds. Its grammar is the
   * public contract's to state and this package reaches nothing but `effect`,
   * so all that is checked here is that it is an identifier.
   */
  identityId: Fact,
  publicKey: Base64,
  nonce: Base64,
  signature: Base64,
});

export type ControllerHello = Schema.Schema.Type<typeof ControllerHello>;

/**
 * The bytes a controller signs when it answers a hello.
 *
 * The runner's own id is in there beside the nonce. Over the nonce alone a
 * signature would be good on any connection: anyone holding any runner
 * credential could open a socket, forward a victim's nonce as its own, and
 * relay the answer back as proof of an identity it does not have. The prefix
 * keeps these bytes from being mistaken for something else the same key signs,
 * and a nonce is standard base64, whose alphabet has no colon, so the last
 * colon always separates the two halves.
 */
export const signedChallenge = (runnerId: string, nonce: string): Uint8Array<ArrayBuffer> =>
  new TextEncoder().encode(`hydra:runner-hello:${runnerId}:${nonce}`);

/**
 * Asks the runner to probe its machine now and report what it finds, whether or
 * not anything changed. The hourly report is sent only on a change, so without
 * this an operator pressing "Refresh facts" on a machine nothing happened to
 * would wait for a frame that is never coming.
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
  SessionRespond,
  WorkspaceProvision,
  WorkspaceDispose,
  CredentialAnswer,
]);

export type ControllerToRunner = Schema.Schema.Type<typeof ControllerToRunner>;
