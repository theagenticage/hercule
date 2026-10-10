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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { Duration, Effect, Logger, PubSub, Schema, Stream } from "effect";
import {
  AGENT_STEPS_CAPABILITY,
  ATTACHMENTS_CAPABILITY,
  LOGIN_ENDED_CAPABILITY,
  PROTOCOL_VERSION,
  RunnerToController,
  encodeChallengeBytes,
  type ControllerHello,
  type ExitReason,
  MAX_WORKSPACE_STEPS,
  type Ping,
  type RunnerFacts,
  type ProbeReport,
  type ProbeRequest,
  type ProviderEvent,
  type RunnerFactsReport,
  type RunnerFactsRequest,
  type RunnerHello,
  type RunnerToController as RunnerMessage,
  type SessionBinding,
  type SessionInput,
  type SessionInputResult,
  type SessionStart,
  type SessionStop,
  type WorkspaceStepResult,
  type WorkspaceStepStart,
} from "@hercule/protocol";
import {
  ControllerNotRecognised,
  connect,
  ProtocolMismatch,
  PROOF_DEADLINE,
  type ConnectOptions,
  type ControllerPin,
} from "./socket";
import { makeCredentialRelay } from "./credentials";
import type { ProviderAdapter } from "./providers";
import { makeLogins, type Logins } from "./providers/login";
import { makeSupervising } from "./sessions/supervisor";
import { makeWorkspaceSteps, type WorkspaceSteps } from "./workspace-steps";
import * as workspaceFixtures from "./workspaces/testing";
import { makeTestWorkspaces } from "./workspaces/testing";
import { makeAttachmentCache } from "./attachments";
import { NO_CONTROLLER_TOOL_IMAGES } from "./providers/testing";

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

/** Only the session tests start a session, and they use directories of their own, so none of these is ever created. */
const PROVIDERS_DIR = "/nonexistent/hercule-runner-providers";
const SCRATCH_DIR = "/nonexistent/hercule-runner-scratch";
const STORAGE_DIR = "/nonexistent/hercule-runner-storage";
const BIN_DIR = "/nonexistent/hercule-runner-bin";
const HERCULE_TOOL = {
  skill: "# hercule",
  claudePluginDir: "/nonexistent/hercule-runner-claude-plugin",
};

const workspaces = makeTestWorkspaces({ storageDir: STORAGE_DIR });

/** The workspace steps of a runner that holds none. */
const IDLE_STEPS = makeWorkspaceSteps({
  storageDir: STORAGE_DIR,
  workspaces,
  socketPath: `${STORAGE_DIR}/daemon.sock`,
  baseEnv: {},
});

/** The provider logins of a runner that starts none. */
const IDLE_LOGINS = makeLogins(() => {
  throw new Error("no test in this file starts a login");
});

/** Every line the connections of the current test logged, formatted as the process log writes them. */
const logged: Array<string> = [];

afterEach(() => {
  logged.length = 0;
});

/** Sends every log line to `logged` instead of the console. */
const collectLogLines = Logger.layer([
  Logger.map(Logger.formatLogFmt, (line) => logged.push(line)),
]);

/**
 * Runs one connection until it ends, and returns how it ended. `overrides`
 * replaces the defaults: a machine whose facts never change, a proof deadline
 * that cannot fire, and no steps, logins or sessions.
 */
