/**
 * Tests the runner's end of the socket, mainly which controller it accepts.
 *
 * A runner pins a logical identity, not an address. So these tests check what
 * it does when the peer is not the controller named in its `runner.json`. The
 * controller is a real WebSocket server started by the test, because that is
 * the only way to make it send what a real controller never would: a hello
 * with another identity, another key, or an invalid signature.
 *
 * This package must not import controller code, so the stub is `Bun.serve`
 * with an Ed25519 key pair generated here.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Duration, Effect, Schema } from "effect";
import {
  PROTOCOL_VERSION,
  RunnerToController,
  encodeChallengeBytes,
  type ControllerHello,
  type RunnerFacts,
  type ProbeReport,
  type ProbeRequest,
  type RunnerFactsReport,
  type RunnerFactsRequest,
  type RunnerHello,
  type RunnerToController as RunnerMessage,
} from "@hercule/protocol";
import {
  ControllerNotRecognised,
  connect,
  ProtocolMismatch,
  PROOF_DEADLINE,
  type ControllerPin,
} from "./socket";
import { makeCredentialRelay } from "./credentials";
import { makeWorkspaceSteps, type WorkspaceSteps } from "./workspace-actions";
import { makeWorkspaces } from "./workspaces";

/** This machine's facts. These tests are not about the probe. */
const FACTS: RunnerFacts = {
  os: "darwin",
  arch: "arm64",
  totalMemoryBytes: 68719476736,
  docker: false,
  toolchains: [{ name: "git", version: "2.50.1", path: "/usr/bin/git" }],
  providers: [{ name: "claude", present: true, path: "/usr/local/bin/claude" }],
  adapters: ["claude-code"],
  identityPort: 4939,
};

/** This runner's id, and the id of another runner. */
const RUNNER_ID = "01999999-0000-7000-8000-00000000000a";
const ANOTHER_RUNNER_ID = "01999999-0000-7000-8000-00000000000b";

const encodeBase64 = (value: Uint8Array): string => Buffer.from(value).toString("base64");

/** Decodes standard base64 into a buffer WebCrypto accepts. */
const decodeBase64 = (encoded: string): Uint8Array<ArrayBuffer> => {
  const decoded = Buffer.from(encoded, "base64");
  const out = new Uint8Array(decoded.byteLength);
  out.set(decoded);
  return out;
};

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * How long a wait on the stub controller may take. It is wall-clock time, not
 * a number of attempts: each attempt takes longer when the machine is busy, so
 * counting attempts would make the wait shortest exactly when the rest of the
 * suite runs at the same time.
 */
const WAIT_DEADLINE_MS = 10_000;

/**
 * Vitest's timeout, derived from the waits instead of its default five
 * seconds. If a test's waits could outlast the timeout, vitest would kill the
 * test first, and the failure would name the test instead of the frame that
 * never arrived. The factor is three because the longest test waits for the
 * connection, then the proof, then the response. The extra ten seconds are for
 * the test that also waits out a proof deadline.
 */
vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 3 + 10_000 });

/** Polls `ready` until it returns true or the wait deadline passes. Returns its last value. */
const waitFor = async (ready: () => boolean): Promise<boolean> => {
  const deadline = Date.now() + WAIT_DEADLINE_MS;
  while (!ready() && Date.now() < deadline) await delay(5);
  return ready();
};

const waitUntil = async (ready: () => boolean): Promise<void> => {
  expect(await waitFor(ready), "the stub controller never reached the expected state").toBe(true);
};

/**
 * Waits until the runner has accepted this stub as its controller.
 *
 * The watermark report shows this, because the runner only sends it to a
 * peer that has proved its identity. The runner's own hello does not: the stub
 * records that frame before it has even signed its hello. A test that sends a
 * request as soon as it sees the runner's hello could send it before the
 * stub's hello, and the runner ignores every request from an unproven peer.
 */
const waitUntilProven = (stub: Stub): Promise<void> =>
  waitUntil(() => stub.received.some((frame) => frame._tag === "watermarkReport"));

const decodeRunnerFrame = (raw: unknown): RunnerMessage =>
  Effect.runSync(Schema.decodeUnknownEffect(RunnerToController)(raw));

