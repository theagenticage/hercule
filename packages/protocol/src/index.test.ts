import { describe, expect, it } from "vitest";
import { Effect, Schema } from "effect";
import {
  ControllerToRunner,
  PROTOCOL_VERSION,
  RunnerToController,
  Sequenced,
  type ControllerToRunner as ControllerMessage,
  type RunnerToController as RunnerMessage,
} from "./index";

const fromRunner = (input: unknown) =>
  Effect.runSyncExit(Schema.decodeUnknownEffect(RunnerToController)(input));

const fromController = (input: unknown) =>
  Effect.runSyncExit(Schema.decodeUnknownEffect(ControllerToRunner)(input));

const sequenced = (input: unknown) =>
  Effect.runSyncExit(Schema.decodeUnknownEffect(Sequenced)(input))._tag;

/** A copy of `message` without `key`, for asserting a field is required. */
const without = (message: Record<string, unknown>, key: string) => {
  const copy = { ...message };
  delete copy[key];
  return copy;
};

/**
 * The tags a union really holds, read off the schema rather than off the list
 * of examples below it, so a member added without a case here is caught.
 */
const tagsOf = (union: typeof RunnerToController | typeof ControllerToRunner) =>
  union.members.map((member) => member.fields._tag.literal);

const facts = {
  os: "darwin",
  arch: "arm64",
  totalMemoryBytes: 68719476736,
  docker: true,
  toolchains: [
    { name: "git", version: "2.50.1", path: "/usr/bin/git" },
    { name: "gh", version: "2.99.0", path: "/opt/homebrew/bin/gh" },
  ],
  providers: [
    { name: "claude", present: true, path: "/usr/local/bin/claude" },
    { name: "codex", present: false },
  ],
  identityPort: 4939,
} as const;

const watermark = {
  diskFreeBytes: 42949672960,
  availableMemoryBytes: 8589934592,
  acceptingPlacements: true,
} as const;

const runnerHello = {
  _tag: "runnerHello",
  protocolVersion: PROTOCOL_VERSION,
  capabilities: ["sessions"],
  binaryVersion: "0.1.0",
  nonce: "bm9uY2Vib3llMQ==",
  facts,
} as const;

const controllerHello = {
  _tag: "controllerHello",
  protocolVersion: PROTOCOL_VERSION,
  capabilities: [],
  identityId: "0199c3f4-1f2a-7c31-9f0e-6d2b8a4e5c71",
  publicKey: "cHVibGljS2V5",
  nonce: "bm9uY2Vib3llMQ==",
  signature: "c2lnbmF0dXJl",
} as const;

const runnerMessages: ReadonlyArray<RunnerMessage> = [
  runnerHello,
  { _tag: "pong" },
  { _tag: "factsReport", facts },
  { _tag: "watermarkReport", watermark },
  { _tag: "goodbye" },
];

const controllerMessages: ReadonlyArray<ControllerMessage> = [
  controllerHello,
  { _tag: "ping" },
  { _tag: "ack", lastAckedSeq: 7 },
];

describe("the protocol version", () => {
  it("is 1", () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });
});

describe("the runner-to-controller catalogue", () => {
  it.each(runnerMessages)("round-trips $_tag unchanged", (message) => {
    const encoded = Schema.encodeSync(RunnerToController)(message);
    expect(Effect.runSync(Schema.decodeUnknownEffect(RunnerToController)(encoded))).toEqual(
      message,
    );
  });

  it("holds exactly the members the round-trip cases cover", () => {
    expect(tagsOf(RunnerToController)).toEqual(runnerMessages.map((message) => message._tag));
  });

  it("refuses a tag outside the union, including one the other direction owns", () => {
    expect(fromRunner({ _tag: "hello" })._tag).toBe("Failure");
    expect(fromRunner({ _tag: "ping" })._tag).toBe("Failure");
    expect(fromRunner({})._tag).toBe("Failure");
  });
});

describe("the controller-to-runner catalogue", () => {
  it.each(controllerMessages)("round-trips $_tag unchanged", (message) => {
    const encoded = Schema.encodeSync(ControllerToRunner)(message);
    expect(Effect.runSync(Schema.decodeUnknownEffect(ControllerToRunner)(encoded))).toEqual(
      message,
    );
  });

  it("holds exactly the members the round-trip cases cover", () => {
    expect(tagsOf(ControllerToRunner)).toEqual(controllerMessages.map((message) => message._tag));
  });

  it("refuses a tag outside the union, including one the other direction owns", () => {
    expect(fromController({ _tag: "hello" })._tag).toBe("Failure");
    expect(fromController({ _tag: "goodbye" })._tag).toBe("Failure");
    expect(fromController({})._tag).toBe("Failure");
  });
});

