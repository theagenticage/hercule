/**
 * The controller-runner protocol: one versioned catalogue of the messages that
 * cross the single WebSocket a runner holds with its controller.
 *
 * Two tagged unions, one per direction, and nothing else. A message is a
 * struct with a `_tag`; anything a peer sends that is not in its direction's
 * union fails to decode, and a hello that cannot be honoured is answered by
 * closing the socket with a reason rather than by a message, so the catalogue
 * carries no error member.
 *
 * The version is the compatibility gate, so `protocolVersion` is an ordinary
 * integer rather than a literal: a hello claiming a version this build does not
 * speak still decodes, so the refusal can name the version instead of reporting
 * an unreadable frame. Every other kind of skew between the two binaries is
 * warn-don't-block, which is why the runner sends its binary version and the
 * controller only stores it.
 *
 * This package sits on the runner's import path, so it depends on nothing but
 * `effect`.
 */
import { Schema } from "effect";

/** The version of this catalogue the build speaks. */
export const PROTOCOL_VERSION = 1;

/**
 * A version a peer claims. Any version that could exist decodes, ours or not,
 * so a mismatch is refused by name; a number that could never be a version is
 * not a mismatch to report but a frame nobody speaking this protocol sent.
 */
const ProtocolVersion = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

/**
 * A sequence number. Counting starts at one, so zero is not a position and
 * never an "acknowledged nothing" either: a connection that has acknowledged
 * nothing sends no ack.
 */
const Seq = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

/**
 * A name, a version or a path a peer states about itself. Bounded because
 * every one of them is stored: a fact is an identifier, never a document.
 */
const Fact = Schema.String.check(Schema.isLengthBetween(1, 512));

/**
 * The extensibility seam: what a side can do, named. A feature is used only
 * when both hellos list it.
 */
const Capabilities = Schema.Array(Fact).check(Schema.isMaxLength(64));

/**
 * Key material and the nonce it signs. Standard base64, padding and all: the
 * URL-safe alphabet is a different encoding and is refused here rather than
 * failing later as a signature that will not verify.
 */
const Base64 = Schema.String.check(
  Schema.isLengthBetween(4, 1024),
  Schema.isPattern(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/, {
    title: "base64",
    description: "standard base64",
  }),
);

/** A count of bytes. Every size in this catalogue is one; none is a unit. */
const Bytes = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** A tool the runner found on its PATH. An absent one produces no entry. */
export const Toolchain = Schema.Struct({
  name: Fact,
  /** What `--version` said, raw when the runner could not parse it. */
  version: Fact,
  path: Fact,
});

export type Toolchain = Schema.Schema.Type<typeof Toolchain>;

/** A provider harness binary, listed whether or not it is there. */
export const ProviderBinary = Schema.Struct({
  name: Fact,
  present: Schema.Boolean,
  path: Schema.optionalKey(Fact),
});

export type ProviderBinary = Schema.Schema.Type<typeof ProviderBinary>;

/**
 * What a runner knows about the machine it is on. Latest-wins state, not
 * events: it rides the hello and is re-sent only when a value changed.
 *
 * The controller stores a report whole and hands it back on its public API, so
 * `RunnerFacts` in `@hydra/contract` declares the same fields with the same
 * bounds; loosening one without the other makes a fleet listing fail to answer.
 */
export const RunnerFacts = Schema.Struct({
  os: Fact,
  arch: Fact,
  totalMemoryBytes: Bytes,
  docker: Schema.Boolean,
  toolchains: Schema.Array(Toolchain).check(Schema.isMaxLength(64)),
  providers: Schema.Array(ProviderBinary).check(Schema.isMaxLength(64)),
  /** The loopback port serving `GET /identity`, which resolves the "local" alias. */
  identityPort: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
});

export type RunnerFacts = Schema.Schema.Type<typeof RunnerFacts>;

/**
 * The fast-moving half of a runner's state, refreshed on a short interval. A
 * report older than the latest one is worthless, so it is never buffered. Its
 * twin in `@hydra/contract` must agree with it, as the facts' twin must.
 */
export const RunnerWatermark = Schema.Struct({
  diskFreeBytes: Bytes,
  availableMemoryBytes: Bytes,
  acceptingPlacements: Schema.Boolean,
});

export type RunnerWatermark = Schema.Schema.Type<typeof RunnerWatermark>;

/**
 * The envelope every replayable runner event carries, so the controller can
 * acknowledge a position and the runner can replay from it. Nothing in this
 * catalogue extends it yet; the shape is fixed here so the wire is settled
 * before the first event needs it.
 */
export const Sequenced = Schema.Struct({ seq: Seq });

export type Sequenced = Schema.Schema.Type<typeof Sequenced>;

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

/** Facts that changed since the last time the runner said them. */
export const FactsReport = Schema.Struct({
  _tag: Schema.Literal("factsReport"),
  facts: RunnerFacts,
});

export type FactsReport = Schema.Schema.Type<typeof FactsReport>;

/** The current watermark. Sent after every hello and on the short interval. */
export const WatermarkReport = Schema.Struct({
  _tag: Schema.Literal("watermarkReport"),
  watermark: RunnerWatermark,
});

export type WatermarkReport = Schema.Schema.Type<typeof WatermarkReport>;

/** A deliberate departure, which is what tells `offline` from silence. */
export const Goodbye = Schema.Struct({ _tag: Schema.Literal("goodbye") });

export type Goodbye = Schema.Schema.Type<typeof Goodbye>;

/** Everything a runner may send. */
export const RunnerToController = Schema.Union([
  RunnerHello,
  Pong,
  FactsReport,
  WatermarkReport,
  Goodbye,
]);

export type RunnerToController = Schema.Schema.Type<typeof RunnerToController>;

/**
 * The controller's opening frame. `signature` is over the runner's nonce, made
 * with the key `publicKey` names, which is how a runner recognises its own
 * controller at whatever address it answers on.
 */
export const ControllerHello = Schema.Struct({
  _tag: Schema.Literal("controllerHello"),
  protocolVersion: ProtocolVersion,
  capabilities: Capabilities,
  /**
   * The controller's logical identity, which the runner compares byte for byte
   * with the one its `runner.json` holds. Its grammar is the public contract's
   * to state, and this package reaches nothing but `effect`, so what is checked
   * here is that it is an identifier and not a document.
   */
  identityId: Fact,
  publicKey: Base64,
  nonce: Base64,
  signature: Base64,
});

export type ControllerHello = Schema.Schema.Type<typeof ControllerHello>;

/** The heartbeat. A protocol frame, so it proves the runner process is alive. */
export const Ping = Schema.Struct({ _tag: Schema.Literal("ping") });

export type Ping = Schema.Schema.Type<typeof Ping>;

/** The highest sequence number the controller has durably taken. */
export const Ack = Schema.Struct({
  _tag: Schema.Literal("ack"),
  lastAckedSeq: Seq,
});

export type Ack = Schema.Schema.Type<typeof Ack>;

/** Everything a controller may send. */
export const ControllerToRunner = Schema.Union([ControllerHello, Ping, Ack]);

export type ControllerToRunner = Schema.Schema.Type<typeof ControllerToRunner>;