const runConnection = (pin: ControllerPin, overrides: Partial<Omit<ConnectOptions, "pin">> = {}) =>
  Effect.runPromise(
    Effect.result(
      connect({
        pin,
        facts: FACTS,
        probe: Effect.succeed(FACTS),
        headroom: Effect.succeed({ diskFreeBytes: 200 * 1024 ** 3, availableMemoryBytes: 1 }),
        providersDir: PROVIDERS_DIR,
        scratchDir: SCRATCH_DIR,
        attachmentsDir: "/nonexistent/hercule-runner-attachments",
        toolImages: NO_CONTROLLER_TOOL_IMAGES,
        attachments: makeAttachmentCache({
          controllerUrl: "https://controller.example:4938",
          credential: "test",
        }),
        workspaces,
        workspaceSteps: IDLE_STEPS,
        socketPath: `${STORAGE_DIR}/daemon.sock`,
        credentials: makeCredentialRelay(),
        providerLogins: IDLE_LOGINS,
        sessions: makeSupervising([]),
        binDir: BIN_DIR,
        herculeTool: HERCULE_TOOL,
        proofDeadline: PATIENT,
        ...overrides,
      }),
    ).pipe(Effect.provide(collectLogLines)),
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
    // An impostor must not show in the log as the controller this runner connected to.
    expect(logged.filter((line) => line.includes("connected to the controller"))).toEqual([]);
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

    const outcome = await runConnection(buildPin(stub), { proofDeadline: DEADLINE });

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
    // Frames pass the runner's frame lock one at a time, in arrival order,
    // and a runner that had rejected its controller would respond to nothing. So a pong to
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

  it("logs one line once the controller has proved its identity, without the credential", async () => {
    const stub = await stubController();
    const pin = buildPin(stub);

    const pending = runConnection(pin);
    await stub.connected();
    await waitUntilProven(stub);
    stub.hangUp();
    await pending;

    const connected = logged.filter((line) => line.includes("connected to the controller"));
    expect(connected).toHaveLength(1);
    expect(connected[0]).toContain("level=INFO");
    expect(connected[0]).toContain(`controllerUrl=${pin.controllerUrl}`);
    expect(connected[0]).toContain(`runnerId=${pin.runnerId}`);
    for (const line of logged) expect(line).not.toContain(pin.credential);
  });

  it("keeps the connection when the hello matches the pin", async () => {
    const stub = await stubController();

    let settled: Awaited<ReturnType<typeof runConnection>> | undefined;
    // The other test with the short deadline: it checks that the deadline
    // does not fire once the proof has arrived.
    const pending = runConnection(buildPin(stub), { proofDeadline: DEADLINE }).then((outcome) => {
      settled = outcome;
    });

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
    // controller pins a run that commits only to a runner that can, the frame
    // that reports the end of a device login, agent steps, and fetching the
    // images of an input, so the controller sends images only to a runner
    // that fetches them.
    expect(stub.received[0]).toMatchObject({
      _tag: "runnerHello",
      capabilities: expect.arrayContaining([
        "action:git.commit",
        LOGIN_ENDED_CAPABILITY,
        AGENT_STEPS_CAPABILITY,
        ATTACHMENTS_CAPABILITY,
      ]) as unknown,
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
  it("reports them once the controller has proved its identity, in frames the protocol accepts", async () => {
    const stub = await stubController();
    // More steps than one frame may hold, so the report is split.
    const inFlight = Array.from({ length: MAX_WORKSPACE_STEPS + 1 }, (_, at) => ({
      runId: `run-${String(at)}`,
      stepId: "commit",
      iteration: 1,
    }));
    // Running a real step is the job of the workspace steps' own tests. This
    // test checks that the connection reports whatever steps are in flight.
    const steps: WorkspaceSteps = { ...IDLE_STEPS, listInFlight: () => inFlight };

    const pending = runConnection(buildPin(stub), { workspaceSteps: steps });

    await stub.connected();
    await waitUntilProven(stub);
    // Every received frame was decoded against the protocol, so a frame
    // over the limit would not have arrived.
    const listReported = () =>
      stub.received.flatMap((frame) => (frame._tag === "workspaceStepsReport" ? frame.steps : []));
    await waitUntil(() => listReported().length === inFlight.length);
    expect(listReported()).toEqual(inFlight);

    stub.hangUp();
    await pending;
  });
});

describe("reporting the end of a device login", () => {
  /** Returns the idle provider logins, counting how often a connection attaches to them. */
  const countAttaches = (): { readonly logins: Logins; readonly attaches: () => number } => {
    let attaches = 0;
    return {
      logins: {
        ...IDLE_LOGINS,
        attachConnection: (report) => {
          attaches += 1;
          return IDLE_LOGINS.attachConnection(report);
        },
      },
      attaches: () => attaches,
    };
  };

  it("reports to a controller whose hello lists the frame", async () => {
    const stub = await stubController((real) => ({
      ...real,
      capabilities: [LOGIN_ENDED_CAPABILITY],
    }));
    const counted = countAttaches();

    const pending = runConnection(buildPin(stub), { providerLogins: counted.logins });

    await stub.connected();
    // The logins are attached while the hello is handled, before the proof
    // lets the first report out.
    await waitUntilProven(stub);
    expect(counted.attaches()).toBe(1);

    stub.hangUp();
    await pending;
  });

  it("reports nothing to a controller whose hello does not list the frame", async () => {
    const stub = await stubController();
    const counted = countAttaches();

    const pending = runConnection(buildPin(stub), { providerLogins: counted.logins });

    await stub.connected();
    await waitUntilProven(stub);
    // An older controller closes the connection on a frame it cannot read.
    expect(counted.attaches()).toBe(0);

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
    const pending = runConnection(buildPin(stub), { probe: Effect.succeed(grown) }).then(
      (outcome) => {
        settled = outcome;
      },
    );

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

/**
 * Tests how the connection orders session frames. A session's frames run one
 * at a time, in arrival order, and every other frame goes on beside them. The
 * adapter is a fake whose steps the test can hold open, so a frame can arrive
 * while a start is held at a chosen point.
 */
describe("session frames on one connection", () => {
  const PROVIDER = "fake";
  const SESSION_A = "0199e0e7-0000-7000-8000-0000000000a1";
  const SESSION_B = "0199e0e7-0000-7000-8000-0000000000b1";

  /** A point a step of the fake adapter waits at until the test opens it. */
  interface Gate {
    /** Whether a step has reached the gate. */
    readonly reached: () => boolean;
    readonly open: () => void;
    /** Marks the gate reached, and waits until it is open. */
    readonly pass: Effect.Effect<void>;
  }

  const createGate = (): Gate => {
    let reached = false;
    let open: () => void = () => {};
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    return {
      reached: () => reached,
      open: () => open(),
      pass: Effect.suspend(() => {
        reached = true;
        return Effect.promise(() => opened);
      }),
    };
  };

  /** A fake adapter that records what it is given, with gates the test can hold its steps at. */
  interface Fake {
    readonly adapter: ProviderAdapter;
    /** The text of every input handed to a harness, with its session, in order. */
    readonly inputs: Array<readonly [string, string]>;
    /** Every stop the adapter was asked for, with its reason. */
    readonly stops: Array<readonly [string, ExitReason]>;
    /** The id of the turn each input opened, in order. */
    readonly turns: Array<string>;
    /** The gate each session's `startSession` waits at, if it has one. */
    readonly startGates: Map<string, Gate>;
    /** The gate each session's input waits at before reporting delivery. */
    readonly inputGates: Map<string, Gate>;
    readonly interrupts: Array<string>;
    /** The native turn stopped when each interrupt actually executes. */
    readonly cancelledTurns: Array<string>;
    /** Holds an interrupt before the adapter applies its cancellation. */
    interruptGate: Gate | undefined;
    /** A gate the first `listSessions` call waits at. That call is the start's own check, before the session has an entry. */
    listGate: Gate | undefined;
    /**
     * A gate the harness of the next `stopSession` call waits at before it
     * exits. `stopSession` itself returns at once, as Claude Code's does, so
     * the supervisor learns the harness is gone only from its exit event.
     */
    stopGate: Gate | undefined;
    /** Publishes an event as if the harness had reported it. */
    readonly emit: (event: ProviderEvent) => void;
  }

  const createFake = (): Fake => {
    const held = new Map<string, SessionBinding>();
    const events = Effect.runSync(PubSub.unbounded<ProviderEvent>());
    const fake: Fake = {
      inputs: [],
      turns: [],
      stops: [],
      startGates: new Map(),
      inputGates: new Map(),
      interrupts: [],
      cancelledTurns: [],
      interruptGate: undefined,
      listGate: undefined,
      stopGate: undefined,
      emit: (event) => PubSub.publishUnsafe(events, event),
      adapter: {
        providerId: PROVIDER,
        binaryName: "fake-harness",
        events: Stream.fromPubSub(events),
        probe: () => Effect.die("not probed here"),
        listSessions: Effect.suspend(() => {
          const gate = fake.listGate;
          fake.listGate = undefined;
          return Effect.andThen(
            gate?.pass ?? Effect.void,
            Effect.sync(() => [...held.values()]),
          );
        }),
        startSession: (sessionId) =>
          Effect.andThen(
            fake.startGates.get(sessionId)?.pass ?? Effect.void,
            Effect.sync(() => {
              const binding = { sessionId, nativeSessionId: sessionId, instanceId: INSTANCE };
              held.set(sessionId, binding);
              return binding;
            }),
          ),
        sendInput: (sessionId, input) =>
          Effect.andThen(
            fake.inputGates.get(sessionId)?.pass ?? Effect.void,
            Effect.sync(() => {
              const turnId = crypto.randomUUID();
              fake.inputs.push([sessionId, input.text]);
              fake.turns.push(turnId);
              return { turnId, delivery: "opened" as const };
            }),
          ),
        interrupt: (sessionId) =>
          Effect.andThen(
            fake.interruptGate?.pass ?? Effect.void,
            Effect.sync(() => {
              fake.interrupts.push(sessionId);
              const index = fake.inputs.findLastIndex(([id]) => id === sessionId);
              if (index >= 0) fake.cancelledTurns.push(fake.turns[index]!);
            }),
          ),
        respondToApprovalRequest: () => Effect.void,
        respondToQuestion: () => Effect.void,
        stopSession: (sessionId, reason) =>
          Effect.suspend(() => {
            fake.stops.push([sessionId, reason]);
            const gate = fake.stopGate;
            fake.stopGate = undefined;
            const exit = Effect.andThen(
              gate?.pass ?? Effect.void,
              Effect.sync(() => {
                held.delete(sessionId);
                PubSub.publishUnsafe(events, {
                  _tag: "session.exited",
                  eventId: crypto.randomUUID(),
                  sessionId,
                  at: new Date().toISOString(),
                  reason,
                });
              }),
            );
            return Effect.asVoid(Effect.forkDetach(exit));
          }),
      },
    };
    return fake;
  };

  const INSTANCE = "0199e0e7-0000-7000-8000-00000000000a";

  /** Builds a start. A second start of the same session needs a request id of its own. */
  const buildStart = (
    sessionId: string,
    requestId = `${sessionId.slice(0, -2)}f0`,
  ): SessionStart => ({
    _tag: "sessionStart",
    requestId,
    sessionId,
    input: { text: `start ${sessionId}` },
    providerId: PROVIDER,
    config: {},
    secrets: {},
    spec: {
      instanceId: INSTANCE,
      workspaceId: null,
      modelSelection: { model: "fast", options: {} },
      accessMode: "approval-required",
      timeouts: { inactivityMs: 30 * 60 * 1000, absoluteMs: 8 * 60 * 60 * 1000 },
    },
    token: "a-session-token",
  });

  const buildStop = (sessionId: string): SessionStop => ({ _tag: "sessionStop", sessionId });

  const PING: Ping = { _tag: "ping" };

  const listInputResults = (stub: Stub): ReadonlyArray<SessionInputResult> =>
    stub.received.filter(
      (frame): frame is SessionInputResult => frame._tag === "sessionInputResult",
    );

  const listStepResults = (stub: Stub): ReadonlyArray<WorkspaceStepResult> =>
    stub.received.filter(
      (frame): frame is WorkspaceStepResult => frame._tag === "workspaceStepResult",
    );

  const STEP = { runId: "0199e0e7-0000-7000-8000-0000000000d1", stepId: "review", iteration: 1 };

  /** The input that carries the agent step's prompt to session A. */
  const STEP_INPUT: SessionInput = {
    _tag: "sessionInput",
    requestId: "0199e0e7-0000-7000-8000-0000000000c2",
    sessionId: SESSION_A,
    input: { text: "Review the change.", step: STEP },
  };

  /** The controller's request for the agent step's result. */
  const STEP_RESULT_REQUEST: WorkspaceStepStart = {
    _tag: "workspaceStepStart",
    kind: "agent",
    ...STEP,
    sessionId: SESSION_A,
    workspaceId: null,
  };

  /** Ends a turn of session A the way the harness reports it. */
  const completeTurn = (fake: Fake, turnId: string): void =>
    fake.emit({
      _tag: "turn.completed",
      eventId: crypto.randomUUID(),
      sessionId: SESSION_A,
      at: new Date().toISOString(),
      turnId,
      state: "completed",
    });

  /**
   * Sends a start of session A whose harness is held at `gate`, then the
   * step's input, which waits in the session's lane behind the start. The
   * step is not recorded until the start lets the input through.
   */
  const sendWaitingStepInput = async (stub: Stub, fake: Fake, gate: Gate): Promise<void> => {
    fake.startGates.set(SESSION_A, gate);
    stub.say(buildStart(SESSION_A));
    await waitUntil(gate.reached);
    stub.say(STEP_INPUT);
  };

  const countPongs = (stub: Stub): number =>
    stub.received.filter((frame) => frame._tag === "pong").length;

  /**
   * Sends a ping and waits for its pong. The frame loop handles frames in
   * arrival order, so the pong shows that every frame sent before the ping
   * has been taken in.
   */
  const pingAndWaitForPong = async (stub: Stub): Promise<void> => {
    const before = countPongs(stub);
    stub.say(PING);
    await waitUntil(() => countPongs(stub) > before);
  };

  /**
   * Connects a runner whose sessions run on `fake`, with directories and
   * workspace steps of its own, and waits for the proof.
   */
  const connectWithSessions = async (
    fake: Fake,
  ): Promise<{ readonly stub: Stub; readonly pending: Promise<unknown> }> => {
    const root = mkdtempSync(joinPath(tmpdir(), "hercule-socket-sessions-"));
    roots.push(root);
    const stub = await stubController();
    const storageDir = joinPath(root, "storage");
    const pending = runConnection(buildPin(stub), {
      providersDir: joinPath(root, "providers"),
      scratchDir: joinPath(root, "scratch"),
      attachmentsDir: joinPath(root, "attachments"),
      sessions: makeSupervising([fake.adapter]),
      workspaceSteps: makeWorkspaceSteps({
        storageDir,
        workspaces,
        socketPath: joinPath(storageDir, "daemon.sock"),
        baseEnv: {},
      }),
    });
    await stub.connected();
    await waitUntilProven(stub);
    return { stub, pending };
  };

  const roots: Array<string> = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("answers a ping while a start waits on its harness", async () => {
    const fake = createFake();
    const gate = createGate();
    fake.startGates.set(SESSION_A, gate);
    const { stub, pending } = await connectWithSessions(fake);

    stub.say(buildStart(SESSION_A));
    await waitUntil(gate.reached);
    // The controller drops a runner that does not answer pings for a minute,
    // and a slow harness can hold a start that long.
    await pingAndWaitForPong(stub);

    gate.open();
    await waitUntil(() => listInputResults(stub).length === 1);
    stub.hangUp();
    await pending;
  });

  it("delivers Stop after binding while the first input still waits on the harness", async () => {
    const fake = createFake();
    const starting = createGate();
    const input = createGate();
    fake.startGates.set(SESSION_A, starting);
    fake.inputGates.set(SESSION_A, input);
    const { stub, pending } = await connectWithSessions(fake);
    try {
      stub.say(buildStart(SESSION_A));
      await waitUntil(starting.reached);
      starting.open();
      await waitUntil(input.reached);
      stub.say({ _tag: "sessionInterrupt", sessionId: SESSION_A });
      await waitUntil(() => fake.interrupts.length === 1);
      expect(listInputResults(stub)).toEqual([]);
      expect(fake.interrupts).toEqual([SESSION_A]);
      input.open();
      await waitUntil(() => listInputResults(stub).length === 1);
    } finally {
      starting.open();
      input.open();
      stub.hangUp();
      await pending;
    }
  });

  it("waits for an earlier Stop to reach the adapter before delivering post-Stop input", async () => {
    const fake = createFake();
    const input = createGate();
    const interrupt = createGate();
    fake.inputGates.set(SESSION_A, input);
    fake.interruptGate = interrupt;
    const { stub, pending } = await connectWithSessions(fake);
    try {
      stub.say(buildStart(SESSION_A));
      await waitUntil(input.reached);
      stub.say({ _tag: "sessionInterrupt", sessionId: SESSION_A });
      stub.say({
        _tag: "sessionInput",
        requestId: "0199e0e7-0000-7000-8000-0000000000c2",
        sessionId: SESSION_A,
        input: { text: "new work after Stop" },
      });
      await waitUntil(interrupt.reached);
      input.open();
      await waitUntil(() => listInputResults(stub).length >= 1);
      await pingAndWaitForPong(stub);
      interrupt.open();
      await waitUntil(() => listInputResults(stub).length === 2);
      expect(fake.inputs).toEqual([
        [SESSION_A, `start ${SESSION_A}`],
        [SESSION_A, "new work after Stop"],
      ]);
      expect(fake.cancelledTurns).toEqual([fake.turns[0]]);
    } finally {
      input.open();
      interrupt.open();
      stub.hangUp();
      await pending;
    }
  });

  it.each(["context", "harness"])(
    "keeps Stop through %s startup, cancels earlier step input and accepts a later input",
    async (phase) => {
      const fake = createFake();
      const starting = createGate();
      if (phase === "harness") fake.startGates.set(SESSION_A, starting);
      const { stub, pending } = await connectWithSessions(fake);
      if (phase === "context") fake.listGate = starting;
      const oldInput: SessionInput = {
        _tag: "sessionInput",
        requestId: "0199e0e7-0000-7000-8000-0000000000c1",
        sessionId: SESSION_A,
        input: { text: "old queued work", step: STEP },
      };
      const newInput: SessionInput = {
        ...oldInput,
        requestId: "0199e0e7-0000-7000-8000-0000000000c2",
        input: { text: "new explicit work" },
      };
      try {
        stub.say(buildStart(SESSION_A));
        await waitUntil(starting.reached);
        stub.say(oldInput);
        stub.say({ _tag: "sessionInterrupt", sessionId: SESSION_A });
        stub.say(newInput);
        await pingAndWaitForPong(stub);
        expect(fake.interrupts).toEqual([]);
        starting.open();
        await waitUntil(() => listInputResults(stub).length === 3);
        expect(listInputResults(stub).map((result) => result.ok)).toEqual([false, false, true]);
        expect(fake.inputs).toEqual([[SESSION_A, "new explicit work"]]);
        expect(fake.interrupts).toEqual([SESSION_A]);
        stub.say(STEP_RESULT_REQUEST);
        await waitUntil(() => listStepResults(stub).length === 1);
        expect(listStepResults(stub)[0]!.outcome).toMatchObject({
          status: "failed",
          code: "interrupted",
        });
      } finally {
        starting.open();
        stub.hangUp();
        await pending;
      }
    },
  );

  it("starts two sessions at the same time", async () => {
    const fake = createFake();
    const gates = [createGate(), createGate()] as const;
    fake.startGates.set(SESSION_A, gates[0]);
    fake.startGates.set(SESSION_B, gates[1]);
    const { stub, pending } = await connectWithSessions(fake);

    stub.say(buildStart(SESSION_A));
    stub.say(buildStart(SESSION_B));
    // Both harnesses are asked for while neither has started.
    await waitUntil(() => gates[0].reached() && gates[1].reached());

    for (const gate of gates) gate.open();
    await waitUntil(() => listInputResults(stub).length === 2);
    expect(listInputResults(stub).every((result) => result.ok)).toBe(true);
    stub.hangUp();
    await pending;
  });

  it("holds input for a session until its start has handed over the start's input", async () => {
    const fake = createFake();
    const gate = createGate();
    fake.startGates.set(SESSION_A, gate);
    const { stub, pending } = await connectWithSessions(fake);
    const input: SessionInput = {
      _tag: "sessionInput",
      requestId: "0199e0e7-0000-7000-8000-0000000000c1",
      sessionId: SESSION_A,
      input: { text: "and then this" },
    };

    stub.say(buildStart(SESSION_A));
    await waitUntil(gate.reached);
    stub.say(input);
    await pingAndWaitForPong(stub);
    // The input has arrived, and waits behind the start: handled now, it would
    // be refused, because the session is not running yet.
    expect(fake.inputs).toEqual([]);
    expect(listInputResults(stub)).toEqual([]);

    gate.open();
    await waitUntil(() => listInputResults(stub).length === 2);
    expect(fake.inputs).toEqual([
      [SESSION_A, `start ${SESSION_A}`],
      [SESSION_A, "and then this"],
    ]);
    expect(listInputResults(stub).map((result) => [result.requestId, result.ok])).toEqual([
      [buildStart(SESSION_A).requestId, true],
      [input.requestId, true],
    ]);
    stub.hangUp();
    await pending;
  });

  /**
   * The two points of a start a stop can arrive at:
   *
   * - before the session has an entry, while the start checks the adapter.
   *   No harness is spawned, and the start reports the exit itself.
   * - after, while the harness starts. The harness is stopped once it is up,
   *   and the adapter reports the exit.
   */
  const STOP_POINTS: ReadonlyArray<{
    readonly point: string;
    readonly holdStart: (fake: Fake, gate: Gate) => void;
    readonly spawned: boolean;
  }> = [
    {
      point: "while the start checks the adapter, before the session has an entry",
      holdStart: (fake, gate) => {
        fake.listGate = gate;
      },
      spawned: false,
    },
    {
      point: "while the harness starts",
      holdStart: (fake, gate) => {
        fake.startGates.set(SESSION_A, gate);
      },
      spawned: true,
    },
  ];

  for (const { point, holdStart, spawned } of STOP_POINTS) {
    it(`refuses the start's input and ends the session as stopped when a stop arrives ${point}`, async () => {
      const fake = createFake();
      const gate = createGate();
      const { stub, pending } = await connectWithSessions(fake);
      // Held only once connected: the connection asks the adapter for its
      // sessions when it reports them to the controller.
      holdStart(fake, gate);

      stub.say(buildStart(SESSION_A));
      await waitUntil(gate.reached);
      stub.say(buildStop(SESSION_A));
      // The pong shows the stop has been taken in before the start goes on.
      await pingAndWaitForPong(stub);
      gate.open();

      await waitUntil(() => listInputResults(stub).length === 1);
      expect(listInputResults(stub)[0]).toMatchObject({
        requestId: buildStart(SESSION_A).requestId,
        ok: false,
      });
      expect(listInputResults(stub)[0]?.message).toContain(
        "was stopped before its input was handed over",
      );
      expect(fake.inputs).toEqual([]);
      expect(fake.stops).toEqual(spawned ? [[SESSION_A, "stopped"]] : []);
      await waitUntil(() =>
        stub.received.some(
          (frame) =>
            frame._tag === "sessionEvent" &&
            frame.event._tag === "session.exited" &&
            frame.event.reason === "stopped",
        ),
      );
      stub.hangUp();
      await pending;
    });
  }

  it("keeps the order of frames that arrive in one burst", async () => {
    const fake = createFake();
    const { stub, pending } = await connectWithSessions(fake);
    // Sessions whose ids differ before the last two digits, so each start
    // gets a request id of its own.
    const sessions = Array.from(
      { length: 20 },
      (_, at) => `0199e0e7-0000-7000-8000-000000${at.toString(16).padStart(2, "0")}0001`,
    );
    const buildInput = (sessionId: string): SessionInput => ({
      _tag: "sessionInput",
      requestId: `${sessionId.slice(0, -2)}c1`,
      sessionId,
      input: { text: "and then this" },
    });

    // Sent with nothing awaited in between, so the frames reach the runner
    // back to back. Each input must join its session's lane after the start,
    // or it would be refused because the session is not running yet.
    for (const sessionId of sessions) {
      stub.say(buildStart(sessionId));
      stub.say(buildInput(sessionId));
    }

    await waitUntil(() => listInputResults(stub).length === sessions.length * 2);
    expect(listInputResults(stub).filter((result) => !result.ok)).toEqual([]);
    for (const sessionId of sessions) {
      expect(fake.inputs.filter(([id]) => id === sessionId)).toEqual([
        [sessionId, `start ${sessionId}`],
        [sessionId, "and then this"],
      ]);
    }
    stub.hangUp();
    await pending;
  });

  it("starts a session sent right after a stop of the same id once the old harness is gone", async () => {
    const fake = createFake();
    const { stub, pending } = await connectWithSessions(fake);
    stub.say(buildStart(SESSION_A));
    await waitUntil(() => listInputResults(stub).length === 1);
    const stopping = createGate();
    fake.stopGate = stopping;
    const again = buildStart(SESSION_A, "0199e0e7-0000-7000-8000-0000000000f2");

    stub.say(buildStop(SESSION_A));
    await waitUntil(stopping.reached);
    stub.say(again);
    await pingAndWaitForPong(stub);
    // The adapter still lists the old harness while it stops it, so the new
    // start waits for the old harness to be gone instead of being refused as
    // a duplicate of a running session.
    expect(listInputResults(stub)).toHaveLength(1);

    stopping.open();
    await waitUntil(() => listInputResults(stub).length === 2);
    expect(listInputResults(stub)[1]).toMatchObject({ requestId: again.requestId, ok: true });
    expect(fake.inputs).toEqual([
      [SESSION_A, `start ${SESSION_A}`],
      [SESSION_A, `start ${SESSION_A}`],
    ]);
    expect(fake.stops).toEqual([[SESSION_A, "stopped"]]);
    stub.hangUp();
    await pending;
  });

  it("refuses the input of a start that waits behind an earlier frame when a stop arrives", async () => {
    const fake = createFake();
    const { stub, pending } = await connectWithSessions(fake);
    stub.say(buildStart(SESSION_A));
    await waitUntil(() => listInputResults(stub).length === 1);
    const stopping = createGate();
    fake.stopGate = stopping;
    const again = buildStart(SESSION_A, "0199e0e7-0000-7000-8000-0000000000f2");

    // The second start waits for the old harness, which the adapter holds
    // open while it stops it. The second stop reaches the second start while
    // that start is still waiting.
    stub.say(buildStop(SESSION_A));
    await waitUntil(stopping.reached);
    stub.say(again);
    stub.say(buildStop(SESSION_A));
    await pingAndWaitForPong(stub);
    stopping.open();

    await waitUntil(() => listInputResults(stub).length === 2);
    expect(listInputResults(stub)[1]).toMatchObject({ requestId: again.requestId, ok: false });
    expect(listInputResults(stub)[1]?.message).toContain(
      "was stopped before its input was handed over",
    );
    expect(fake.inputs).toEqual([[SESSION_A, `start ${SESSION_A}`]]);
    // The second stop reached the old harness too. The second start spawned
    // no harness, so nothing else was stopped.
    expect(fake.stops.at(-1)).toEqual([SESSION_A, "stopped"]);
    stub.hangUp();
    await pending;
  });

  it("does not stop a later start of the same id because of an earlier stop", async () => {
    const fake = createFake();
    const gate = createGate();
    fake.startGates.set(SESSION_A, gate);
    const { stub, pending } = await connectWithSessions(fake);
    const again = buildStart(SESSION_A, "0199e0e7-0000-7000-8000-0000000000f2");

    // The stop reaches the first start while its harness starts. The second
    // start arrives after the stop, so the stop is not meant for it.
    stub.say(buildStart(SESSION_A));
    await waitUntil(gate.reached);
    stub.say(buildStop(SESSION_A));
    stub.say(again);
    await pingAndWaitForPong(stub);
    gate.open();

    await waitUntil(() => listInputResults(stub).length === 2);
    expect(listInputResults(stub).map((result) => [result.requestId, result.ok])).toEqual([
      [buildStart(SESSION_A).requestId, false],
      [again.requestId, true],
    ]);
    expect(fake.inputs).toEqual([[SESSION_A, `start ${SESSION_A}`]]);
    expect(fake.stops).toEqual([[SESSION_A, "stopped"]]);
    stub.hangUp();
    await pending;
  });

  it("answers a request for an agent step's result only after the step's input, which waits behind the session's start", async () => {
    const fake = createFake();
    const gate = createGate();
    const { stub, pending } = await connectWithSessions(fake);
    await sendWaitingStepInput(stub, fake, gate);

    stub.say(STEP_RESULT_REQUEST);
    await pingAndWaitForPong(stub);
    // Handled now, the request would find no record of the step and answer
    // `interrupted` for a turn that is about to run.
    expect(listStepResults(stub)).toEqual([]);

    gate.open();
    await waitUntil(() => listInputResults(stub).length === 2);
    expect(listInputResults(stub)[1]).toMatchObject({ requestId: STEP_INPUT.requestId, ok: true });
    completeTurn(fake, fake.turns[1]!);
    await waitUntil(() => listStepResults(stub).length > 0);
    // The request may still be waiting when the turn ends, and is then
    // answered from the step's result file. Either way, every answer is the
    // turn's own result.
    for (const result of listStepResults(stub)) {
      expect(result).toEqual({
        _tag: "workspaceStepResult",
        ...STEP,
        outcome: { status: "completed", output: { text: "", exitStatus: "completed" } },
      });
    }
    stub.hangUp();
    await pending;
  });

  it("answers repeated requests for an agent step's result with the same result", async () => {
    const fake = createFake();
    const gate = createGate();
    const { stub, pending } = await connectWithSessions(fake);
    await sendWaitingStepInput(stub, fake, gate);

    // Asked twice while the input waits, as the controller does when both
    // an unanswered input and a reconnect make it ask.
    stub.say(STEP_RESULT_REQUEST);
    stub.say(STEP_RESULT_REQUEST);
    await pingAndWaitForPong(stub);
    gate.open();
    await waitUntil(() => listInputResults(stub).length === 2);
    completeTurn(fake, fake.turns[1]!);
    await waitUntil(() => listStepResults(stub).length > 0);

    // Asked again after the turn ended: the result file answers.
    stub.say(STEP_RESULT_REQUEST);
    await waitUntil(() => listStepResults(stub).length > 1);
    await pingAndWaitForPong(stub);
    const [first, ...repeated] = listStepResults(stub);
    expect(first?.outcome.status).toBe("completed");
    for (const result of repeated) expect(result).toEqual(first);
    stub.hangUp();
    await pending;
  });

  it("starts an action step at once while a session's frames wait", async () => {
    const fake = createFake();
    const gate = createGate();
    fake.startGates.set(SESSION_A, gate);
    const { stub, pending } = await connectWithSessions(fake);

    stub.say(buildStart(SESSION_A));
    await waitUntil(gate.reached);
    // An action this runner does not implement is answered as the frame is
    // handled, so the answer shows the frame did not wait for the session.
    stub.say({
      _tag: "workspaceStepStart",
      kind: "action",
      ...STEP,
      workspaceId: "0199e0e7-0000-7000-8000-0000000000e1",
      action: "no.such-action",
      input: {},
    });
    await waitUntil(() => listStepResults(stub).length === 1);
    expect(listStepResults(stub)[0]?.outcome).toMatchObject({
      status: "failed",
      code: "unsupported_action",
    });
    expect(listInputResults(stub)).toEqual([]);

    gate.open();
    await waitUntil(() => listInputResults(stub).length === 1);
    stub.hangUp();
    await pending;
  });
});

describe("concurrent real-Git workspace requests on the runner socket", () => {
  it("dispatches concurrent first-use and duplicate requests into one repository bootstrap", async () => {
    const remote = workspaceFixtures.makeRemote();
    const storageDir = workspaceFixtures.createTemporaryDir("hercule-socket-concurrent-home-");
    const bin = joinPath(storageDir, "bin");
    mkdirSync(bin);
    const entered = joinPath(storageDir, "bootstrap-entered");
    const release = joinPath(storageDir, "release-bootstrap");
    const calls = joinPath(storageDir, "clone-calls");
    const git = Bun.which("git")!;
    const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
    writeFileSync(
      joinPath(bin, "git"),
      `#!/bin/sh\ncase " $* " in\n*' clone '*)\nprintf 'clone\\n' >> ${quote(calls)}\nprintf '%s\\n' "$$" > ${quote(entered)}\nwhile [ ! -f ${quote(release)} ]; do sleep 0.01; done\n;;\nesac\nexec ${quote(git)} "$@"\n`,
      { mode: 0o700 },
    );
    const manager = makeTestWorkspaces({
      storageDir,
      gitEnv: { PATH: `${bin}:${process.env["PATH"] ?? "/usr/bin:/bin"}` },
    });
    const resourceId = workspaceFixtures.createId();
    const first = workspaceFixtures.buildProvisionFrame({
      kind: "ephemeral",
      checkouts: [
        workspaceFixtures.buildCheckout({
          resourceId,
          remote: remote.url,
          branch: "test/socket-first",
        }),
      ],
    });
    const second = workspaceFixtures.buildProvisionFrame({
      kind: "ephemeral",
      checkouts: [
        workspaceFixtures.buildCheckout({
          resourceId,
          remote: remote.url,
          branch: "test/socket-second",
        }),
      ],
    });
    const stub = await stubController((hello) => ({
      ...hello,
      capabilities: ["workspaceLifecycle"],
    }));
    const pending = runConnection(buildPin(stub), { workspaces: manager });
    try {
      await waitUntilProven(stub);
      stub.say(first);
      await waitUntil(() => existsSync(entered));
      stub.say(second);
      stub.say(first);
      const beforePongs = stub.received.filter((frame) => frame._tag === "pong").length;
      stub.say({ _tag: "ping" });
      await waitUntil(
        () => stub.received.filter((frame) => frame._tag === "pong").length > beforePongs,
      );
      writeFileSync(release, "release\n");
      await waitUntil(
        () => stub.received.filter((frame) => frame._tag === "workspaceReport").length === 3,
      );
      const reports = stub.received.filter((frame) => frame._tag === "workspaceReport");
      expect(reports.every((report) => report.status === "ready")).toBe(true);
      expect(reports.map((report) => report.workspaceId).sort()).toEqual(
        [first.workspaceId, first.workspaceId, second.workspaceId].sort(),
      );
      expect(readFileSync(calls, "utf8").trim().split("\n")).toHaveLength(1);
      const path = Effect.runSync(manager.resolve(first.workspaceId))!.cwd;
      expect(
        workspaceFixtures
          .runGitOrThrow(path, "worktree", "list", "--porcelain")
          .match(/^worktree /gm),
      ).toHaveLength(3);
    } finally {
      writeFileSync(release, "release\n");
      await Promise.all([
        Effect.runPromise(manager.waitForProvisioning(first.workspaceId)),
        Effect.runPromise(manager.waitForProvisioning(second.workspaceId)),
      ]);
      stub.hangUp();
      await pending;
      const capturedGitPid = existsSync(entered)
        ? Number(readFileSync(entered, "utf8").trim())
        : undefined;
      rmSync(storageDir, { recursive: true, force: true });
      rmSync(joinPath(remote.work, ".."), { recursive: true, force: true });
      if (capturedGitPid !== undefined) {
        await waitUntil(() => {
          try {
            process.kill(capturedGitPid, 0);
            return false;
          } catch {
            return true;
          }
        });
      }
    }
  });
});

it("echoes durable disposal and detach receipts through the socket while preserving an attached source", async () => {
  const remote = workspaceFixtures.makeRemote();
  const world = workspaceFixtures.createTemporaryDir("hercule-socket-detach-source-");
  const source = joinPath(world, "user checkout");
  workspaceFixtures.runGitOrThrow(world, "clone", remote.url, source);
  const storageDir = workspaceFixtures.createTemporaryDir("hercule-socket-removal-home-");
  const manager = makeTestWorkspaces({ storageDir });
  const resourceId = workspaceFixtures.createId();
  const attached = {
    ...workspaceFixtures.buildProvisionFrame({
      kind: "primary",
      checkouts: [workspaceFixtures.buildCheckout({ resourceId, remote: remote.url })],
    }),
    attachment: { path: source, remoteName: "origin" },
  };
  expect((await Effect.runPromise(manager.provision(attached))).status).toBe("ready");
  const derived = workspaceFixtures.buildProvisionFrame({
    kind: "ephemeral",
    checkouts: [
      {
        ...workspaceFixtures.buildCheckout({
          resourceId,
          remote: remote.url,
          branch: "test/socket-derived",
        }),
        repositoryWorkspaceId: attached.workspaceId,
        startingRevision: { kind: "current" },
      },
    ],
  });
  expect((await Effect.runPromise(manager.provision(derived))).status).toBe("ready");
  const cwd = Effect.runSync(manager.resolve(derived.workspaceId))!.cwd;
  const sourceBefore = workspaceFixtures.hashContents(source);
  const stub = await stubController((hello) => ({
    ...hello,
    capabilities: ["workspaceLifecycle"],
  }));
  const pending = runConnection(buildPin(stub), { workspaces: manager });
  try {
    await waitUntilProven(stub);
    stub.say({
      _tag: "workspaceDetach",
      workspaceId: attached.workspaceId,
      requestId: "socket-detach-intent",
    });
    await waitUntil(() =>
      stub.received.some(
        (frame) => frame._tag === "workspaceReport" && frame.requestId === "socket-detach-intent",
      ),
    );
    expect(
      stub.received.find(
        (frame) => frame._tag === "workspaceReport" && frame.requestId === "socket-detach-intent",
      ),
    ).toMatchObject({ status: "deleted", workspaceId: attached.workspaceId });
    expect(workspaceFixtures.hashContents(source)).toBe(sourceBefore);
    expect(Effect.runSync(manager.resolve(derived.workspaceId))?.cwd).toBe(cwd);
    writeFileSync(joinPath(cwd, "README.md"), "remaining derived changes\n");
    stub.say({
      _tag: "workspaceDispose",
      workspaceId: derived.workspaceId,
      requestId: "socket-discard-intent",
      discardChanges: true,
    });
    await waitUntil(() =>
      stub.received.some(
        (frame) => frame._tag === "workspaceReport" && frame.requestId === "socket-discard-intent",
      ),
    );
    expect(
      stub.received.find(
        (frame) => frame._tag === "workspaceReport" && frame.requestId === "socket-discard-intent",
      ),
    ).toMatchObject({ status: "deleted", workspaceId: derived.workspaceId });
    expect(existsSync(cwd)).toBe(false);
    expect(existsSync(joinPath(source, ".git", "objects"))).toBe(true);
    expect(
      workspaceFixtures.runGitOrThrow(source, "rev-parse", "refs/heads/test/socket-derived"),
    ).toMatch(/^[a-f0-9]{40}$/);
  } finally {
    stub.hangUp();
    await pending;
    await workspaceFixtures.cleanTemporaries();
  }
});

afterAll(workspaceFixtures.cleanTemporaries);