/** Creates an Ed25519 identity, like the controller's. */
const createIdentity = async (): Promise<{
  readonly id: string;
  readonly publicKey: string;
  readonly sign: (payload: Uint8Array<ArrayBuffer>) => Promise<string>;
}> => {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as unknown as CryptoKeyPair;
  const publicKey = encodeBase64(
    new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey)),
  );
  return {
    id: crypto.randomUUID(),
    publicKey,
    sign: async (payload) =>
      encodeBase64(
        new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, payload)),
      ),
  };
};

/** Builds the stub's hello from the correct one. Tests use it to send a wrong hello. */
type Tamper = (real: ControllerHello, hello: RunnerHello) => object;

interface Stub {
  readonly url: string;
  readonly identityId: string;
  readonly publicKey: string;
  /** Every frame the runner sent, in order. */
  readonly received: ReadonlyArray<RunnerMessage>;
  /** Resolves once a runner has connected. */
  readonly connected: () => Promise<void>;
  /** Resolves once the connection has ended, however it ended. */
  readonly ended: () => Promise<boolean>;
  /** Closes the connection from the controller's side, with a code and a reason when one is given. */
  readonly hangUp: (code?: number, reason?: string) => void;
  /** Sends the runner any frame the test chooses. */
  readonly say: (frame: object) => void;
  readonly stop: () => void;
}

const running: Array<Stub> = [];

afterEach(() => {
  for (const stub of running.splice(0)) stub.stop();
});

/** Starts a stub controller that accepts any WebSocket upgrade and responds to the runner's hello with its own. */
const stubController = async (
  tamper: Tamper = (real) => real,
  answers: {
    readonly greet?: boolean;
    readonly ping?: boolean;
    /** Builds the bytes the stub signs, for tests that need a signature over the wrong bytes. */
    readonly signs?: (nonce: string) => Uint8Array<ArrayBuffer>;
  } = {},
): Promise<Stub> => {
  const controller = await createIdentity();
  const received: Array<RunnerMessage> = [];
  let open = false;
  let over = false;
  let live:
    | { close: (code?: number, reason?: string) => void; send: (data: string) => unknown }
    | undefined;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      if (server.upgrade(request)) return undefined;
      return new Response("not a websocket request", { status: 400 });
    },
    websocket: {
      open(socket) {
        open = true;
        live = socket;
      },
      close() {
        over = true;
      },
      async message(socket, raw) {
        const frame = decodeRunnerFrame(JSON.parse(String(raw)) as unknown);
        received.push(frame);
        if (frame._tag !== "runnerHello") return;
        if (answers.ping === true) socket.send(JSON.stringify({ _tag: "ping" }));
        if (answers.greet === false) return;
        const real: ControllerHello = {
          _tag: "controllerHello",
          protocolVersion: PROTOCOL_VERSION,
          capabilities: [],
          identityId: controller.id,
          publicKey: controller.publicKey,
          nonce: frame.nonce,
          signature: await controller.sign(
            (answers.signs ?? ((nonce) => encodeChallengeBytes(RUNNER_ID, nonce)))(frame.nonce),
          ),
        };
        socket.send(JSON.stringify(tamper(real, frame)));
      },
    },
  });

  const stub: Stub = {
    url: `http://127.0.0.1:${String(server.port)}`,
    identityId: controller.id,
    publicKey: controller.publicKey,
    received,
    connected: async () => {
      expect(await waitFor(() => open), "the runner never connected").toBe(true);
    },
    ended: () => waitFor(() => over),
    // Never call `close(undefined, undefined)`: a close with no code is a
    // different frame from one with an explicit code and reason, and most
    // tests want the plain one.
    hangUp: (code, reason) => (code === undefined ? live?.close() : live?.close(code, reason)),
    say: (frame) => live?.send(JSON.stringify(frame)),
    stop: () => {
      void server.stop(true);
    },
  };
  running.push(stub);
  return stub;
};

/** Builds the controller pin `runner.json` would hold for this stub. */
const buildPin = (stub: Stub, overrides: Partial<ControllerPin> = {}): ControllerPin => ({
  runnerId: RUNNER_ID,
  controllerUrl: stub.url,
  credential: "the-credential-the-join-handed-back",
  controllerIdentityId: stub.identityId,
  controllerPublicKey: stub.publicKey,
  ...overrides,
});

/**
 * The proof deadline for the two tests that are about the deadline. A separate
 * test checks the real ten-second default; waiting it out four times would take
 * most of the suite's running time.
 */
