/**
 * The runner's end of the socket: which controller it is willing to talk to.
 *
 * A runner pins a logical identity, not an address, so the thing under test is
 * what it does when the controller that answered is not the one its
 * `runner.json` names. The controller here is a real WebSocket server the test
 * stands up, because that is the only way to make it say something a real
 * controller never would: a hello with somebody else's identity, somebody
 * else's key, or a signature over nothing.
 *
 * This package reaches no controller code, so the stub is `Bun.serve` and an
 * Ed25519 keypair made here.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Duration, Effect, Schema } from "effect";
import {
  PROTOCOL_VERSION,
  RunnerToController,
  signedChallenge,
  type ControllerHello,
  type RunnerFacts,
  type ProbeReport,
  type ProbeRequest,
  type RunnerFactsReport,
  type RunnerFactsRequest,
  type RunnerHello,
  type RunnerToController as RunnerMessage,
} from "@hydra/protocol";
import {
  ControllerNotRecognised,
  connect,
  ProtocolMismatch,
  PROOF_DEADLINE,
  type ControllerPin,
} from "./socket";

/** What this machine says about itself; nothing here is about the probe. */
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

/** Who this machine is to the controller it joined, and who it is not. */
const RUNNER_ID = "01999999-0000-7000-8000-00000000000a";
const ANOTHER_RUNNER_ID = "01999999-0000-7000-8000-00000000000b";

const base64 = (value: Uint8Array): string => Buffer.from(value).toString("base64");

/** The bytes standard base64 stands for, in a buffer WebCrypto will take. */
const bytes = (encoded: string): Uint8Array<ArrayBuffer> => {
  const decoded = Buffer.from(encoded, "base64");
  const out = new Uint8Array(decoded.byteLength);
  out.set(decoded);
  return out;
};

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * How long a wait on the stub controller is given. Wall clock rather than a
 * count of attempts: an attempt takes as long as the machine is busy, so
 * counting them makes the wait shortest exactly when the rest of the suite is
 * running beside it.
 */
const WAIT_DEADLINE_MS = 10_000;

/**
 * Vitest's own budget, set from the waits rather than left at its default five
 * seconds. A test whose waits can outlast the timeout never gets to give up:
 * vitest kills it first, and the failure names the test rather than the frame
 * that never came. Three, because the longest case here waits for the
 * connection, then for the proof, then for what it asked for; the slack is for
 * the one that waits a proof deadline out on top of those.
 */
vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 3 + 10_000 });

/** Polls until it is true or the budget is gone, and says which. */
const waitFor = async (ready: () => boolean): Promise<boolean> => {
  const deadline = Date.now() + WAIT_DEADLINE_MS;
  while (!ready() && Date.now() < deadline) await delay(5);
  return ready();
};

const waitUntil = async (ready: () => boolean): Promise<void> => {
  expect(await waitFor(ready), "the stub controller never got there").toBe(true);
};

/**
 * Waits until the runner has accepted this stub as its controller.
 *
 * The watermark is the evidence, because it is only ever sent to a peer that
 * proved itself. The runner's own hello is not: the stub records that frame
 * before it has even signed its answer, so a test that sends a request on it
 * can put the request ahead of the hello - and a peer that has not proved
 * itself is answered with silence, whatever it asks.
 */
const proven = (stub: Stub): Promise<void> =>
  waitUntil(() => stub.received.some((frame) => frame._tag === "watermarkReport"));

const decodeRunnerFrame = (raw: unknown): RunnerMessage =>
  Effect.runSync(Schema.decodeUnknownEffect(RunnerToController)(raw));

/** An Ed25519 identity, as the controller's own is. */
const identity = async (): Promise<{
  readonly id: string;
  readonly publicKey: string;
  readonly sign: (payload: Uint8Array<ArrayBuffer>) => Promise<string>;
}> => {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as unknown as CryptoKeyPair;
  const publicKey = base64(new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey)));
  return {
    id: crypto.randomUUID(),
    publicKey,
    sign: async (payload) =>
      base64(
        new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, pair.privateKey, payload)),
      ),
  };
};

