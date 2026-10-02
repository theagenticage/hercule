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

const decodeFromRunner = (input: unknown) =>
  Effect.runSyncExit(Schema.decodeUnknownEffect(RunnerToController)(input));

const decodeFromController = (input: unknown) =>
  Effect.runSyncExit(Schema.decodeUnknownEffect(ControllerToRunner)(input));

const decodeSequenced = (input: unknown) =>
  Effect.runSyncExit(Schema.decodeUnknownEffect(Sequenced)(input))._tag;

/** A copy of `message` without `key`, for asserting a field is required. */
const omitKey = (message: Record<string, unknown>, key: string) => {
  const copy = { ...message };
  delete copy[key];
  return copy;
};

/**
 * Lists the tags a union actually holds, read from the schema rather than from
 * the list of examples below, so a member added without a test case is caught.
 */
const listTags = (union: typeof RunnerToController | typeof ControllerToRunner): Array<string> =>
  union.members.flatMap((member) =>
    // A frame whose shape depends on its content is a union of its own, and
    // each of its members has that frame's tag.
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

const STEP_KEY = {
  runId: "0199e0e7-0000-7000-8000-000000000013",
  stepId: "commit",
  iteration: 1,
} as const;

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
  { _tag: "loginEnded", instanceId: INSTANCE_ID },
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
        branch: "hercule/run-0199e0e7",
        branches: ["main", "hercule/run-0199e0e7"],
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
  {
    _tag: "workspaceStepResult",
    ...STEP_KEY,
    outcome: { status: "completed", output: { sha: "4b825dc6", branch: "main", committed: true } },
  },
  { _tag: "workspaceStepsReport", steps: [STEP_KEY] },
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
    _tag: "sessionRespondToApprovalRequest",
    sessionId: SESSION_ID,
    requestId: "0199e0e7-0000-7000-8000-00000000000f",
    decision: "allow_always",
  },
  {
    _tag: "sessionRespondToQuestion",
    sessionId: SESSION_ID,
    requestId: "0199e0e7-0000-7000-8000-00000000000f",
    answers: { Storage: "localStorage", Features: ["Sync", "Search"] },
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
        branch: "hercule/run-0199e0e7",
        baseBranch: "main",
        setupCommand: "pnpm install",
        workspaceInclude: true,
      },
    ],
  },
  { _tag: "workspaceDispose", workspaceId: WORKSPACE_ID },
  // The git identity is sent once on `sessionStart`, not with every credential.
  { _tag: "credentialAnswer", requestId: REQUEST_ID, token: "ghp_a-token", username: "octocat" },
  { _tag: "credentialAnswer", requestId: REQUEST_ID, error: "no_connection" },
  {
    _tag: "workspaceStepStart",
    ...STEP_KEY,
    workspaceId: WORKSPACE_ID,
    action: "git.commit",
    input: { message: "Fix the login form" },
    resourceId: RESOURCE_ID,
    gitIdentity: { name: "octocat", email: "octocat@users.noreply.github.com" },
  },
  { _tag: "workspaceStepSettle", steps: [STEP_KEY] },
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

  it("has exactly the members the round-trip cases cover", () => {
    expect(listTags(RunnerToController)).toEqual(runnerMessages.map((message) => message._tag));
  });

  /**
   * A machine that could not read a branch - a detached HEAD, or a git command
   * that failed - reports null rather than a placeholder word, and the wire
   * has to accept that rather than reject the report.
   */
  it("round-trips a checkout the machine could not read a branch for", () => {
    const report = {
      _tag: "workspaceReport",
      workspaceId: WORKSPACE_ID,
      status: "ready",
      checkouts: [{ checkoutId: CHECKOUT_ID, branch: null, branches: [], defaultBranch: null }],
    } as const;
    const encoded = Schema.encodeSync(RunnerToController)(report);
    expect(Effect.runSync(Schema.decodeUnknownEffect(RunnerToController)(encoded))).toEqual(report);
  });

  it("round-trips a device login's URL, with its code and how long the code lasts", () => {
    const device = {
      _tag: "loginUrl",
      requestId: REQUEST_ID,
      url: "https://auth.openai.com/codex/device",
      userCode: "ABCD-1234",
      expiresInSeconds: 900,
    } as const;
    const encoded = Schema.encodeSync(RunnerToController)(device);
    expect(Effect.runSync(Schema.decodeUnknownEffect(RunnerToController)(encoded))).toEqual(device);
  });

  it("rejects a device login code that has already expired", () => {
    expect(
      decodeFromRunner({
        _tag: "loginUrl",
        requestId: REQUEST_ID,
        url: "https://auth.openai.com/codex/device",
        userCode: "ABCD-1234",
        expiresInSeconds: 0,
      })._tag,
    ).toBe("Failure");
  });

  it("rejects a tag outside the union, including one from the other direction", () => {
    expect(decodeFromRunner({ _tag: "hello" })._tag).toBe("Failure");
    expect(decodeFromRunner({ _tag: "ping" })._tag).toBe("Failure");
    expect(decodeFromRunner({})._tag).toBe("Failure");
  });
});