const DEADLINE = Duration.millis(500);

/**
 * The proof deadline for every other test: long enough that it cannot fire.
 * When the whole suite runs at once, the event loop can stall for most of a
 * second, and a delayed proof looks to the runner like a controller that never
 * responded. In a test about probes or retirement, that would be a flaky
 * failure. Only a test about the deadline should use a short one.
 */
const PATIENT = Duration.minutes(1);

/** No test here starts a session, so none of these directories is ever created. */
const PROVIDERS_DIR = "/nonexistent/hercule-runner-providers";
const SCRATCH_DIR = "/nonexistent/hercule-runner-scratch";
const STORAGE_DIR = "/nonexistent/hercule-runner-storage";
const BIN_DIR = "/nonexistent/hercule-runner-bin";
const HERCULE_TOOL = {
  skill: "# hercule",
  claudePluginDir: "/nonexistent/hercule-runner-claude-plugin",
};

const workspaces = makeWorkspaces({ storageDir: STORAGE_DIR });

/** The workspace steps of a runner that holds none. */
const IDLE_STEPS = makeWorkspaceSteps({
  storageDir: STORAGE_DIR,
  workspaces,
  socketPath: `${STORAGE_DIR}/daemon.sock`,
  baseEnv: {},
});

/** Runs one connection until it ends, and returns how it ended. */
const runConnection = (
  pin: ControllerPin,
  probe: Effect.Effect<RunnerFacts> = Effect.succeed(FACTS),
  proofDeadline: Duration.Duration = PATIENT,
  workspaceSteps: WorkspaceSteps = IDLE_STEPS,
) =>
  Effect.runPromise(
    Effect.result(
      connect({
        pin,
        facts: FACTS,
        probe,
        headroom: Effect.succeed({ diskFreeBytes: 200 * 1024 ** 3, availableMemoryBytes: 1 }),
        providersDir: PROVIDERS_DIR,
        scratchDir: SCRATCH_DIR,
        workspaces,
        workspaceSteps,
        socketPath: `${STORAGE_DIR}/daemon.sock`,
        credentials: makeCredentialRelay(),
        binDir: BIN_DIR,
        herculeTool: HERCULE_TOOL,
        proofDeadline,
      }),
    ),
  );

/** Returns the error a finished connection failed with, or undefined when it succeeded. */
const readFailure = (outcome: Awaited<ReturnType<typeof runConnection>> | undefined): unknown =>
  outcome !== undefined && outcome._tag === "Failure" ? outcome.failure : undefined;