/** How the stub answers a hello: with the truth, or with something it is not. */
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
  /** Sends the runner a frame of the test's choosing. */
  readonly say: (frame: object) => void;
  readonly stop: () => void;
}

const running: Array<Stub> = [];

afterEach(() => {
  for (const stub of running.splice(0)) stub.stop();
});

/** A controller that upgrades anything and answers one hello with another. */
const stubController = async (
  tamper: Tamper = (real) => real,
  answers: {
    readonly greet?: boolean;
    readonly ping?: boolean;
    /** What the stub puts its name to, when the test wants that to be the wrong thing. */
    readonly signs?: (nonce: string) => Uint8Array<ArrayBuffer>;
  } = {},
): Promise<Stub> => {
  const controller = await identity();
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
            (answers.signs ?? ((nonce) => signedChallenge(RUNNER_ID, nonce)))(frame.nonce),
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
    // Never `close(undefined, undefined)`: a close with no code is not the same
    // frame as one carrying an explicit pair, and most of these want the plain one.
    hangUp: (code, reason) => (code === undefined ? live?.close() : live?.close(code, reason)),
    say: (frame) => live?.send(JSON.stringify(frame)),
    stop: () => {
      void server.stop(true);
    },
  };
  running.push(stub);
  return stub;
};

/** What `runner.json` holds about the controller this runner belongs to. */
const pinning = (stub: Stub, overrides: Partial<ControllerPin> = {}): ControllerPin => ({
  runnerId: RUNNER_ID,
  controllerUrl: stub.url,
  credential: "the-credential-the-join-handed-back",
  controllerIdentityId: stub.identityId,
  controllerPublicKey: stub.publicKey,
  ...overrides,
});

/**
 * How long the two tests that are *about* the deadline give a peer to prove who
 * it is. The shipped ten seconds is asserted as the exported default; waiting it
 * out four times over would be most of the suite's running time.
 */
const DEADLINE = Duration.millis(500);

/**
 * What every other test gives it: long enough that the fuse cannot fire. The
 * whole suite running at once can stall an event loop for a good part of a
 * second, and a stalled proof reads to the runner as a controller that never
 * answered - which in a test about probes or retirement is a flake, not a
 * finding. Only a test that asserts what the fuse does should carry one.
 */
const PATIENT = Duration.minutes(1);

/** Nothing here starts a session, so neither directory is ever made. */
const PROVIDERS_DIR = "/nonexistent/hydra-runner-providers";
const SCRATCH_DIR = "/nonexistent/hydra-runner-scratch";

/** Runs one connection to its end and reports how it ended. */
const attempt = (
  pin: ControllerPin,
  probe: Effect.Effect<RunnerFacts> = Effect.succeed(FACTS),
  proofDeadline: Duration.Duration = PATIENT,
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
        proofDeadline,
      }),
    ),
  );

/** The error a finished connection ended with, or nothing when it ended well. */
const failureOf = (outcome: Awaited<ReturnType<typeof attempt>> | undefined): unknown =>
  outcome !== undefined && outcome._tag === "Failure" ? outcome.failure : undefined;