describe("the runner hello", () => {
  it.each(["protocolVersion", "capabilities", "binaryVersion", "nonce", "facts"])(
    "refuses a hello without %s",
    (key) => {
      expect(fromRunner(without(runnerHello, key))._tag).toBe("Failure");
    },
  );

  it("decodes a version that is not ours, so the mismatch is answered rather than dropped", () => {
    expect(fromRunner({ ...runnerHello, protocolVersion: PROTOCOL_VERSION + 1 })._tag).toBe(
      "Success",
    );
  });

  it("carries no credential", () => {
    const decoded = Effect.runSync(
      Schema.decodeUnknownEffect(RunnerToController)({ ...runnerHello, credential: "secret" }),
    );
    expect(decoded).not.toHaveProperty("credential");
  });
});

describe("the controller hello", () => {
  it.each(["protocolVersion", "capabilities", "identityId", "publicKey", "nonce", "signature"])(
    "refuses a hello without %s",
    (key) => {
      expect(fromController(without(controllerHello, key))._tag).toBe("Failure");
    },
  );

  it.each(["publicKey", "nonce", "signature"])(
    "refuses a %s that is not standard base64",
    (key) => {
      // The URL-safe alphabet is the mistake to catch: it looks like base64,
      // decodes to different bytes, and would surface as a bad signature.
      expect(fromController({ ...controllerHello, [key]: "c2ln-mF0dXJl" })._tag).toBe("Failure");
      expect(fromController({ ...controllerHello, [key]: "c2lnbmF0dXJlL" })._tag).toBe("Failure");
    },
  );

  it("carries no credential", () => {
    const decoded = Effect.runSync(
      Schema.decodeUnknownEffect(ControllerToRunner)({
        ...controllerHello,
        credential: "secret",
      }),
    );
    expect(decoded).not.toHaveProperty("credential");
  });
});

describe("the runner facts", () => {
  it("takes an identity port inside the port range and nothing outside it", () => {
    const withPort = (identityPort: unknown) =>
      fromRunner({ _tag: "factsReport", facts: { ...facts, identityPort } })._tag;
    expect(withPort(4939)).toBe("Success");
    expect(withPort(65535)).toBe("Success");
    expect(withPort(0)).toBe("Failure");
    expect(withPort(65536)).toBe("Failure");
  });

  it("takes a toolchain version it could not parse, but not an empty one", () => {
    const withVersion = (version: string) =>
      fromRunner({
        _tag: "factsReport",
        facts: { ...facts, toolchains: [{ name: "git", version, path: "/usr/bin/git" }] },
      })._tag;
    expect(withVersion("some unparsed banner")).toBe("Success");
    expect(withVersion("")).toBe("Failure");
  });
});

describe("sequence numbers", () => {
  it("takes an integer of at least one", () => {
    expect(sequenced({ seq: 1 })).toBe("Success");
    expect(sequenced({ seq: 9007199254740991 })).toBe("Success");
    expect(fromController({ _tag: "ack", lastAckedSeq: 1 })._tag).toBe("Success");
  });

  it("refuses zero, a negative, a fraction and a string", () => {
    expect(sequenced({ seq: 0 })).toBe("Failure");
    expect(sequenced({ seq: -1 })).toBe("Failure");
    expect(sequenced({ seq: 1.5 })).toBe("Failure");
    expect(sequenced({ seq: "1" })).toBe("Failure");
    expect(fromController({ _tag: "ack", lastAckedSeq: 0 })._tag).toBe("Failure");
    expect(fromController({ _tag: "ack", lastAckedSeq: 1.5 })._tag).toBe("Failure");
    expect(fromController({ _tag: "ack", lastAckedSeq: "1" })._tag).toBe("Failure");
  });
});

describe("the bare messages", () => {
  it.each(["pong", "goodbye"])("gives %s nothing beyond its tag", (tag) => {
    const decoded = Effect.runSync(
      Schema.decodeUnknownEffect(RunnerToController)({ _tag: tag, seq: 3 }),
    );
    expect(Object.keys(decoded)).toEqual(["_tag"]);
  });

  it("gives ping nothing beyond its tag", () => {
    const decoded = Effect.runSync(
      Schema.decodeUnknownEffect(ControllerToRunner)({ _tag: "ping", seq: 3 }),
    );
    expect(Object.keys(decoded)).toEqual(["_tag"]);
  });
});