describe("which controller a runner accepts", () => {
  it("closes the connection on a hello with another controller's identity, and sends nothing more", async () => {
    const other = await createIdentity();
    const stub = await stubController((real) => ({ ...real, identityId: other.id }));

    const outcome = await runConnection(buildPin(stub));

    expect(readFailure(outcome)).toBeInstanceOf(ControllerNotRecognised);
    // One frame and no more: the runner sent its hello and then nothing else.
    expect(stub.received.map((frame) => frame._tag)).toEqual(["runnerHello"]);
    expect(await stub.ended()).toBe(true);
  });

  it("closes the connection on a hello with another controller's key, and sends nothing more", async () => {
    const other = await createIdentity();
    // The identity id is the expected one, so the runner rejects the key: a
    // known id is not enough to trust whatever key comes with it.
    const stub = await stubController((real) => ({ ...real, publicKey: other.publicKey }));

    const outcome = await runConnection(buildPin(stub));

    expect(readFailure(outcome)).toBeInstanceOf(ControllerNotRecognised);
    expect(stub.received.map((frame) => frame._tag)).toEqual(["runnerHello"]);
    expect(await stub.ended()).toBe(true);
  });

  it("closes the connection on a signature that is not over its nonce, and sends nothing more", async () => {
    const stub = await stubController((real) => ({
      ...real,
      signature: encodeBase64(crypto.getRandomValues(new Uint8Array(64))),
    }));

    const outcome = await runConnection(buildPin(stub));

    expect(readFailure(outcome)).toBeInstanceOf(ControllerNotRecognised);
    expect(stub.received.map((frame) => frame._tag)).toEqual(["runnerHello"]);
    expect(await stub.ended()).toBe(true);
  });

  it("closes the connection on a signature made for another runner, and sends nothing more", async () => {
    // A relay attack. A peer with its own runner credential can get the
    // controller to sign any nonce it likes. So a signature that includes
    // another runner's id, or no runner id at all, proves nothing here.
    for (const signs of [
      (nonce: string) => decodeBase64(nonce),
      (nonce: string) => encodeChallengeBytes(ANOTHER_RUNNER_ID, nonce),
    ]) {
      const stub = await stubController(undefined, { signs });

      const outcome = await runConnection(buildPin(stub));

      expect(readFailure(outcome)).toBeInstanceOf(ControllerNotRecognised);
      expect(stub.received.map((frame) => frame._tag)).toEqual(["runnerHello"]);
      expect(await stub.ended()).toBe(true);
    }
  });

  it("closes the connection when its own pinned key is invalid, instead of trusting the hello", async () => {
    // A `runner.json` somebody edited, or a truncated write. The peer sends
    // the same invalid key back, so the id and the key both match, and only
    // the signature check is left. That check cannot even run, and a check
    // that cannot run must not count as passed.
    const NOT_A_KEY = "AAAA";
    const stub = await stubController((real) => ({ ...real, publicKey: NOT_A_KEY }));

    const outcome = await runConnection(buildPin(stub, { controllerPublicKey: NOT_A_KEY }));

    expect(readFailure(outcome)).toBeInstanceOf(ControllerNotRecognised);
    expect(await stub.ended()).toBe(true);
  });

  it("gives up on a peer that accepts the socket but never proves its identity", async () => {
    // A peer that never sends a hello, and pings to look alive. One of the two
    // tests with the short deadline, because this test is about the deadline
    // firing.
    const stub = await stubController(undefined, { greet: false, ping: true });

    const outcome = await runConnection(buildPin(stub), Effect.succeed(FACTS), DEADLINE);

    expect(readFailure(outcome)).toBeInstanceOf(ControllerNotRecognised);
    // The runner sent nothing but its own hello while it waited: a peer that
    // has not proved its identity learns nothing about whether it is alive.
    expect(stub.received.map((frame) => frame._tag)).toEqual(["runnerHello"]);
  });

  it("gives an unproven peer ten seconds", () => {
    expect(Duration.toMillis(PROOF_DEADLINE)).toBe(10_000);
  });

  it("reports a protocol version mismatch instead of treating a newer controller as an impostor", async () => {
    const stub = await stubController((real) => ({
      ...real,
      protocolVersion: PROTOCOL_VERSION + 1,
      somethingLater: true,
    }));

    const outcome = await runConnection(buildPin(stub));

    const failure = readFailure(outcome);
    expect(failure).toBeInstanceOf(ProtocolMismatch);
    expect((failure as ProtocolMismatch).message).toContain(String(PROTOCOL_VERSION + 1));
    expect(stub.received.map((frame) => frame._tag)).toEqual(["runnerHello"]);
  });

  it("ignores a second hello, so a proof cannot be undone", async () => {
    const other = await createIdentity();
    const stub = await stubController();

    let settled: Awaited<ReturnType<typeof runConnection>> | undefined;
    const pending = runConnection(buildPin(stub)).then((outcome) => {
      settled = outcome;
    });

    await stub.connected();
    // The watermark is only sent to a peer that has proved its identity, so it
    // shows the runner accepted the real hello.
    await waitUntilProven(stub);
    // A hello claiming another identity, after the real one was accepted. It
    // must not make the runner reject the controller that already proved itself.
    stub.say({
      _tag: "controllerHello",
      protocolVersion: PROTOCOL_VERSION,
      capabilities: [],
      identityId: other.id,
      publicKey: other.publicKey,
      nonce: "AAAA",
      signature: "AAAA",
    });
    // The runner handles frames one at a time, in arrival order, and a runner
    // that had rejected its controller would respond to nothing. So a pong to
    // a ping sent after that hello proves the runner kept the connection.
    // Waiting for the pong is better than waiting a fixed time, which can only
    // show that the runner has not stopped yet.
    stub.say({ _tag: "ping" });
    await waitUntil(() => stub.received.some((frame) => frame._tag === "pong"));

    expect(settled, "the runner closed the connection on a second hello").toBeUndefined();
    stub.hangUp();
    await pending;
    expect(readFailure(settled)).not.toBeInstanceOf(ControllerNotRecognised);
  });

  it("sends the watermark as soon as the controller has proved its identity", async () => {
    const stub = await stubController();

    let settled: Awaited<ReturnType<typeof runConnection>> | undefined;
    const pending = runConnection(buildPin(stub)).then((outcome) => {
      settled = outcome;
    });

    await stub.connected();
    // At once, not a minute later: the controller cannot place work on a
    // runner whose free disk is unknown. The frame is found by tag, not by
    // position, because the sessions snapshot is sent at the same moment.
    await waitUntilProven(stub);
    expect(stub.received.find((frame) => frame._tag === "watermarkReport")).toEqual({
      _tag: "watermarkReport",
      watermark: {
        diskFreeBytes: 200 * 1024 ** 3,
        availableMemoryBytes: 1,
      },
    });

    stub.hangUp();
    await pending;
    expect(readFailure(settled)).not.toBeInstanceOf(ControllerNotRecognised);
  });

  it("keeps the connection when the hello matches the pin", async () => {
    const stub = await stubController();

    let settled: Awaited<ReturnType<typeof runConnection>> | undefined;
    // The other test with the short deadline: it checks that the deadline
    // does not fire once the proof has arrived.
    const pending = runConnection(buildPin(stub), Effect.succeed(FACTS), DEADLINE).then(
      (outcome) => {
        settled = outcome;
      },
    );

    await stub.connected();
    // Wait from the proof, not from the connect: the frames after the hello
    // are only sent once the peer has proved its identity, so seeing one
    // means the connection is now proven.
    await waitUntilProven(stub);
    // Wait well past the proof deadline, because that deadline must not end
    // a proven connection.
    await delay(Duration.toMillis(DEADLINE) * 4);
    expect(settled, "the runner ended a connection it should have kept").toBeUndefined();
    // The hello lists the workspace actions this build implements, so the
    // controller pins a run that commits only to a runner that can.
    expect(stub.received[0]).toMatchObject({
      _tag: "runnerHello",
      capabilities: expect.arrayContaining(["action:git.commit"]) as unknown,
    });

    stub.hangUp();
    await pending;
    expect(settled).toBeDefined();
    // However the connection ended, it was not because the controller was
    // the wrong one.
    expect(readFailure(settled)).not.toBeInstanceOf(ControllerNotRecognised);
  });
});