describe("the controller a runner is willing to talk to", () => {
  it("hangs up on a hello carrying another controller's identity, saying nothing more", async () => {
    const other = await identity();
    const stub = await stubController((real) => ({ ...real, identityId: other.id }));

    const outcome = await attempt(pinning(stub));

    expect(failureOf(outcome)).toBeInstanceOf(ControllerNotRecognised);
    // One frame and no more: the runner said hello and then stopped talking.
    expect(stub.received.map((frame) => frame._tag)).toEqual(["runnerHello"]);
    expect(await stub.ended()).toBe(true);
  });

  it("hangs up on a hello carrying another controller's key, saying nothing more", async () => {
    const other = await identity();
    // The identity id is the one the runner expects, so what it is refusing is
    // the key: an id it recognises is not licence to trust whatever key arrives
    // beside it.
    const stub = await stubController((real) => ({ ...real, publicKey: other.publicKey }));

    const outcome = await attempt(pinning(stub));

    expect(failureOf(outcome)).toBeInstanceOf(ControllerNotRecognised);
    expect(stub.received.map((frame) => frame._tag)).toEqual(["runnerHello"]);
    expect(await stub.ended()).toBe(true);
  });

  it("hangs up on a signature that is not over its nonce, saying nothing more", async () => {
    const stub = await stubController((real) => ({
      ...real,
      signature: base64(crypto.getRandomValues(new Uint8Array(64))),
    }));

    const outcome = await attempt(pinning(stub));

    expect(failureOf(outcome)).toBeInstanceOf(ControllerNotRecognised);
    expect(stub.received.map((frame) => frame._tag)).toEqual(["runnerHello"]);
    expect(await stub.ended()).toBe(true);
  });

  it("hangs up on a signature that was not made for this runner, saying nothing more", async () => {
    // The relay. A peer holding a runner credential of its own can have the
    // controller sign anything it likes, so a signature that names another
    // runner - or names none at all - proves nothing on this connection.
    for (const signs of [
      (nonce: string) => bytes(nonce),
      (nonce: string) => signedChallenge(ANOTHER_RUNNER_ID, nonce),
    ]) {
      const stub = await stubController(undefined, { signs });

      const outcome = await attempt(pinning(stub));

      expect(failureOf(outcome)).toBeInstanceOf(ControllerNotRecognised);
      expect(stub.received.map((frame) => frame._tag)).toEqual(["runnerHello"]);
      expect(await stub.ended()).toBe(true);
    }
  });

  it("hangs up when its own pinned key is not a key, rather than trusting the answer", async () => {
    // A `runner.json` somebody edited, or a truncated write. The peer says the
    // very same thing back, so the id and the key both compare equal and the
    // signature is all that is left to refuse it on - and that check cannot
    // even be attempted, which must not read as having passed.
    const NOT_A_KEY = "AAAA";
    const stub = await stubController((real) => ({ ...real, publicKey: NOT_A_KEY }));

    const outcome = await attempt(pinning(stub, { controllerPublicKey: NOT_A_KEY }));

    expect(failureOf(outcome)).toBeInstanceOf(ControllerNotRecognised);
    expect(await stub.ended()).toBe(true);
  });

  it("gives up on a peer that upgrades the socket and never says who it is", async () => {
    // A peer that answers a hello with silence, and pings to look alive. One of
    // the two tests that carry the short fuse, because it is the fuse firing
    // that is under test.
    const stub = await stubController(undefined, { greet: false, ping: true });

    const outcome = await attempt(pinning(stub), Effect.succeed(FACTS), DEADLINE);

    expect(failureOf(outcome)).toBeInstanceOf(ControllerNotRecognised);
    // And it said nothing but its own hello while it waited: a peer that has
    // not proved who it is learns nothing about whether this runner is alive.
    expect(stub.received.map((frame) => frame._tag)).toEqual(["runnerHello"]);
  });

  it("gives an unproven peer ten seconds", () => {
    expect(Duration.toMillis(PROOF_DEADLINE)).toBe(10_000);
  });

  it("says the versions differ rather than calling a later controller an impostor", async () => {
    const stub = await stubController((real) => ({
      ...real,
      protocolVersion: PROTOCOL_VERSION + 1,
      somethingLater: true,
    }));

    const outcome = await attempt(pinning(stub));

    const failure = failureOf(outcome);
    expect(failure).toBeInstanceOf(ProtocolMismatch);
    expect((failure as ProtocolMismatch).message).toContain(String(PROTOCOL_VERSION + 1));
    expect(stub.received.map((frame) => frame._tag)).toEqual(["runnerHello"]);
  });

  it("ignores a second hello, so a proof once given cannot be taken back", async () => {
    const other = await identity();
    const stub = await stubController();

    let settled: Awaited<ReturnType<typeof attempt>> | undefined;
    const pending = attempt(pinning(stub)).then((outcome) => {
      settled = outcome;
    });

    await stub.connected();
    // The proof, observed: the watermark is only sent to a peer that has proved
    // itself, so it is what says the runner accepted the real hello.
    await proven(stub);
    // A hello claiming to be somebody else, after the real one was accepted. It
    // must not be able to talk the runner out of the controller it proved.
    stub.say({
      _tag: "controllerHello",
      protocolVersion: PROTOCOL_VERSION,
      capabilities: [],
      identityId: other.id,
      publicKey: other.publicKey,
      nonce: "AAAA",
      signature: "AAAA",
    });
    // Frames are answered one at a time, in the order they arrived, and a
    // runner that had been talked out of its controller answers nothing at all.
    // So a pong to a ping sent behind that hello is the proof this test needs,
    // and waiting for it beats waiting out a clock: no length of wall time says
    // "still talking", it only says "has not stopped yet".
    stub.say({ _tag: "ping" });
    await waitUntil(() => stub.received.some((frame) => frame._tag === "pong"));

    expect(settled, "a second hello is not something to hang up on").toBeUndefined();
    stub.hangUp();
    await pending;
    expect(failureOf(settled)).not.toBeInstanceOf(ControllerNotRecognised);
  });

  it("says what the machine has left as soon as the controller has proved itself", async () => {
    const stub = await stubController();

    let settled: Awaited<ReturnType<typeof attempt>> | undefined;
    const pending = attempt(pinning(stub)).then((outcome) => {
      settled = outcome;
    });

    await stub.connected();
    // Not a minute later: a runner that has just come online with an unknown
    // disk is a runner nothing can decide to place work on. By tag rather than
    // by position: the sessions snapshot rides the same moment.
    await proven(stub);
    expect(stub.received.find((frame) => frame._tag === "watermarkReport")).toEqual({
      _tag: "watermarkReport",
      watermark: {
        diskFreeBytes: 200 * 1024 ** 3,
        availableMemoryBytes: 1,
      },
    });

    stub.hangUp();
    await pending;
    expect(failureOf(settled)).not.toBeInstanceOf(ControllerNotRecognised);
  });

  it("stays on a hello that matches what it was told to expect", async () => {
    const stub = await stubController();

    let settled: Awaited<ReturnType<typeof attempt>> | undefined;
    // The other test that carries the short fuse: what it asserts is that the
    // fuse does not fire on a connection whose proof arrived.
    const pending = attempt(pinning(stub), Effect.succeed(FACTS), DEADLINE).then((outcome) => {
      settled = outcome;
    });

    await stub.connected();
    // Waited from the proof, not from the dial: the frames below the hello are
    // only sent once the peer has proved itself, so seeing one is what says the
    // fuse is now running against a proven connection.
    await proven(stub);
    // Waited out past the deadline the runner gives an unproven peer, because
    // that deadline must not be what ends a connection whose proof arrived.
    await delay(Duration.toMillis(DEADLINE) * 4);
    expect(settled, "the runner ended a connection it should have kept").toBeUndefined();
    expect(stub.received[0]?._tag).toBe("runnerHello");

    stub.hangUp();
    await pending;
    expect(settled).toBeDefined();
    // However the end of a connection reads, it is not the controller having
    // been the wrong controller.
    expect(failureOf(settled)).not.toBeInstanceOf(ControllerNotRecognised);
  });
});

