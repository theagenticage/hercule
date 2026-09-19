import { describe, expect, it } from "vitest";
import { Effect, Schema } from "effect";
import {
  ControllerToRunner,
  JoinAnswer,
  LocalAnnouncement,
  LocalEnrolment,
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
const tagsOf = (union: typeof RunnerToController | typeof ControllerToRunner): Array<string> =>
  union.members.flatMap((member) =>
    // A frame whose shape depends on what it carries is a union of its own, and
    // each of its members is still that frame's tag.
    "members" in member
      ? (member.members as ReadonlyArray<{ fields: { _tag: { literal: string } } }>).map(
          (nested) => nested.fields._tag.literal,
        )
      : [member.fields._tag.literal],
  );

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
  adapters: ["claude-code"],
  identityPort: 4939,
} as const;

const watermark = {
  diskFreeBytes: 42949672960,
  availableMemoryBytes: 8589934592,
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

/** What one runner found out about one instance, with every optional key set. */
const probeResult = {
  harnessVersion: "2.1.263",
  auth: {
    status: "ok",
    identity: "rogier@example.com",
    planLabel: "Claude Max",
    backend: "firstParty",
  },
  models: [
    {
      slug: "default",
      name: "Default",
      isDefault: true,
      options: [
        {
          id: "effort",
          label: "Effort",
          kind: "select",
          choices: [{ value: "medium", label: "Medium" }],
          default: "medium",
        },
      ],
    },
  ],
} as const;

const REQUEST_ID = "0199c3f4-1f2a-7c31-9f0e-6d2b8a4e5c72";
const INSTANCE_ID = "0199c3f4-1f2a-7c31-9f0e-6d2b8a4e5c73";
const SESSION_ID = "0199c3f4-1f2a-7c31-9f0e-6d2b8a4e5c74";

const spec = {
  instanceId: INSTANCE_ID,
  workspaceId: null,
  modelSelection: { model: "sonnet", options: {} },
  accessMode: "approval-required",
  timeouts: { inactivityMs: 1_800_000, absoluteMs: 28_800_000 },
} as const;

const WORKSPACE_ID = "0199e0e7-0000-7000-8000-000000000010";

const CHECKOUT_ID = "0199e0e7-0000-7000-8000-000000000011";

const RESOURCE_ID = "0199e0e7-0000-7000-8000-000000000012";

const runnerMessages: ReadonlyArray<RunnerMessage> = [
  runnerHello,
  { _tag: "pong" },
  { _tag: "factsReport", facts },
  { _tag: "watermarkReport", watermark },
  { _tag: "probeReport", requestId: REQUEST_ID, instanceId: INSTANCE_ID, result: probeResult },
  { _tag: "installResult", requestId: REQUEST_ID, ok: false, message: "curl: (22) not found" },
  {
    _tag: "loginUrl",
    requestId: REQUEST_ID,
    url: "https://claude.ai/oauth/authorize?code=challenge",
  },
  { _tag: "loginFailed", requestId: REQUEST_ID, message: "no login in progress" },
  { _tag: "loginResult", requestId: REQUEST_ID, ok: false, message: "Invalid code." },
  {
    _tag: "sessionEvent",
    seq: 12,
    event: {
      _tag: "session.started",
      eventId: "0199c3f4-1f2a-7c31-9f0e-6d2b8a4e5c75",
      sessionId: SESSION_ID,
      at: "2026-09-07T10:00:00.000Z",
    },
  },
  { _tag: "sessionInputResult", requestId: REQUEST_ID, ok: true, delivery: "steered" },
  {
    _tag: "sessionsReport",
    sessions: [{ sessionId: SESSION_ID, nativeSessionId: "native-1", instanceId: INSTANCE_ID }],
  },
  {
    _tag: "workspaceReport",
    workspaceId: WORKSPACE_ID,
    status: "ready",
    checkouts: [
      {
        checkoutId: CHECKOUT_ID,
        branch: "hydra/run-0199e0e7",
        branches: ["main", "hydra/run-0199e0e7"],
        defaultBranch: "main",
      },
    ],
  },
  {
    _tag: "credentialRequest",
    requestId: REQUEST_ID,
    remote: "github.com/acme/web",
    sessionToken: "a-session-token",
  },
  {
    _tag: "credentialRequest",
    requestId: REQUEST_ID,
    remote: "github.com/acme/web",
    workspaceId: WORKSPACE_ID,
  },
  { _tag: "goodbye" },
];

const controllerMessages: ReadonlyArray<ControllerMessage> = [
  controllerHello,
  { _tag: "ping" },
  { _tag: "ack", lastAckedSeq: 7 },
  { _tag: "factsRequest" },
  {
    _tag: "probeRequest",
    requestId: REQUEST_ID,
    instanceId: INSTANCE_ID,
    providerId: "claude-code",
    config: {},
    secrets: {},
  },
  { _tag: "installRequest", requestId: REQUEST_ID, providerId: "claude-code" },
  { _tag: "loginStart", requestId: REQUEST_ID, instanceId: INSTANCE_ID, providerId: "claude-code" },
  { _tag: "loginCode", requestId: REQUEST_ID, instanceId: INSTANCE_ID, code: "the-pasted-code" },
  {
    _tag: "sessionStart",
    sessionId: SESSION_ID,
    providerId: "claude-code",
    config: {},
    secrets: {},
    spec,
    token: "a-session-token",
  },
  { _tag: "sessionStop", sessionId: SESSION_ID },
  {
    _tag: "sessionInput",
    requestId: "0199e0e7-0000-7000-8000-00000000000e",
    sessionId: SESSION_ID,
    input: { text: "ship it" },
  },
  { _tag: "sessionInterrupt", sessionId: SESSION_ID },
  {
    _tag: "sessionRespond",
    sessionId: SESSION_ID,
    requestId: "0199e0e7-0000-7000-8000-00000000000f",
    decision: "allow_always",
  },
  {
    _tag: "workspaceProvision",
    workspaceId: WORKSPACE_ID,
    kind: "ephemeral",
    checkouts: [
      {
        checkoutId: CHECKOUT_ID,
        resourceId: RESOURCE_ID,
        remote: "https://github.com/acme/web",
        subdirectory: null,
        branch: "hydra/run-0199e0e7",
        baseBranch: "main",
        setupCommand: "pnpm install",
        workspaceInclude: true,
      },
    ],
  },
  { _tag: "workspaceDispose", workspaceId: WORKSPACE_ID },
  // D-21 F5: the git identity rides on `sessionStart`, not on every credential.
  { _tag: "credentialAnswer", requestId: REQUEST_ID, token: "ghp_a-token", username: "octocat" },
  { _tag: "credentialAnswer", requestId: REQUEST_ID, error: "no_connection" },
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

  /**
   * D-21 F2: a machine that could not read a branch - a detached HEAD, or a git
   * that would not answer - says null rather than a word standing in for one,
   * and the wire has to carry that rather than refuse the report.
   */
  it("round-trips a checkout the machine could read no branch for", () => {
    const report = {
      _tag: "workspaceReport",
      workspaceId: WORKSPACE_ID,
      status: "ready",
      checkouts: [{ checkoutId: CHECKOUT_ID, branch: null, branches: [], defaultBranch: null }],
    } as const;
    const encoded = Schema.encodeSync(RunnerToController)(report);
    expect(Effect.runSync(Schema.decodeUnknownEffect(RunnerToController)(encoded))).toEqual(report);
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

describe("the watermark a runner reports", () => {
  it.each(["diskFreeBytes", "availableMemoryBytes"])("refuses a report without %s", (key) => {
    expect(fromRunner({ _tag: "watermarkReport", watermark: without(watermark, key) })._tag).toBe(
      "Failure",
    );
  });

  it("says nothing about placement: whether the machine may be given work is not the machine's", () => {
    const decoded = Effect.runSync(
      Schema.decodeUnknownEffect(RunnerToController)({
        _tag: "watermarkReport",
        watermark: { ...watermark, acceptingPlacements: false },
      }),
    ) as { readonly watermark: Record<string, unknown> };

    expect(decoded.watermark).not.toHaveProperty("acceptingPlacements");
    expect(decoded.watermark).toEqual(watermark);
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
  it("rides the one frame that extends the envelope, and is required there", () => {
    const event = runnerMessages.find((message) => message._tag === "sessionEvent");
    expect(fromRunner(without(event as Record<string, unknown>, "seq"))._tag).toBe("Failure");
  });

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

const provisioning = (overrides: Record<string, unknown>): Record<string, unknown> => ({
  ...(controllerMessages.find((message) => message._tag === "workspaceProvision") as Record<
    string,
    unknown
  >),
  ...overrides,
});

describe("the ids a machine makes a directory of", () => {
  it("takes the identifiers the controller mints", () => {
    expect(fromController(provisioning({}))._tag).toBe("Success");
  });

  it("refuses anything that could be a path rather than a name", () => {
    // The runner joins these into paths under its storage directory and a
    // dispose removes what they name.
    for (const workspaceId of ["../../etc", "a/b", "", "with space", ".."]) {
      expect(fromController(provisioning({ workspaceId }))._tag).toBe("Failure");
    }
    expect(fromController({ _tag: "workspaceDispose", workspaceId: "../elsewhere" })._tag).toBe(
      "Failure",
    );
  });

  it("refuses a checkout whose resource or subdirectory could climb out of the workspace", () => {
    const one = (checkout: Record<string, unknown>): Record<string, unknown> =>
      provisioning({
        checkouts: [
          {
            ...((
              controllerMessages.find((message) => message._tag === "workspaceProvision") as {
                checkouts: ReadonlyArray<Record<string, unknown>>;
              }
            ).checkouts[0] ?? {}),
            ...checkout,
          },
        ],
      });
    expect(fromController(one({ subdirectory: "web" }))._tag).toBe("Success");
    expect(fromController(one({ subdirectory: "my.repo" }))._tag).toBe("Success");
    // A repository really can be called this, and a workspace can hold it.
    expect(fromController(one({ subdirectory: ".github" }))._tag).toBe("Success");
    for (const subdirectory of ["..", ".", "../web", "web/api", ".git", ".GIT", ""]) {
      expect(fromController(one({ subdirectory }))._tag).toBe("Failure");
    }
    expect(fromController(one({ resourceId: "../../cache" }))._tag).toBe("Failure");
    expect(fromController(one({ checkoutId: "a/b" }))._tag).toBe("Failure");
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

describe("the join answer", () => {
  const answer = {
    runnerId: "0199e0e7-1111-7000-8000-000000000000",
    name: "thalia",
    credential: "sqEs5ZE0Kk_1Rz9dJqjqxN9lHkGx2xhK1zC1tXqU2Yw",
    controllerIdentityId: "0199e0e7-2222-7000-8000-000000000000",
    controllerPublicKey: "IH5nqcbHvGUYs1n9y0sBnPGSNVYA3ZfCpZKDvXH7pqA=",
  } as const;

  const decode = (input: unknown) =>
    Effect.runSyncExit(Schema.decodeUnknownEffect(JoinAnswer)(input));

  it("round-trips what the controller hands a joining machine", () => {
    const decoded = decode(answer);
    expect(decoded._tag).toBe("Success");
    expect(Effect.runSync(Schema.encodeEffect(JoinAnswer)(answer))).toEqual(answer);
  });

  it("needs every field", () => {
    for (const key of Object.keys(answer)) {
      expect(decode(without(answer, key))._tag, key).toBe("Failure");
    }
  });

  it("refuses a public key that is not standard base64, and an unbounded string", () => {
    // The URL-safe alphabet is a different encoding, and a key in it would
    // fail later as a signature that will not verify.
    expect(
      decode({ ...answer, controllerPublicKey: "IH5nqcbHvGUYs1n9-0sBnPGSNVYA3ZfCpZKDvXH7pqA=" })
        ._tag,
    ).toBe("Failure");
    expect(decode({ ...answer, credential: "x".repeat(513) })._tag).toBe("Failure");
    expect(decode({ ...answer, name: "" })._tag).toBe("Failure");
  });
});

describe("what a controller and the runner it spawned say over their pipes", () => {
  const decodeSaid = (input: unknown) =>
    Effect.runSyncExit(Schema.decodeUnknownEffect(LocalAnnouncement)(input));
  const decodeHanded = (input: unknown) =>
    Effect.runSyncExit(Schema.decodeUnknownEffect(LocalEnrolment)(input));

  it("carries the two things a child can be, and nothing between them", () => {
    const enrolled = { runnerId: "0199e0e7-1111-7000-8000-000000000000" };
    expect(decodeSaid(enrolled)._tag).toBe("Success");
    expect(Effect.runSync(Schema.encodeEffect(LocalAnnouncement)(enrolled))).toEqual(enrolled);
    expect(decodeSaid({ join: true })._tag).toBe("Success");
    // A child that says nothing, says both, or says it is not joining is a
    // child the controller cannot place: none of them is an answer.
    expect(decodeSaid({})._tag).toBe("Failure");
    expect(decodeSaid({ join: false })._tag).toBe("Failure");
    expect(decodeSaid({ runnerId: "" })._tag).toBe("Failure");
  });

  it("hands back where to join and the token to join with, both required", () => {
    const enrolment = { controllerUrl: "http://127.0.0.1:4937", token: "a-join-token" };
    expect(decodeHanded(enrolment)._tag).toBe("Success");
    expect(Effect.runSync(Schema.encodeEffect(LocalEnrolment)(enrolment))).toEqual(enrolment);
    for (const key of Object.keys(enrolment)) {
      expect(decodeHanded(without(enrolment, key))._tag, key).toBe("Failure");
    }
    expect(decodeHanded({ ...enrolment, token: "" })._tag).toBe("Failure");
  });
});