describe("a runner with workspace steps in flight", () => {
  it("reports them once the controller has proved its identity", async () => {
    const stub = await stubController();
    const inFlight = { runId: "run-1", stepId: "commit", iteration: 2 };
    // Running a real step is the job of the workspace steps' own tests. This
    // test checks that the connection reports whatever steps are in flight.
    const steps: WorkspaceSteps = { ...IDLE_STEPS, listInFlight: () => [inFlight] };

    const pending = runConnection(buildPin(stub), Effect.succeed(FACTS), PATIENT, steps);

    await stub.connected();
    await waitUntilProven(stub);
    await waitUntil(() => stub.received.some((frame) => frame._tag === "workspaceStepsReport"));
    expect(stub.received.find((frame) => frame._tag === "workspaceStepsReport")).toEqual({
      _tag: "workspaceStepsReport",
      steps: [inFlight],
    });

    stub.hangUp();
    await pending;
  });
});

describe("a runner the controller has retired", () => {
  /** The close code and reason the controller uses when it retires a runner. */
  const POLICY_VIOLATION = 1008;
  const RETIRED = "RETIRED";

  /** The message that tells the operator what to do. */
  const JOIN_AGAIN = "this runner was retired; run `hercule runner join` to join the fleet again";

  it("fails with a message telling the operator to join again, so the daemon can stop", async () => {
    const stub = await stubController();
    let settled: Awaited<ReturnType<typeof runConnection>> | undefined;
    const pending = runConnection(buildPin(stub)).then((outcome) => {
      settled = outcome;
    });

    await stub.connected();
    await waitUntilProven(stub);
    stub.hangUp(POLICY_VIOLATION, RETIRED);
    await pending;

    // The credential is revoked, so this ending must not lead to a reconnect
    // with it.
    const failure = readFailure(settled) as { readonly message?: string } | undefined;
    expect(failure, "a retired runner's connection ended without an error").toBeDefined();
    expect(failure?.message).toContain(JOIN_AGAIN);
  });

  it("treats every other close as a normal end of the connection", async () => {
    // Two cases, because either half can differ: another reason with the
    // retirement code, and another code with the retirement reason. The
    // controller really sends both.
    const closes: ReadonlyArray<readonly [number, string]> = [
      [POLICY_VIOLATION, "this runner opened another connection"],
      [1001, RETIRED],
    ];
    for (const [code, reason] of closes) {
      const stub = await stubController();
      let settled: Awaited<ReturnType<typeof runConnection>> | undefined;
      const pending = runConnection(buildPin(stub)).then((outcome) => {
        settled = outcome;
      });
      await stub.connected();
      await waitUntilProven(stub);
      stub.hangUp(code, reason);
      await pending;

      const failure = readFailure(settled) as { readonly message?: string } | undefined;
      expect(failure?.message ?? "", `${String(code)} ${reason}`).not.toContain(JOIN_AGAIN);
    }
  });
});