describe("a runner whose controller has retired it", () => {
  /** How the controller ends a connection it will not have back, and what it says. */
  const POLICY_VIOLATION = 1008;
  const RETIRED = "RETIRED";

  /** What the operator has to read to know what to do about it. */
  const RE_ENLIST = "this runner was retired; run `hydra runner join` to re-enlist";

  it("says so, so the daemon can stop and the operator knows to re-enlist", async () => {
    const stub = await stubController();
    let settled: Awaited<ReturnType<typeof attempt>> | undefined;
    const pending = attempt(pinning(stub)).then((outcome) => {
      settled = outcome;
    });

    await stub.connected();
    await proven(stub);
    stub.hangUp(POLICY_VIOLATION, RETIRED);
    await pending;

    // The credential is dead, so redialling with it is the one thing this
    // connection ending must not lead to.
    const failure = failureOf(settled) as { readonly message?: string } | undefined;
    expect(failure, "a retired runner's connection ended in nothing to report").toBeDefined();
    expect(failure?.message).toContain(RE_ENLIST);
  });

  it("reads every other close as an ordinary connection that ended", async () => {
    // Two cases, because two things can be wrong: the reason with the retiring
    // code, and the code with the retiring reason. Both are closes the
    // controller really writes.
    const closes: ReadonlyArray<readonly [number, string]> = [
      [POLICY_VIOLATION, "this runner opened another connection"],
      [1001, RETIRED],
    ];
    for (const [code, reason] of closes) {
      const stub = await stubController();
      let settled: Awaited<ReturnType<typeof attempt>> | undefined;
      const pending = attempt(pinning(stub)).then((outcome) => {
        settled = outcome;
      });
      await stub.connected();
      await proven(stub);
      stub.hangUp(code, reason);
      await pending;

      const failure = failureOf(settled) as { readonly message?: string } | undefined;
      expect(failure?.message ?? "", `${String(code)} ${reason}`).not.toContain(RE_ENLIST);
    }
  });
});