describe("the controller-to-runner catalogue", () => {
  it.each(controllerMessages)("round-trips $_tag unchanged", (message) => {
    const encoded = Schema.encodeSync(ControllerToRunner)(message);
    expect(Effect.runSync(Schema.decodeUnknownEffect(ControllerToRunner)(encoded))).toEqual(
      message,
    );
  });

  it("has exactly the members the round-trip cases cover", () => {
    expect(listTags(ControllerToRunner)).toEqual(controllerMessages.map((message) => message._tag));
  });

  it("rejects a tag outside the union, including one from the other direction", () => {
    expect(decodeFromController({ _tag: "hello" })._tag).toBe("Failure");
    expect(decodeFromController({ _tag: "goodbye" })._tag).toBe("Failure");
    expect(decodeFromController({})._tag).toBe("Failure");
  });
});

describe("the runner hello", () => {
  it.each(["protocolVersion", "capabilities", "binaryVersion", "nonce", "facts"])(
    "rejects a hello without %s",
    (key) => {
      expect(decodeFromRunner(omitKey(runnerHello, key))._tag).toBe("Failure");
    },
  );

  it("decodes a version that is not ours, so the mismatch gets a reply rather than being dropped", () => {
    expect(decodeFromRunner({ ...runnerHello, protocolVersion: PROTOCOL_VERSION + 1 })._tag).toBe(
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
  it.each(["diskFreeBytes", "availableMemoryBytes"])("rejects a report without %s", (key) => {
    expect(
      decodeFromRunner({ _tag: "watermarkReport", watermark: omitKey(watermark, key) })._tag,
    ).toBe("Failure");
  });

  it("drops a placement field: the controller, not the machine, decides whether it gets work", () => {
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
    "rejects a hello without %s",
    (key) => {
      expect(decodeFromController(omitKey(controllerHello, key))._tag).toBe("Failure");
    },
  );

  it.each(["publicKey", "nonce", "signature"])(
    "rejects a %s that is not standard base64",
    (key) => {
      // The URL-safe alphabet is the mistake to catch: it looks like base64,
      // decodes to different bytes, and would surface as a bad signature.
      expect(decodeFromController({ ...controllerHello, [key]: "c2ln-mF0dXJl" })._tag).toBe(
        "Failure",
      );
      expect(decodeFromController({ ...controllerHello, [key]: "c2lnbmF0dXJlL" })._tag).toBe(
        "Failure",
      );
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
  it("accepts an identity port inside the port range and nothing outside it", () => {
    const withPort = (identityPort: unknown) =>
      decodeFromRunner({ _tag: "factsReport", facts: { ...facts, identityPort } })._tag;
    expect(withPort(4939)).toBe("Success");
    expect(withPort(65535)).toBe("Success");
    expect(withPort(0)).toBe("Failure");
    expect(withPort(65536)).toBe("Failure");
  });

  it("accepts a toolchain version the runner could not parse, but not an empty one", () => {
    const withVersion = (version: string) =>
      decodeFromRunner({
        _tag: "factsReport",
        facts: { ...facts, toolchains: [{ name: "git", version, path: "/usr/bin/git" }] },
      })._tag;
    expect(withVersion("some unparsed banner")).toBe("Success");
    expect(withVersion("")).toBe("Failure");
  });
});

describe("sequence numbers", () => {
  it("is carried by the one frame that extends the envelope, and is required there", () => {
    const event = runnerMessages.find((message) => message._tag === "sessionEvent");
    expect(decodeFromRunner(omitKey(event as Record<string, unknown>, "seq"))._tag).toBe("Failure");
  });

  it("accepts an integer of at least one", () => {
    expect(decodeSequenced({ seq: 1 })).toBe("Success");
    expect(decodeSequenced({ seq: 9007199254740991 })).toBe("Success");
    expect(decodeFromController({ _tag: "ack", lastAckedSeq: 1 })._tag).toBe("Success");
  });

  it("rejects zero, a negative, a fraction and a string", () => {
    expect(decodeSequenced({ seq: 0 })).toBe("Failure");
    expect(decodeSequenced({ seq: -1 })).toBe("Failure");
    expect(decodeSequenced({ seq: 1.5 })).toBe("Failure");
    expect(decodeSequenced({ seq: "1" })).toBe("Failure");
    expect(decodeFromController({ _tag: "ack", lastAckedSeq: 0 })._tag).toBe("Failure");
    expect(decodeFromController({ _tag: "ack", lastAckedSeq: 1.5 })._tag).toBe("Failure");
    expect(decodeFromController({ _tag: "ack", lastAckedSeq: "1" })._tag).toBe("Failure");
  });
});

const buildProvisionMessage = (overrides: Record<string, unknown>): Record<string, unknown> => ({
  ...(controllerMessages.find((message) => message._tag === "workspaceProvision") as Record<
    string,
    unknown
  >),
  ...overrides,
});

describe("the ids a machine uses as directory names", () => {
  it("accepts the identifiers the controller creates", () => {
    expect(decodeFromController(buildProvisionMessage({}))._tag).toBe("Success");
  });

  it("rejects anything that could be a path rather than a name", () => {
    // The runner joins these into paths under its storage directory, and a
    // dispose removes those paths.
    for (const workspaceId of ["../../etc", "a/b", "", "with space", ".."]) {
      expect(decodeFromController(buildProvisionMessage({ workspaceId }))._tag).toBe("Failure");
    }
    expect(
      decodeFromController({ _tag: "workspaceDispose", workspaceId: "../elsewhere" })._tag,
    ).toBe("Failure");
  });

  it("rejects a checkout whose resource or subdirectory could escape the workspace", () => {
    const buildProvisionWithCheckout = (
      checkout: Record<string, unknown>,
    ): Record<string, unknown> =>
      buildProvisionMessage({
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
    expect(decodeFromController(buildProvisionWithCheckout({ subdirectory: "web" }))._tag).toBe(
      "Success",
    );
    expect(decodeFromController(buildProvisionWithCheckout({ subdirectory: "my.repo" }))._tag).toBe(
      "Success",
    );
    // A repository really can be called this, and a workspace can hold it.
    expect(decodeFromController(buildProvisionWithCheckout({ subdirectory: ".github" }))._tag).toBe(
      "Success",
    );
    for (const subdirectory of ["..", ".", "../web", "web/api", ".git", ".GIT", ""]) {
      expect(decodeFromController(buildProvisionWithCheckout({ subdirectory }))._tag).toBe(
        "Failure",
      );
    }
    expect(
      decodeFromController(buildProvisionWithCheckout({ resourceId: "../../cache" }))._tag,
    ).toBe("Failure");
    expect(decodeFromController(buildProvisionWithCheckout({ checkoutId: "a/b" }))._tag).toBe(
      "Failure",
    );
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

  it("round-trips what the controller returns to a joining machine", () => {
    const decoded = decode(answer);
    expect(decoded._tag).toBe("Success");
    expect(Effect.runSync(Schema.encodeEffect(JoinAnswer)(answer))).toEqual(answer);
  });

  it("needs every field", () => {
    for (const key of Object.keys(answer)) {
      expect(decode(omitKey(answer, key))._tag, key).toBe("Failure");
    }
  });

  it("rejects a public key that is not standard base64, and a string that is too long", () => {
    // The URL-safe alphabet is a different encoding, and a key in it would
    // fail later as a signature that does not verify.
    expect(
      decode({ ...answer, controllerPublicKey: "IH5nqcbHvGUYs1n9-0sBnPGSNVYA3ZfCpZKDvXH7pqA=" })
        ._tag,
    ).toBe("Failure");
    expect(decode({ ...answer, credential: "x".repeat(513) })._tag).toBe("Failure");
    expect(decode({ ...answer, name: "" })._tag).toBe("Failure");
  });
});

describe("the messages a controller and the runner it started exchange over their pipes", () => {
  const decodeAnnouncement = (input: unknown) =>
    Effect.runSyncExit(Schema.decodeUnknownEffect(LocalAnnouncement)(input));
  const decodeEnrolment = (input: unknown) =>
    Effect.runSyncExit(Schema.decodeUnknownEffect(LocalEnrolment)(input));

  it("accepts the two things a child can announce, and nothing else", () => {
    const enrolled = { runnerId: "0199e0e7-1111-7000-8000-000000000000" };
    expect(decodeAnnouncement(enrolled)._tag).toBe("Success");
    expect(Effect.runSync(Schema.encodeEffect(LocalAnnouncement)(enrolled))).toEqual(enrolled);
    expect(decodeAnnouncement({ join: true })._tag).toBe("Success");
    // An empty announcement, `join: false` or an empty runner id leaves the
    // controller unable to place the child, so none of them decodes.
    expect(decodeAnnouncement({})._tag).toBe("Failure");
    expect(decodeAnnouncement({ join: false })._tag).toBe("Failure");
    expect(decodeAnnouncement({ runnerId: "" })._tag).toBe("Failure");
  });

  it("returns where to join and the token to join with, both required", () => {
    const enrolment = { controllerUrl: "http://127.0.0.1:4937", token: "a-join-token" };
    expect(decodeEnrolment(enrolment)._tag).toBe("Success");
    expect(Effect.runSync(Schema.encodeEffect(LocalEnrolment)(enrolment))).toEqual(enrolment);
    for (const key of Object.keys(enrolment)) {
      expect(decodeEnrolment(omitKey(enrolment, key))._tag, key).toBe("Failure");
    }
    expect(decodeEnrolment({ ...enrolment, token: "" })._tag).toBe("Failure");
  });
});