describe("a controller requesting the machine's facts", () => {
  /**
   * The frame the controller sends. It is typed with the protocol's frame
   * type instead of written as a plain object, so renaming the frame breaks
   * compilation here instead of making the runner silently ignore it.
   */
  const REQUEST: RunnerFactsRequest = { _tag: "factsRequest" };

  /** Returns the facts report the runner sent, or undefined before it sends one. */
  const findFactsReport = (stub: Stub): RunnerFactsReport | undefined =>
    stub.received.find((frame): frame is RunnerFactsReport => frame._tag === "factsReport");

  it("reports what the probe finds now, not the facts from the hello", async () => {
    // The machine gained `gh` since it connected, which is why the controller
    // asks again.
    const grown: RunnerFacts = {
      ...FACTS,
      toolchains: [
        ...FACTS.toolchains,
        { name: "gh", version: "2.99.0", path: "/usr/local/bin/gh" },
      ],
    };
    const stub = await stubController();
    let settled: Awaited<ReturnType<typeof runConnection>> | undefined;
    const pending = runConnection(buildPin(stub), Effect.succeed(grown)).then((outcome) => {
      settled = outcome;
    });

    await stub.connected();
    await waitUntilProven(stub);
    stub.say(REQUEST);

    await waitUntil(() => findFactsReport(stub) !== undefined);
    // The hourly report is sent only when something changed, but a response
    // to a request is always sent. Otherwise an operator refreshing a machine
    // where nothing changed would wait for a frame that never comes.
    expect(findFactsReport(stub)).toEqual({ _tag: "factsReport", facts: grown });

    stub.hangUp();
    await pending;
    expect(readFailure(settled)).not.toBeInstanceOf(ControllerNotRecognised);
  });
});

describe("a controller asking a runner to probe a provider it has no adapter for", () => {
  const REQUEST: ProbeRequest = {
    _tag: "probeRequest",
    requestId: "01999999-0000-7000-8000-0000000000c1",
    instanceId: "01999999-0000-7000-8000-0000000000c2",
    providerId: "a-provider-nobody-wrote-an-adapter-for",
    config: {},
    secrets: {},
  };

  const findProbeReport = (stub: Stub): ProbeReport | undefined =>
    stub.received.find((frame): frame is ProbeReport => frame._tag === "probeReport");

  it("reports that this build has no adapter for it, instead of leaving the caller waiting", async () => {
    const stub = await stubController();
    let settled: Awaited<ReturnType<typeof runConnection>> | undefined;
    const pending = runConnection(buildPin(stub)).then((outcome) => {
      settled = outcome;
    });

    await stub.connected();
    await waitUntilProven(stub);
    stub.say(REQUEST);

    await waitUntil(() => findProbeReport(stub) !== undefined);
    const report = findProbeReport(stub);
    // Matched by request id, because probes, logins and installs for several
    // instances can run on one connection at once.
    expect(report?.requestId).toBe(REQUEST.requestId);
    expect(report?.instanceId).toBe(REQUEST.instanceId);
    expect(report?.result.auth.status).toBe("error");
    expect(report?.result.auth.message).toBe(
      "no adapter for a-provider-nobody-wrote-an-adapter-for in this runner build",
    );
    expect(report?.result.harnessVersion).toBeNull();
    expect(report?.result.models).toEqual([]);

    stub.hangUp();
    await pending;
    expect(readFailure(settled)).not.toBeInstanceOf(ControllerNotRecognised);
  });
});