describe("a controller asking for the machine's facts", () => {
  /**
   * The frame the controller sends. It is typed against the catalogue rather
   * than written as a bare object, so a rename of the frame is a compile error
   * here rather than a request this runner silently ignores.
   */
  const REQUEST: RunnerFactsRequest = { _tag: "factsRequest" };

  /** The report the runner answers with, once it has one. */
  const reportIn = (stub: Stub): RunnerFactsReport | undefined =>
    stub.received.find((frame): frame is RunnerFactsReport => frame._tag === "factsReport");

  it("reports what the probe finds now, not what it said at the hello", async () => {
    // The machine gained a `gh` since it connected, which is the whole reason
    // for asking again.
    const grown: RunnerFacts = {
      ...FACTS,
      toolchains: [
        ...FACTS.toolchains,
        { name: "gh", version: "2.99.0", path: "/usr/local/bin/gh" },
      ],
    };
    const stub = await stubController();
    let settled: Awaited<ReturnType<typeof attempt>> | undefined;
    const pending = attempt(pinning(stub), Effect.succeed(grown)).then((outcome) => {
      settled = outcome;
    });

    await stub.connected();
    await proven(stub);
    stub.say(REQUEST);

    await waitUntil(() => reportIn(stub) !== undefined);
    // The hourly report is sent only on a change; an answer to a request is
    // not, or the operator pressing the button on a machine nothing happened to
    // would wait for a frame that never comes.
    expect(reportIn(stub)).toEqual({ _tag: "factsReport", facts: grown });

    stub.hangUp();
    await pending;
    expect(failureOf(settled)).not.toBeInstanceOf(ControllerNotRecognised);
  });
});

describe("a controller asking a runner to probe a provider it cannot drive", () => {
  const REQUEST: ProbeRequest = {
    _tag: "probeRequest",
    requestId: "01999999-0000-7000-8000-0000000000c1",
    instanceId: "01999999-0000-7000-8000-0000000000c2",
    providerId: "codex",
    config: {},
  };

  const reportIn = (stub: Stub): ProbeReport | undefined =>
    stub.received.find((frame): frame is ProbeReport => frame._tag === "probeReport");

  it("answers that this build has no adapter for it, rather than leaving the caller waiting", async () => {
    const stub = await stubController();
    let settled: Awaited<ReturnType<typeof attempt>> | undefined;
    const pending = attempt(pinning(stub)).then((outcome) => {
      settled = outcome;
    });

    await stub.connected();
    await proven(stub);
    stub.say(REQUEST);

    await waitUntil(() => reportIn(stub) !== undefined);
    const report = reportIn(stub);
    // Correlated by request id: probes, logins and installs for several
    // instances can be in flight on one connection at once.
    expect(report?.requestId).toBe(REQUEST.requestId);
    expect(report?.instanceId).toBe(REQUEST.instanceId);
    expect(report?.result.auth.status).toBe("error");
    expect(report?.result.auth.message).toBe("no adapter for codex in this runner build");
    expect(report?.result.harnessVersion).toBeNull();
    expect(report?.result.models).toEqual([]);

    stub.hangUp();
    await pending;
    expect(failureOf(settled)).not.toBeInstanceOf(ControllerNotRecognised);
  });
});
