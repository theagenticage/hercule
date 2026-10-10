/**
 * Tests for the runner socket against the real controller: who may connect,
 * the hello exchange, and what the liveness check does to the runner row.
 *
 * The tests use a real WebSocket against a real server, because the socket is
 * about what goes over the wire. The credential is a real one from a real
 * join, and the frames are decoded with the protocol schema: a controller that
 * sends something `@hercule/protocol` cannot read is one no runner can talk
 * to.
 *
 * What the tests check:
 *
 * - A runner connects with the credential its join returned, and with nothing
 *   else. A rejected upgrade opens no socket.
 * - The hello checks compatibility: a different protocol version is rejected,
 *   and every other difference is not. The row then stores what the runner
 *   reported, with the system as the actor.
 * - The row then follows the connection: a pong keeps it online, silence marks
 *   it unreachable, a goodbye reads differently from a vanished runner, and a
 *   new hello brings it back from either.
 * - A promotion's freeze holds a hello and a departure until the transfer is
 *   cancelled. Once the controller is sealed, a held hello is answered with
 *   the new address and a departure writes nothing.
 *
 * The default 15 and 60 seconds are checked as the exported constants. The
 * behaviour is tested with intervals of tens of milliseconds passed to the
 * harness, because a real Bun server cannot run on a `TestClock`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Duration, Effect, Schema } from "effect";
import {
  ControllerToRunner,
  LOGIN_ENDED_CAPABILITY,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  encodeChallengeBytes,
  type ControllerHello,
  type ControllerToRunner as ControllerMessage,
  type ForwardingPointer,
  type InstallRequest,
  type JoinAnswer,
  type LoginCode,
  type LoginStart,
  type ProbeRequest,
  type ProbeResult,
  type RunnerFacts,
  type RunnerHello,
  type RunnerToController as RunnerMessage,
} from "@hercule/protocol";
import type { RunnerDetail } from "@hercule/contract";
import { uuidFromString } from "../db";
import { registry } from "../plugins";
import {
  freezeController,
  NEW_CONTROLLER_ADDRESS,
  requestTransfer,
  sealController,
} from "../promotion/testing";
import { completeSetup, get, send, withServer, type ServerHarness } from "../http/testing";
// The two default durations are imported from the socket module, so the test
// checks the values the controller actually uses.
import { RUNNER_PING_INTERVAL, RUNNER_SILENCE_LIMIT } from "./socket";

/**
 * Completes setup, then deletes every provider instance, and returns the login
 * token setup returned.
 *
 * Setup needs a provider instance, because it creates the default assistant
 * on one. But the controller probes every provider instance on each runner
 * that connects, and a probe request is a frame these tests would read where
 * they expect another. With no instance left, a connecting runner is sent no
 * probe, so every frame a test reads is one the test caused.
 */
const completeSetupWithNoProviderInstance = async (harness: ServerHarness): Promise<string> => {
  const token = await completeSetup(harness.base);
  await Effect.runPromise(Effect.orDie(harness.sql.unsafe(`DELETE FROM provider_instances`)));
  return token;
};

/** The path a runner connects to, on the same host and port as the API. */
const SOCKET_PATH = "/api/v1/runners/socket";

const buildSocketUrl = (base: string): string => `${base.replace(/^http:/, "ws:")}${SOCKET_PATH}`;

/** Encodes bytes as standard base64, which is how the protocol sends bytes. */
const encodeBase64 = (raw: Uint8Array): string => Buffer.from(raw).toString("base64");

/** Decodes standard base64 into a buffer WebCrypto accepts. */
const decodeBase64Bytes = (encoded: string): Uint8Array<ArrayBuffer> => {
  const decoded = Buffer.from(encoded, "base64");
  const out = new Uint8Array(decoded.byteLength);
  out.set(decoded);
  return out;
};

/** Creates a new nonce, the way a runner does. */
const mintNonce = (): string => encodeBase64(crypto.getRandomValues(new Uint8Array(16)));

/** The facts a runner in these tests reports about its machine. */
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

const THIS_BUILD = "0.1.0";

const GIB = 1024 * 1024 * 1024;

const decodeFrame = (raw: unknown): ControllerMessage =>
  Effect.runSync(Schema.decodeUnknownEffect(ControllerToRunner)(raw));

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Polls `look` until it returns a value, and returns it. The controller works
 * on its own schedule, so a wait names what it is waiting for rather than how
 * long, and the error names what never happened.
 */
const waitUntil = async <A>(
  what: string,
  look: () => A | undefined | Promise<A | undefined>,
): Promise<A> => {
  const deadline = Date.now() + 4000;
  do {
    const found = await look();
    if (found !== undefined) return found;
    await delay(5);
  } while (Date.now() < deadline);
  throw new Error(`the controller never ${what}`);
};

/** A fake runner's end of the socket, driven frame by frame. */
interface Wire {
  readonly send: (message: RunnerMessage) => void;
  /** The next frame the controller sent that this test has not taken yet. */
  readonly next: () => Promise<ControllerMessage>;
  /** Everything the controller has sent so far, in order. */
  readonly frames: ReadonlyArray<ControllerMessage>;
  /** How the controller ended the connection, once it has. */
  readonly closed: () => Promise<{ readonly code: number; readonly reason: string }>;
  readonly close: () => void;
}

const listFrames = <T extends ControllerMessage>(wire: Wire, tag: T["_tag"]): ReadonlyArray<T> =>
  wire.frames.filter((frame): frame is T => frame._tag === tag);

const listProbeRequests = (wire: Wire): ReadonlyArray<ProbeRequest> =>
  listFrames<ProbeRequest>(wire, "probeRequest");

const waitForFrame = <T extends ControllerMessage>(
  wire: Wire,
  tag: T["_tag"],
  index = 0,
): Promise<T> => waitUntil(`sent a ${tag}`, () => listFrames<T>(wire, tag)[index]);

/**
 * Opens the socket with a credential, as a runner does. The credential is sent
 * with the upgrade request, so a connection that opens has already been
 * accepted.
 */
const dial = (base: string, credential: string): Promise<Wire> =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(buildSocketUrl(base), {
      headers: { authorization: `Bearer ${credential}` },
    });
    const frames: Array<ControllerMessage> = [];
    let taken = 0;
    let ending: { readonly code: number; readonly reason: string } | undefined;

    socket.onmessage = (event) => {
      frames.push(decodeFrame(JSON.parse(String(event.data)) as unknown));
    };
    socket.onclose = (event) => {
      ending = { code: event.code, reason: event.reason };
    };
    socket.onerror = () => {
      // A rejected upgrade shows up here; the close handler records the reason.
    };
    socket.onopen = () => {
      resolve({
        frames,
        send: (message) => socket.send(JSON.stringify(message)),
        next: async () => {
          for (let attempt = 0; attempt < 400 && frames.length <= taken; attempt++) {
            await delay(5);
          }
          if (frames.length <= taken) {
            throw new Error(
              ending === undefined
                ? "the controller sent nothing"
                : `the controller closed (${String(ending.code)} ${ending.reason}) instead of answering`,
            );
          }
          return frames[taken++]!;
        },
        closed: async () => {
          for (let attempt = 0; attempt < 600 && ending === undefined; attempt++) {
            await delay(5);
          }
          if (ending === undefined) throw new Error("the controller held the connection open");
          return ending;
        },
        close: () => socket.close(),
      });
    };
    setTimeout(
      () =>
        reject(
          new Error(
            ending === undefined
              ? "the controller never upgraded the connection"
              : `the controller refused the upgrade (${String(ending.code)} ${ending.reason})`,
          ),
        ),
      3000,
    );
  });

/**
 * Checks whether the server upgrades the connection for an `Authorization`
 * header, ignoring what happens afterwards.
 */
const tryDial = (base: string, authorization?: string): Promise<"open" | "refused" | "hung"> =>
  new Promise((resolve) => {
    const socket = new WebSocket(buildSocketUrl(base), {
      headers: authorization === undefined ? {} : { authorization },
    });
    socket.onopen = () => {
      socket.close();
      resolve("open");
    };
    socket.onerror = () => resolve("refused");
    socket.onclose = () => resolve("refused");
    setTimeout(() => resolve("hung"), 3000);
  });

/**
 * Sends the upgrade request as plain HTTP, so a rejection can be read as its
 * status and error body rather than as a socket that did not open.
 */
const requestUpgrade = (base: string, authorization?: string): Promise<Response> =>
  fetch(`${base}${SOCKET_PATH}`, {
    headers: {
      connection: "Upgrade",
      upgrade: "websocket",
      "sec-websocket-key": encodeBase64(crypto.getRandomValues(new Uint8Array(16))),
      "sec-websocket-version": "13",
      ...(authorization === undefined ? {} : { authorization }),
    },
  });

/** Builds a runner's hello frame, with this build's version unless a test overrides it. */
const buildHello = (overrides: Partial<RunnerHello> = {}): RunnerHello => ({
  _tag: "runnerHello",
  protocolVersion: PROTOCOL_VERSION,
  capabilities: [],
  binaryVersion: THIS_BUILD,
  nonce: mintNonce(),
  facts: FACTS,
  ...overrides,
});

/** Joins a runner the normal way: a new join token, spent on the join. */
const enlist = async (harness: ServerHarness): Promise<JoinAnswer> => {
  const response = await send("POST", harness.base, "/api/v1/runners/join", {
    body: {},
    token: await harness.joinToken(),
  });
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json()) as JoinAnswer;
};

/** Reads the runner as the fleet page does. */
const readRunner = async (base: string, token: string, id: string): Promise<RunnerDetail> => {
  const response = await get(base, `/api/v1/runners/${id}`, token);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as RunnerDetail;
};

/** The delay between two reads of a runner row while `waitForRunner` polls. */
const ROW_POLL_INTERVAL_MS = 10;

/** How long `waitForRunner` polls the row before it fails. */
const ROW_WAIT_DEADLINE_MS = 10_000;

/**
 * Sets the test timeout so that it covers the most row waits one test makes,
 * five, each up to its deadline, plus the server's setup before them.
 *
 * The controller handles a runner's frame on its own schedule, and under the
 * load of the full suite a few waits and the setup take longer than vitest's
 * default five seconds. A test timeout shorter than its waits fails a test
 * that was only slow. It also hides which wait was slow, because vitest
 * stops the test before the wait can fail with its own error.
 */
vi.setConfig({ testTimeout: ROW_WAIT_DEADLINE_MS * 5 + 10_000 });

/**
 * Polls the runner until `ready` returns true, and returns it. Fails after
 * `ROW_WAIT_DEADLINE_MS` with an error that includes the row as last read.
 */
const waitForRunner = async (
  base: string,
  token: string,
  id: string,
  ready: (row: RunnerDetail) => boolean,
): Promise<RunnerDetail> => {
  const deadline = Date.now() + ROW_WAIT_DEADLINE_MS;
  let row = await readRunner(base, token, id);
  while (!ready(row)) {
    if (Date.now() >= deadline) {
      throw new Error(
        `the runner row never became ready; the last read returned ${JSON.stringify(row)}`,
      );
    }
    await delay(ROW_POLL_INTERVAL_MS);
    row = await readRunner(base, token, id);
  }
  return row;
};

/** Checks that the signature in the controller's hello is valid for the given bytes and its public key. */
const verifySignature = async (
  hello: ControllerHello,
  payload: Uint8Array<ArrayBuffer>,
): Promise<boolean> => {
  const key = await crypto.subtle.importKey(
    "spki",
    decodeBase64Bytes(hello.publicKey),
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    { name: "Ed25519" },
    key,
    decodeBase64Bytes(hello.signature),
    payload,
  );
};

/** Opens a connection, sends a hello, and returns the controller's hello in reply. */
const greet = async (
  base: string,
  credential: string,
  overrides: Partial<RunnerHello> = {},
): Promise<{
  readonly wire: Wire;
  readonly sent: RunnerHello;
  readonly answer: ControllerHello;
}> => {
  const wire = await dial(base, credential);
  const sent = buildHello(overrides);
  wire.send(sent);
  const answer = await wire.next();
  expect(answer._tag, JSON.stringify(answer)).toBe("controllerHello");
  return { wire, sent, answer: answer as ControllerHello };
};

/** Returns the connectivity states the audit log recorded for the runner, oldest first. */
const readStateTransitions = async (harness: ServerHarness): Promise<ReadonlyArray<unknown>> =>
  (await harness.audit("runner.stateChanged")).map((entry) => entry.payload["state"]);

/** The close codes the controller uses: for a rejected frame, and for a connection it is done with. */
const PROTOCOL_ERROR = 1002;
const GOING_AWAY = 1001;
/**
 * RFC 6455's "abnormal closure": the connection ended without a close frame.
 * Bun ends a connection that way when a frame exceeds its `maxPayloadLength`.
 */
const ABNORMAL_CLOSURE = 1006;

/** A short ping interval a test can wait for, with a silence limit it will not reach. */
const FAST = { interval: Duration.millis(40), silence: Duration.seconds(30) };

describe("opening the runner socket", () => {
  it("upgrades a runner using the credential its join returned", async () => {
    await withServer(async (harness) => {
      const joined = await enlist(harness);

      const wire = await dial(harness.base, joined.credential);
      // The upgrade is the whole admission: the controller sends nothing on
      // the socket until the runner sends its hello.
      expect(wire.frames).toEqual([]);
      wire.close();
    });
  });

  it("rejects every credential that is not an active runner's, and opens no socket", async () => {
    await withServer(async (harness) => {
      const user = await completeSetupWithNoProviderInstance(harness);
      const joined = await enlist(harness);
      const headers: ReadonlyArray<[string, string | undefined]> = [
        ["missing", undefined],
        ["a scheme that is not bearer", "Basic aGk6dGhlcmU="],
        ["a bearer with nothing after it", "Bearer "],
        ["a credential nobody was issued", "Bearer not-a-credential-anybody-holds"],
        ["a user's own credential", `Bearer ${user}`],
      ];

      for (const [what, header] of headers) {
        const response = await requestUpgrade(harness.base, header);
        expect(response.status, what).toBe(401);
        expect(await response.json(), what).toMatchObject({
          error: { code: "unauthenticated" },
        });
        expect(await tryDial(harness.base, header), what).toBe("refused");
      }

      // A retired runner's credential is revoked: it stops opening the socket
      // as soon as the row is retired.
      const live = await tryDial(harness.base, `Bearer ${joined.credential}`);
      expect(live, "the credential opened the socket before the runner was retired").toBe("open");
      await Effect.runPromise(
        Effect.orDie(harness.sql.unsafe(`UPDATE runners SET lifecycle = 'retired'`)),
      );

      const revoked = await requestUpgrade(harness.base, `Bearer ${joined.credential}`);
      expect(revoked.status, "retired").toBe(401);
      expect(await tryDial(harness.base, `Bearer ${joined.credential}`), "retired").toBe("refused");
    });
  });
});

describe("the hello exchange", () => {
  it("replies with a signature over the runner's nonce and marks the runner online", async () => {
    await withServer(async (harness) => {
      const token = await completeSetupWithNoProviderInstance(harness);
      const joined = await enlist(harness);

      const { wire, sent, answer } = await greet(harness.base, joined.credential, {
        capabilities: ["sessions"],
      });

      expect(answer.protocolVersion).toBe(PROTOCOL_VERSION);
      // The identity in the hello matches, byte for byte, the one the join returned and the runner pins.
      expect(answer.identityId).toBe(joined.controllerIdentityId);
      expect(answer.publicKey).toBe(joined.controllerPublicKey);
      expect(answer.nonce).toBe(sent.nonce);
      expect(await verifySignature(answer, encodeChallengeBytes(joined.runnerId, sent.nonce))).toBe(
        true,
      );
      // A signature over the nonce alone would be valid on any connection, so
      // a peer holding any runner's credential could relay it to this one.
      expect(await verifySignature(answer, decodeBase64Bytes(sent.nonce))).toBe(false);

      const row = await waitForRunner(
        harness.base,
        token,
        joined.runnerId,
        (one) => one.connectivity === "online",
      );
      expect(row.connectivity).toBe("online");
      expect(row.version).toBe(THIS_BUILD);
      expect(row.facts).toEqual(FACTS);
      expect(row.protocolVersion).toBe(PROTOCOL_VERSION);
      expect(row.lastSeenAt).not.toBeNull();
      expect(Number.isNaN(Date.parse(String(row.lastSeenAt)))).toBe(false);

      // A negotiated capability is one both sides offered: nothing is stored
      // that only one side offered.
      expect(row.negotiatedCapabilities).not.toBeNull();
      for (const capability of row.negotiatedCapabilities ?? []) {
        expect(sent.capabilities, "the runner did not offer it").toContain(capability);
        expect(answer.capabilities, "the controller did not offer it").toContain(capability);
      }

      // No user or session asked for this, and a runner is never an actor.
      const entries = await harness.audit("runner.stateChanged");
      expect(entries).toHaveLength(1);
      expect(entries[0]?.actor).toBe("system");
      expect(entries[0]?.payload).toMatchObject({ runnerId: joined.runnerId, state: "online" });

      wire.close();
    });
  });

  it("brings a runner with a different binary version online anyway", async () => {
    await withServer(async (harness) => {
      const token = await completeSetupWithNoProviderInstance(harness);
      const joined = await enlist(harness);

      const { wire } = await greet(harness.base, joined.credential, {
        binaryVersion: "0.0.0-from-another-build",
      });

      const row = await waitForRunner(
        harness.base,
        token,
        joined.runnerId,
        (one) => one.connectivity === "online",
      );
      expect(row.connectivity).toBe("online");
      // Stored, so the fleet page can show the difference: warn, never block.
      expect(row.version).toBe("0.0.0-from-another-build");

      wire.close();
    });
  });

  it("closes the connection on a hello with another protocol version, with a reason, and leaves the row unchanged", async () => {
    await withServer(async (harness) => {
      const token = await completeSetupWithNoProviderInstance(harness);
      const joined = await enlist(harness);

      const wire = await dial(harness.base, joined.credential);
      wire.send(buildHello({ protocolVersion: PROTOCOL_VERSION + 1 }));

      const ending = await wire.closed();
      expect(ending.reason, "a rejected hello is a close with a reason").not.toBe("");
      // A rejection is a close, not a message: the protocol has no error frame.
      expect(wire.frames).toEqual([]);

      const row = await readRunner(harness.base, token, joined.runnerId);
      expect(row.connectivity).toBe("offline");
      expect(row.lastSeenAt).toBeNull();
      expect(row.version).toBeNull();
      expect(await readStateTransitions(harness)).toEqual([]);
    });
  });

  it("refuses a runner on protocol version 1, whose start would drop the input it carries, and says to upgrade it", async () => {
    await withServer(async (harness) => {
      const token = await completeSetupWithNoProviderInstance(harness);
      const joined = await enlist(harness);

      const wire = await dial(harness.base, joined.credential);
      wire.send(buildHello({ protocolVersion: 1 }));

      const ending = await wire.closed();
      expect(ending.reason).toContain("upgrade the runner");
      expect(ending.reason).toContain(`version ${String(PROTOCOL_VERSION)}`);
      expect(wire.frames).toEqual([]);
      const row = await readRunner(harness.base, token, joined.runnerId);
      expect(row.connectivity).toBe("offline");
    });
  });

  // Version 5 cannot announce a promoted controller.
  it("refuses a runner on protocol version 5 and says to upgrade it", async () => {
    await withServer(async (harness) => {
      const joined = await enlist(harness);
      const wire = await dial(harness.base, joined.credential);
      wire.send(buildHello({ protocolVersion: 5 }));

      const ending = await wire.closed();
      expect(PROTOCOL_VERSION).toBe(6);
      expect(ending.reason).toBe(
        "this controller uses runner protocol version 6 and the runner does not; " +
          "upgrade the runner to a build that uses version 6",
      );
      expect(wire.frames).toEqual([]);
    });
  });

  it("reports a version mismatch when a runner sends a hello it cannot decode", async () => {
    await withServer(async (harness) => {
      const joined = await enlist(harness);
      const wire = await dial(harness.base, joined.credential);

      // What a newer build's hello looks like to this controller: another
      // version, without the fields this build requires. It must be reported as
      // a version mismatch, not as an unreadable frame.
      wire.send({
        _tag: "runnerHello",
        protocolVersion: PROTOCOL_VERSION + 1,
        somethingLater: true,
      } as unknown as RunnerMessage);

      const ending = await wire.closed();
      expect(ending.reason).toContain(String(PROTOCOL_VERSION));
      expect(wire.frames).toEqual([]);
    });
  });
});

describe("what a connection leaves behind", () => {
  it("marks a runner unreachable when the controller closed its connection", async () => {
    await withServer(
      async (harness) => {
        const token = await completeSetupWithNoProviderInstance(harness);
        const joined = await enlist(harness);
        const { wire } = await greet(harness.base, joined.credential);
        expect(
          (
            await waitForRunner(
              harness.base,
              token,
              joined.runnerId,
              (one) => one.connectivity === "online",
            )
          ).connectivity,
        ).toBe("online");

        // A frame this build cannot read, like a newer runner sending a frame
        // type this protocol version does not have.
        wire.send({ _tag: "nonsense" } as unknown as RunnerMessage);
        const ending = await wire.closed();
        expect(ending.code, "the frame was rejected, not the runner retired").toBe(PROTOCOL_ERROR);
        expect(ending.reason).not.toBe("");

        // The controller closed it, so no goodbye was sent: the runner counts as
        // gone, like one that vanished.
        const row = await waitForRunner(
          harness.base,
          token,
          joined.runnerId,
          (one) => one.connectivity === "unreachable",
        );
        expect(row.connectivity).toBe("unreachable");
        expect(await readStateTransitions(harness)).toEqual(["online", "unreachable"]);
      },
      { pings: FAST },
    );
  });

  it("closes the connection of a runner that sends a frame larger than MAX_FRAME_BYTES", async () => {
    await withServer(
      async (harness) => {
        const token = await completeSetupWithNoProviderInstance(harness);
        const joined = await enlist(harness);
        const { wire } = await greet(harness.base, joined.credential);
        await waitForRunner(
          harness.base,
          token,
          joined.runnerId,
          (one) => one.connectivity === "online",
        );

        // A frame the controller could otherwise read: a pong with one field
        // it ignores, padded one byte past the limit.
        const pong = JSON.stringify({ _tag: "pong", padding: "" });
        const padding = "x".repeat(MAX_FRAME_BYTES - Buffer.byteLength(pong) + 1);
        wire.send({ _tag: "pong", padding } as unknown as RunnerMessage);

        const ending = await wire.closed();
        expect(ending.code, "the transport dropped the connection").toBe(ABNORMAL_CLOSURE);
        const row = await waitForRunner(
          harness.base,
          token,
          joined.runnerId,
          (one) => one.connectivity === "unreachable",
        );
        expect(row.connectivity).toBe("unreachable");
      },
      { pings: FAST },
    );
  });

  it("accepts only one hello per connection, however they arrive", async () => {
    await withServer(
      async (harness) => {
        const joined = await enlist(harness);
        const wire = await dial(harness.base, joined.credential);

        // Both at once, without waiting for an answer to the first. The
        // transport gives each frame its own fiber, so a controller that
        // handled the two in parallel would sign twice, write the row twice and
        // answer twice, for a frame anyone holding the credential can send as
        // often as they like.
        wire.send(buildHello());
        wire.send(buildHello());

        const ending = await wire.closed();
        expect(ending.code, "the second hello was rejected").toBe(PROTOCOL_ERROR);
        expect(ending.reason).not.toBe("");
        expect(wire.frames.filter((frame) => frame._tag === "controllerHello")).toHaveLength(1);
        expect(await readStateTransitions(harness)).toEqual(["online", "unreachable"]);
      },
      { pings: FAST },
    );
  });

  it("closes the older connection when a runner connects again, and keeps the runner online", async () => {
    await withServer(
      async (harness) => {
        const token = await completeSetupWithNoProviderInstance(harness);
        const joined = await enlist(harness);

        const older = await greet(harness.base, joined.credential);
        expect(
          (
            await waitForRunner(
              harness.base,
              token,
              joined.runnerId,
              (one) => one.connectivity === "online",
            )
          ).connectivity,
        ).toBe("online");

        const newer = await greet(harness.base, joined.credential);
        // A runner has one connection. The replaced one is closed with "going
        // away" rather than as an error, because it did nothing wrong.
        const ending = await older.wire.closed();
        expect(ending.code).toBe(GOING_AWAY);
        expect(ending.reason).not.toBe("");

        // The older connection's final status write does not overwrite the row
        // the newer connection now owns.
        await delay(150);
        const row = await readRunner(harness.base, token, joined.runnerId);
        expect(row.connectivity).toBe("online");
        expect(await readStateTransitions(harness)).toEqual(["online"]);

        newer.wire.close();
      },
      { pings: FAST },
    );
  });
});

describe("the liveness check", () => {
  it("pings every 15 seconds and marks a runner unreachable after 60 seconds of silence", () => {
    expect(Duration.toMillis(RUNNER_PING_INTERVAL)).toBe(15_000);
    expect(Duration.toMillis(RUNNER_SILENCE_LIMIT)).toBe(60_000);
  });

  it("pings on the interval, and every pong updates the runner's last-seen time", async () => {
    await withServer(
      async (harness) => {
        const token = await completeSetupWithNoProviderInstance(harness);
        const joined = await enlist(harness);
        const { wire } = await greet(harness.base, joined.credential);

        const first = await waitForRunner(
          harness.base,
          token,
          joined.runnerId,
          (one) => one.connectivity === "online",
        );
        expect(first.lastSeenAt).not.toBeNull();

        // Four pings, each answered the way a runner answers one.
        for (let beat = 0; beat < 4; beat++) {
          const ping = await wire.next();
          expect(ping._tag, JSON.stringify(ping)).toBe("ping");
          wire.send({ _tag: "pong" });
        }

        const later = await waitForRunner(
          harness.base,
          token,
          joined.runnerId,
          (one) => Date.parse(String(one.lastSeenAt)) > Date.parse(String(first.lastSeenAt)),
        );
        expect(Date.parse(String(later.lastSeenAt))).toBeGreaterThan(
          Date.parse(String(first.lastSeenAt)),
        );
        // Answering kept it online.
        expect(later.connectivity).toBe("online");

        wire.close();
      },
      { pings: FAST },
    );
  });

  it("keeps a runner that answers online, for longer than the silence limit", async () => {
    await withServer(
      async (harness) => {
        const token = await completeSetupWithNoProviderInstance(harness);
        const joined = await enlist(harness);
        const { wire } = await greet(harness.base, joined.credential);

        // Ten intervals, which is two silence limits: a runner that answers
        // stays online, and only a pong counts as an answer. The limit is
        // five intervals, so a pong that a busy machine delays by a few
        // intervals still arrives in time.
        for (let beat = 0; beat < 10; beat++) {
          const ping = await wire.next();
          expect(ping._tag, JSON.stringify(ping)).toBe("ping");
          wire.send({ _tag: "pong" });
        }

        expect((await readRunner(harness.base, token, joined.runnerId)).connectivity).toBe(
          "online",
        );
        expect(await readStateTransitions(harness)).toEqual(["online"]);

        wire.close();
      },
      { pings: { ...FAST, silence: Duration.millis(200) } },
    );
  });

  it("marks a runner that stops answering unreachable, with the system as the actor", async () => {
    await withServer(
      async (harness) => {
        const token = await completeSetupWithNoProviderInstance(harness);
        const joined = await enlist(harness);
        const { wire } = await greet(harness.base, joined.credential);

        expect(
          (
            await waitForRunner(
              harness.base,
              token,
              joined.runnerId,
              (one) => one.connectivity === "online",
            )
          ).connectivity,
        ).toBe("online");

        // The socket stays open but the runner sends nothing, which a
        // WebSocket-level ping would have hidden.
        const row = await waitForRunner(
          harness.base,
          token,
          joined.runnerId,
          (one) => one.connectivity === "unreachable",
        );
        expect(row.connectivity).toBe("unreachable");

        expect(await readStateTransitions(harness)).toEqual(["online", "unreachable"]);
        const entries = await harness.audit("runner.stateChanged");
        for (const entry of entries) expect(entry.actor).toBe("system");

        wire.close();
      },
      { pings: { ...FAST, silence: Duration.millis(200) } },
    );
  });

  it("marks a runner that sent a goodbye offline, and one that vanished unreachable", async () => {
    await withServer(
      async (harness) => {
        const token = await completeSetupWithNoProviderInstance(harness);
        const joined = await enlist(harness);

        const announced = await greet(harness.base, joined.credential);
        expect(
          (
            await waitForRunner(
              harness.base,
              token,
              joined.runnerId,
              (one) => one.connectivity === "online",
            )
          ).connectivity,
        ).toBe("online");
        announced.wire.send({ _tag: "goodbye" });
        announced.wire.close();

        expect(
          (
            await waitForRunner(
              harness.base,
              token,
              joined.runnerId,
              (one) => one.connectivity === "offline",
            )
          ).connectivity,
        ).toBe("offline");
        // It never went through `unreachable`: the runner sent a goodbye, so
        // there was no silence to interpret.
        expect(await readStateTransitions(harness)).toEqual(["online", "offline"]);

        // A new hello brings it back from `offline`.
        const back = await greet(harness.base, joined.credential);
        expect(
          (
            await waitForRunner(
              harness.base,
              token,
              joined.runnerId,
              (one) => one.connectivity === "online",
            )
          ).connectivity,
        ).toBe("online");

        // A connection that just closes, without a goodbye, is not a planned departure.
        back.wire.close();
        expect(
          (
            await waitForRunner(
              harness.base,
              token,
              joined.runnerId,
              (one) => one.connectivity === "unreachable",
            )
          ).connectivity,
        ).toBe("unreachable");

        // A new hello brings it back from `unreachable` too.
        const again = await greet(harness.base, joined.credential);
        expect(
          (
            await waitForRunner(
              harness.base,
              token,
              joined.runnerId,
              (one) => one.connectivity === "online",
            )
          ).connectivity,
        ).toBe("online");

        expect(await readStateTransitions(harness)).toEqual([
          "online",
          "offline",
          "online",
          "unreachable",
          "online",
        ]);
        // Five connectivity changes, and no lifecycle change: the lifecycle
        // belongs to the owner, not the socket.
        expect((await readRunner(harness.base, token, joined.runnerId)).lifecycle).toBe("active");
        const entries = await harness.audit("runner.stateChanged");
        for (const entry of entries) expect(entry.actor).toBe("system");

        again.wire.close();
      },
      { pings: FAST },
    );
  });
});

describe("what a runner reports about its machine", () => {
  /** Builds a watermark report, with the free disk the test wants. */
  const buildResourceReport = (diskFreeBytes: number) => ({
    diskFreeBytes,
    availableMemoryBytes: 16 * 1024 * 1024 * 1024,
  });

  it("stores the watermark a runner reports and returns it on the runner", async () => {
    await withServer(
      async (harness) => {
        const token = await completeSetupWithNoProviderInstance(harness);
        const joined = await enlist(harness);
        const { wire } = await greet(harness.base, joined.credential);

        const online = await waitForRunner(
          harness.base,
          token,
          joined.runnerId,
          (one) => one.connectivity === "online",
        );
        // A runner that has only just sent its hello has not reported its
        // disk space yet.
        expect(online.watermark).toBeNull();

        // Above the default ten-gibibyte watermark, so the runner is still
        // accepting work.
        wire.send({ _tag: "watermarkReport", watermark: buildResourceReport(200 * GIB) });
        const stored = await waitForRunner(
          harness.base,
          token,
          joined.runnerId,
          (one) => one.watermark !== null,
        );
        expect(stored.watermark).toEqual(buildResourceReport(200 * GIB));

        const before = await harness.audit("runner.placementsChanged");
        // A runner with no earlier report counts as accepting work, so a
        // first report with plenty of disk changes nothing.
        expect(before).toHaveLength(0);

        // The same report again, then a different amount of disk that means
        // the same for placement. Waiting for the second one to be stored
        // proves the first was handled and deliberately wrote no audit entry.
        wire.send({ _tag: "watermarkReport", watermark: buildResourceReport(200 * GIB) });
        wire.send({ _tag: "watermarkReport", watermark: buildResourceReport(150 * GIB) });
        const again = await waitForRunner(
          harness.base,
          token,
          joined.runnerId,
          (one) => one.watermark?.diskFreeBytes === 150 * GIB,
        );
        expect(again.watermark).toEqual(buildResourceReport(150 * GIB));
        expect(
          await harness.audit("runner.placementsChanged"),
          "nothing about placement changed",
        ).toHaveLength(before.length);

        // The disk filled up, below the default watermark. This changes what
        // placement may do with the runner, so it is recorded.
        wire.send({ _tag: "watermarkReport", watermark: buildResourceReport(4 * GIB) });
        const short = await waitForRunner(
          harness.base,
          token,
          joined.runnerId,
          (one) => one.watermark?.diskFreeBytes === 4 * GIB,
        );
        expect(short.watermark).toEqual(buildResourceReport(4 * GIB));

        const after = await harness.audit("runner.placementsChanged");
        expect(after).toHaveLength(before.length + 1);
        const flip = after[after.length - 1];
        // No user or session asked for this, and a runner is never an actor.
        expect(flip?.actor).toBe("system");
        expect(flip?.payload).toMatchObject({
          runnerId: joined.runnerId,
          acceptingPlacements: false,
        });

        // A `system` actor the event schema cannot encode would fail the
        // whole page, not just the row, so it is also read back over HTTP.
        const log = (await (await get(harness.base, "/api/v1/events", token)).json()) as {
          items: ReadonlyArray<{
            kind: string;
            actor: string | null;
            payload: Record<string, unknown>;
          }>;
        };
        const recorded = log.items.find((entry) => entry.kind === "runner.placementsChanged");
        expect(recorded).toBeDefined();
        expect(recorded!.actor).toBe("system");
        expect(recorded!.payload).toMatchObject({ runnerId: joined.runnerId });

        wire.close();
      },
      { pings: FAST },
    );
  });

  it("records a runner whose first report shows no room left", async () => {
    await withServer(
      async (harness) => {
        const token = await completeSetupWithNoProviderInstance(harness);
        const joined = await enlist(harness);
        const { wire } = await greet(harness.base, joined.credential);
        await waitForRunner(
          harness.base,
          token,
          joined.runnerId,
          (one) => one.connectivity === "online",
        );

        // Its first report, and the disk is full. There was no earlier report,
        // but a runner that cannot take work is a change worth recording
        // either way.
        wire.send({ _tag: "watermarkReport", watermark: buildResourceReport(4 * GIB) });
        await waitForRunner(harness.base, token, joined.runnerId, (one) => one.watermark !== null);

        const entries = await harness.audit("runner.placementsChanged");
        expect(entries).toHaveLength(1);
        expect(entries[0]?.actor).toBe("system");
        expect(entries[0]?.payload).toMatchObject({ acceptingPlacements: false });

        wire.close();
      },
      { pings: FAST },
    );
  });

  it("stores facts a runner reports after its hello", async () => {
    await withServer(
      async (harness) => {
        const token = await completeSetupWithNoProviderInstance(harness);
        const joined = await enlist(harness);
        const { wire } = await greet(harness.base, joined.credential);

        const online = await waitForRunner(
          harness.base,
          token,
          joined.runnerId,
          (one) => one.connectivity === "online",
        );
        expect(online.facts).toEqual(FACTS);

        // The machine got `gh` installed while the connection was open.
        const grown: RunnerFacts = {
          ...FACTS,
          toolchains: [
            ...FACTS.toolchains,
            { name: "gh", version: "2.99.0", path: "/usr/local/bin/gh" },
          ],
        };
        wire.send({ _tag: "factsReport", facts: grown });

        const changed = await waitForRunner(
          harness.base,
          token,
          joined.runnerId,
          (one) => one.facts?.toolchains.length === 2,
        );
        // The report replaces the whole column: only the latest report
        // matters, so nothing is merged.
        expect(changed.facts).toEqual(grown);

        wire.close();
      },
      { pings: FAST },
    );
  });

  it("caps sessions at one per 2 GiB until the owner sets a cap", async () => {
    await withServer(
      async (harness) => {
        const token = await completeSetupWithNoProviderInstance(harness);
        const joined = await enlist(harness);
        // The cap can only be computed once the runner has reported its
        // memory, which it does in its hello.
        const { wire } = await greet(harness.base, joined.credential, {
          facts: { ...FACTS, totalMemoryBytes: 16 * GIB },
        });

        const sixteen = await waitForRunner(
          harness.base,
          token,
          joined.runnerId,
          (one) => one.facts?.totalMemoryBytes === 16 * GIB,
        );
        expect(sixteen.maxConcurrentSessions).toBe(8);

        // A machine too small for even one 2 GiB session still gets a cap of one.
        wire.send({ _tag: "factsReport", facts: { ...FACTS, totalMemoryBytes: 3 * GIB } });
        const small = await waitForRunner(
          harness.base,
          token,
          joined.runnerId,
          (one) => one.facts?.totalMemoryBytes === 3 * GIB,
        );
        expect(small.maxConcurrentSessions).toBe(1);

        const capped = await send("PATCH", harness.base, `/api/v1/runners/${joined.runnerId}`, {
          body: { maxConcurrentSessions: 4 },
          token,
        });
        expect(capped.status, await capped.clone().text()).toBe(200);

        // The owner's cap stays: a report with a different memory size does
        // not override it.
        wire.send({ _tag: "factsReport", facts: { ...FACTS, totalMemoryBytes: 64 * GIB } });
        const overridden = await waitForRunner(
          harness.base,
          token,
          joined.runnerId,
          (one) => one.facts?.totalMemoryBytes === 64 * GIB,
        );
        expect(overridden.maxConcurrentSessions).toBe(4);

        wire.close();
      },
      { pings: FAST },
    );
  });

  it("keeps the runner readable when its stored watermark cannot be decoded", async () => {
    await withServer(
      async (harness) => {
        const token = await completeSetupWithNoProviderInstance(harness);
        const joined = await enlist(harness);
        const { wire } = await greet(harness.base, joined.credential);
        await waitForRunner(
          harness.base,
          token,
          joined.runnerId,
          (one) => one.connectivity === "online",
        );

        // A column written by a build with a different shape. Reads return it
        // as null, and writes must not fail on it either, or this runner would
        // lose its socket a minute after every hello, forever.
        await Effect.runPromise(
          Effect.orDie(
            harness.sql`UPDATE runners SET watermark = 'not json at all'
                        WHERE id = ${uuidFromString(joined.runnerId)}`,
          ),
        );

        wire.send({ _tag: "watermarkReport", watermark: buildResourceReport(200 * GIB) });
        const stored = await waitForRunner(
          harness.base,
          token,
          joined.runnerId,
          (one) => one.watermark !== null,
        );
        expect(stored.watermark).toEqual(buildResourceReport(200 * GIB));
        expect(stored.connectivity).toBe("online");

        wire.close();
      },
      { pings: FAST },
    );
  });

  it("stores nothing a connection reports before its hello", async () => {
    await withServer(
      async (harness) => {
        const token = await completeSetupWithNoProviderInstance(harness);
        const joined = await enlist(harness);
        // A credential proves a runner joined, not that this connection is
        // that runner speaking the protocol. Until the hello arrives, a report
        // is ignored.
        const wire = await dial(harness.base, joined.credential);

        wire.send({ _tag: "watermarkReport", watermark: buildResourceReport(4 * GIB) });
        wire.send({ _tag: "factsReport", facts: { ...FACTS, docker: true } });
        await delay(100);

        const row = await readRunner(harness.base, token, joined.runnerId);
        expect(row.connectivity).toBe("offline");
        expect(row.watermark).toBeNull();
        expect(row.facts).toBeNull();

        wire.close();
      },
      { pings: FAST },
    );
  });

  it("ignores pongs from a connection that never sends a hello, and closes it", async () => {
    await withServer(
      async (harness) => {
        const token = await completeSetupWithNoProviderInstance(harness);
        const joined = await enlist(harness);
        // A credential, a socket, and no hello. It answers every ping, which is
        // the only way a connection could look alive without a hello.
        const wire = await dial(harness.base, joined.credential);
        const answering = setInterval(() => {
          wire.send({ _tag: "pong" });
        }, 10);

        const ended = await wire.closed();
        clearInterval(answering);

        expect(ended.code).toBe(1001);
        const row = await readRunner(harness.base, token, joined.runnerId);
        // The runner never sent a hello, so the row must not show it as seen:
        // placement relies on "last seen a moment ago".
        expect(row.lastSeenAt).toBeNull();
        expect(row.connectivity).toBe("offline");
      },
      { pings: { ...FAST, silence: Duration.millis(200) } },
    );
  });

  it("does not update the last-seen time on a report; only a pong does", async () => {
    await withServer(
      async (harness) => {
        const token = await completeSetupWithNoProviderInstance(harness);
        const joined = await enlist(harness);
        const { wire } = await greet(harness.base, joined.credential);

        const online = await waitForRunner(
          harness.base,
          token,
          joined.runnerId,
          (one) => one.connectivity === "online",
        );
        expect(online.lastSeenAt).not.toBeNull();

        // Long enough that a report which updated the timestamp would show it.
        await delay(50);
        wire.send({ _tag: "watermarkReport", watermark: buildResourceReport(200 * GIB) });
        wire.send({ _tag: "factsReport", facts: { ...FACTS, docker: true } });

        const reported = await waitForRunner(
          harness.base,
          token,
          joined.runnerId,
          (one) => one.watermark !== null && one.facts?.docker === true,
        );
        expect(reported.watermark, "the report never landed").not.toBeNull();
        expect(reported.facts?.docker, "the report never landed").toBe(true);
        // Only the ping and pong decide liveness. A runner could send reports
        // while unable to answer a ping, and the row must treat that as
        // silence.
        expect(reported.lastSeenAt).toBe(online.lastSeenAt);
        expect(reported.connectivity).toBe("online");

        wire.close();
      },
      { pings: { ...FAST, interval: Duration.seconds(30), silence: Duration.seconds(60) } },
    );
  });
});

describe("what the controller stopping does to its local runner", () => {
  /** The `hercule` entry point, run from source instead of the compiled binary. */
  const HERCULE = `${import.meta.dirname}/../../../../packages/hercule/src/main.ts`;

  it("marks the runner offline, never unreachable, when the child is asked to stop", async () => {
    const home = mkdtempSync(join(tmpdir(), "hercule-local-child-"));
    await withServer(async (harness) => {
      const token = await completeSetupWithNoProviderInstance(harness);
      const child = Bun.spawn(
        [process.execPath, "run", HERCULE, "runner", "--local", "--home", home],
        { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
      );
      let said = "";
      void (async () => {
        const decoder = new TextDecoder();
        for await (const chunk of child.stdout) said += decoder.decode(chunk, { stream: true });
      })();

      try {
        // The controller's handshake: it reads the child's first line and
        // answers on its stdin, exactly as the boot step does.
        for (let waited = 0; waited < 15_000 && said === ""; waited += 20) await delay(20);
        expect(said).toBe('{"join":true}\n');
        void child.stdin.write(
          `${JSON.stringify({ controllerUrl: harness.base, token: await harness.joinToken() })}\n`,
        );
        await child.stdin.end();

        // It joins and connects, and the fleet shows it as online and ready for work.
        let listed = await (await get(harness.base, "/api/v1/runners", token)).json();
        for (let waited = 0; waited < 20_000; waited += 50) {
          listed = await (await get(harness.base, "/api/v1/runners", token)).json();
          const items = (listed as { items: ReadonlyArray<RunnerDetail> }).items;
          if (items[0]?.connectivity === "online") break;
          await delay(50);
        }
        const items = (listed as { items: ReadonlyArray<RunnerDetail> }).items;
        expect(items, JSON.stringify(listed)).toHaveLength(1);
        const runnerId = items[0]!.id;
        expect(items[0]!.connectivity).toBe("online");

        // What the drain does: the child is asked to stop, and it sends a
        // goodbye rather than just vanishing.
        child.kill("SIGTERM");
        expect(await child.exited).toBe(0);

        const row = await waitForRunner(
          harness.base,
          token,
          runnerId,
          (one) => one.connectivity === "offline",
        );
        expect(row.connectivity).toBe("offline");
        // Never `unreachable`: a runner that sends a goodbye was not lost.
        expect(await readStateTransitions(harness)).toEqual(["online", "offline"]);
      } finally {
        child.kill("SIGKILL");
      }
    });
    rmSync(home, { recursive: true, force: true });
  }, 60_000);
});

describe("retiring a runner with an open connection", () => {
  /** The close code for a connection the controller will not accept again. */
  const POLICY_VIOLATION = 1008;

  const retireRunner = (base: string, token: string, id: string): Promise<Response> =>
    send("POST", base, `/api/v1/runners/${id}/retire`, { body: {}, token });

  it("closes the open connection with the reason that the runner was retired", async () => {
    await withServer(async (harness) => {
      const token = await completeSetupWithNoProviderInstance(harness);
      const joined = await enlist(harness);
      const { wire } = await greet(harness.base, joined.credential);
      expect(
        (
          await waitForRunner(
            harness.base,
            token,
            joined.runnerId,
            (one) => one.connectivity === "online",
          )
        ).connectivity,
      ).toBe("online");

      const response = await retireRunner(harness.base, token, joined.runnerId);
      expect(response.status, await response.clone().text()).toBe(200);

      // Retiring revokes the credential, so the runner has to be told on its
      // open connection, not only when it next connects.
      const ending = await wire.closed();
      expect(ending.code).toBe(POLICY_VIOLATION);
      expect(ending.reason).toBe("RETIRED");
    });
  });

  it("rejects the retired credential at the upgrade, and says it was retired", async () => {
    await withServer(async (harness) => {
      const token = await completeSetupWithNoProviderInstance(harness);
      const joined = await enlist(harness);

      expect((await retireRunner(harness.base, token, joined.runnerId)).status).toBe(200);

      const revoked = await requestUpgrade(harness.base, `Bearer ${joined.credential}`);
      expect(revoked.status).toBe(401);
      const refusal = (await revoked.json()) as { error: { code: string; message: string } };
      expect(refusal.error.code).toBe("unauthenticated");
      // The runner holds a credential that was valid. It needs to be told to
      // `join` again, not left retrying a credential it thinks is unknown.
      expect(refusal.error.message).toContain("retired");
      expect(await tryDial(harness.base, `Bearer ${joined.credential}`)).toBe("refused");

      const stranger = await requestUpgrade(harness.base, "Bearer a-credential-nobody-was-issued");
      expect(stranger.status).toBe(401);
      const unknown = (await stranger.json()) as { error: { code: string; message: string } };
      expect(unknown.error.message).toContain("unknown credential");
      expect(unknown.error.message).not.toContain("retired");
    });
  });
});

describe("refreshing a runner's facts on demand", () => {
  // The default deadline is ten seconds, too long for a test, so these servers
  // get a shorter one, the same way `pings` is passed in.
  const FACTS_DEADLINE = Duration.millis(200);

  const refreshFacts = (base: string, token: string, id: string): Promise<Response> =>
    send("POST", base, `/api/v1/runners/${id}/refresh-facts`, { body: {}, token });

  /**
   * Takes the next frame and checks that it is a facts request. The frame was
   * already decoded with the protocol schema, so only its type is left to
   * check.
   */
  const expectFactsRequest = async (wire: Wire): Promise<void> => {
    const frame = await wire.next();
    expect(frame._tag, JSON.stringify(frame)).toBe("factsRequest");
  };

  /** The facts after `gh` was installed on the machine since its hello. */
  const GROWN: RunnerFacts = {
    ...FACTS,
    toolchains: [...FACTS.toolchains, { name: "gh", version: "2.99.0", path: "/usr/local/bin/gh" }],
  };

  it("asks the online runner, and returns the runner with the facts it reported", async () => {
    await withServer(async (harness) => {
      const token = await completeSetupWithNoProviderInstance(harness);
      const joined = await enlist(harness);
      const { wire } = await greet(harness.base, joined.credential);
      try {
        await waitForRunner(
          harness.base,
          token,
          joined.runnerId,
          (one) => one.connectivity === "online",
        );

        // The operation is still running while the runner answers: the request
        // is sent on the connection the controller already has.
        const pending = refreshFacts(harness.base, token, joined.runnerId);
        await expectFactsRequest(wire);
        wire.send({ _tag: "factsReport", facts: GROWN });

        const response = await pending;
        expect(response.status, await response.clone().text()).toBe(200);
        // The response is the runner after the report, not the runner as it
        // was when the button was pressed.
        const answered = (await response.json()) as RunnerDetail;
        expect(answered.id).toBe(joined.runnerId);
        expect(answered.facts).toEqual(GROWN);
        expect((await readRunner(harness.base, token, joined.runnerId)).facts).toEqual(GROWN);
      } finally {
        wire.close();
      }
    });
  });

  it("returns on a report with nothing new, rather than waiting for a change", async () => {
    await withServer(async (harness) => {
      const token = await completeSetupWithNoProviderInstance(harness);
      const joined = await enlist(harness);
      const { wire } = await greet(harness.base, joined.credential);
      try {
        await waitForRunner(
          harness.base,
          token,
          joined.runnerId,
          (one) => one.connectivity === "online",
        );

        const pending = refreshFacts(harness.base, token, joined.runnerId);
        await expectFactsRequest(wire);
        // The same facts the hello had. A controller that waited for the row to
        // change would wait forever on a machine where nothing changed, which
        // is most machines most of the time.
        wire.send({ _tag: "factsReport", facts: FACTS });

        const response = await pending;
        expect(response.status, await response.clone().text()).toBe(200);
        expect(((await response.json()) as RunnerDetail).facts).toEqual(FACTS);
      } finally {
        wire.close();
      }
    });
  });

  it("is not answered by a probe report whose request id guesses the facts key", async () => {
    await withServer(
      async (harness) => {
        const token = await completeSetupWithNoProviderInstance(harness);
        const joined = await enlist(harness);
        const { wire } = await greet(harness.base, joined.credential);
        try {
          await waitForRunner(
            harness.base,
            token,
            joined.runnerId,
            (one) => one.connectivity === "online",
          );

          const pending = refreshFacts(harness.base, token, joined.runnerId);
          await expectFactsRequest(wire);
          // A request id the controller never sent, guessing what the facts
          // wait might be keyed under. It wakes nothing, so the caller reaches
          // its deadline: a runner cannot answer a question it was not asked.
          wire.send({
            _tag: "probeReport",
            requestId: "facts",
            instanceId: "instance-claude-code",
            result: { harnessVersion: null, auth: { status: "unauthenticated" }, models: [] },
          });

          expect((await pending).status).toBe(409);
        } finally {
          wire.close();
        }
      },
      { factsDeadline: FACTS_DEADLINE },
    );
  });

  it("rejects a runner that is not online, and sends that connection nothing", async () => {
    await withServer(async (harness) => {
      const token = await completeSetupWithNoProviderInstance(harness);
      const joined = await enlist(harness);
      // A credential and a socket, but no hello: a connection exists, but the
      // other end is not yet a runner the controller can ask anything.
      const wire = await dial(harness.base, joined.credential);
      try {
        expect((await readRunner(harness.base, token, joined.runnerId)).connectivity).toBe(
          "offline",
        );

        const response = await refreshFacts(harness.base, token, joined.runnerId);
        expect(response.status, await response.clone().text()).toBe(409);
        expect(await response.json()).toMatchObject({ error: { code: "invalid_state" } });
        // Nothing was sent to it: a request on a connection that has not sent
        // a hello would be answered by whoever holds the credential.
        expect(wire.frames).toEqual([]);
      } finally {
        wire.close();
      }
    });
  });

  it("answers two callers waiting at once with the same report", async () => {
    await withServer(async (harness) => {
      const token = await completeSetupWithNoProviderInstance(harness);
      const joined = await enlist(harness);
      const { wire } = await greet(harness.base, joined.credential);
      try {
        await waitForRunner(
          harness.base,
          token,
          joined.runnerId,
          (one) => one.connectivity === "online",
        );

        // Two presses of the same button. Neither may be told the runner did
        // not answer just because the other caller got the report.
        const both = [
          refreshFacts(harness.base, token, joined.runnerId),
          refreshFacts(harness.base, token, joined.runnerId),
        ];
        await expectFactsRequest(wire);
        wire.send({ _tag: "factsReport", facts: GROWN });

        for (const response of await Promise.all(both)) {
          expect(response.status, await response.clone().text()).toBe(200);
          expect(((await response.json()) as RunnerDetail).facts).toEqual(GROWN);
        }
      } finally {
        wire.close();
      }
    });
  });

  it("answers a caller still waiting when the report arrives after another caller timed out", async () => {
    await withServer(
      async (harness) => {
        const token = await completeSetupWithNoProviderInstance(harness);
        const joined = await enlist(harness);
        const { wire } = await greet(harness.base, joined.credential);
        try {
          await waitForRunner(
            harness.base,
            token,
            joined.runnerId,
            (one) => one.connectivity === "online",
          );

          const early = refreshFacts(harness.base, token, joined.runnerId);
          await expectFactsRequest(wire);
          // Long enough that the second caller still has time left when the
          // first times out.
          await delay(700);
          const late = refreshFacts(harness.base, token, joined.runnerId);
          expect((await early).status).toBe(409);

          wire.send({ _tag: "factsReport", facts: GROWN });
          const answered = await late;
          expect(answered.status, await answered.clone().text()).toBe(200);
          expect(((await answered.json()) as RunnerDetail).facts).toEqual(GROWN);
          // The first caller's timeout did not remove the wait: the second
          // caller shared it and got the report.
          expect(wire.frames.filter((frame) => frame._tag === "factsRequest")).toHaveLength(2);
        } finally {
          wire.close();
        }
      },
      { factsDeadline: Duration.seconds(1) },
    );
  });

  it("sends a new request after one that was never answered, and the next report arrives", async () => {
    await withServer(
      async (harness) => {
        const token = await completeSetupWithNoProviderInstance(harness);
        const joined = await enlist(harness);
        const { wire } = await greet(harness.base, joined.credential);
        try {
          await waitForRunner(
            harness.base,
            token,
            joined.runnerId,
            (one) => one.connectivity === "online",
          );

          // The runner does not answer the first request, and the caller times
          // out with no report.
          const abandoned = await refreshFacts(harness.base, token, joined.runnerId);
          expect(abandoned.status).toBe(409);
          await expectFactsRequest(wire);

          // Pressing the button again has to reach the runner. A request the
          // runner never answered is not still in flight.
          const again = refreshFacts(harness.base, token, joined.runnerId);
          await expectFactsRequest(wire);
          wire.send({ _tag: "factsReport", facts: GROWN });

          const answered = await again;
          expect(answered.status, await answered.clone().text()).toBe(200);
          expect(((await answered.json()) as RunnerDetail).facts).toEqual(GROWN);
          expect(wire.frames.filter((frame) => frame._tag === "factsRequest")).toHaveLength(2);
        } finally {
          wire.close();
        }
      },
      { factsDeadline: FACTS_DEADLINE },
    );
  });

  it("fails for a runner that never reports, and says how long it waited", async () => {
    await withServer(
      async (harness) => {
        const token = await completeSetupWithNoProviderInstance(harness);
        const joined = await enlist(harness);
        const { wire } = await greet(harness.base, joined.credential);
        try {
          await waitForRunner(
            harness.base,
            token,
            joined.runnerId,
            (one) => one.connectivity === "online",
          );

          const pending = refreshFacts(harness.base, token, joined.runnerId);
          // The frame is sent, and the runner sends nothing back.
          await expectFactsRequest(wire);

          const response = await pending;
          expect(response.status, await response.clone().text()).toBe(409);
          const refusal = (await response.json()) as { error: { code: string; message: string } };
          expect(refusal.error.code).toBe("invalid_state");
          // The error message says how long the controller waited, so a slow
          // runner looks different from a broken one. It uses this server's
          // deadline, not the default.
          expect(refusal.error.message).toContain(Duration.format(FACTS_DEADLINE));
          // A runner that did not answer did not update its facts either.
          expect((await readRunner(harness.base, token, joined.runnerId)).facts).toEqual(FACTS);
        } finally {
          wire.close();
        }
      },
      { factsDeadline: FACTS_DEADLINE },
    );
  });
});

/**
 * Runs `body` against a server with the real plugin registry, so "one request
 * per instance" covers the three providers the binary really includes. The
 * probe deadline and interval are passed in like the ping interval, because a
 * real Bun server cannot run on a `TestClock`.
 */
const withRegistry = (
  body: (harness: ServerHarness) => Promise<void>,
  options: Parameters<typeof withServer>[1] = {},
): Promise<void> => withServer(body, { ...options, plugins: registry });

interface Instance {
  readonly id: string;
  readonly providerId: string;
  readonly snapshots: ReadonlyArray<{
    readonly runnerId: string;
    readonly harnessVersion: string | null;
    readonly auth: { readonly status: string; readonly message?: string };
    readonly models: ReadonlyArray<{ readonly slug: string }>;
  }>;
}

const listInstances = async (base: string, token: string): Promise<ReadonlyArray<Instance>> => {
  const response = await get(base, "/api/v1/providers", token);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as ReadonlyArray<Instance>;
};

const findInstanceFor = async (
  base: string,
  token: string,
  providerId: string,
): Promise<Instance> => {
  const found = (await listInstances(base, token)).find((one) => one.providerId === providerId);
  expect(found, `no instance for ${providerId}`).toBeDefined();
  return found!;
};

const buildProbeResult = (version: string): ProbeResult => ({
  harnessVersion: version,
  auth: {
    status: "ok",
    identity: "rogier@example.com",
    planLabel: "Claude Max",
    backend: "firstParty",
  },
  models: [{ slug: "default", name: "Default", imageInput: { maxBytes: null }, options: [] }],
});

describe("probing a runner's provider instances", () => {
  const readSnapshot = (
    base: string,
    token: string,
    instanceId: string,
    runnerId: string,
  ): Promise<Instance["snapshots"][number]> =>
    waitUntil(`recorded a snapshot of ${instanceId}`, async () => {
      const response = await get(base, `/api/v1/providers/${instanceId}`, token);
      expect(response.status, await response.clone().text()).toBe(200);
      const one = (await response.json()) as Instance;
      return one.snapshots.find((each) => each.runnerId === runnerId);
    });

  const waitForProbeRequests = (wire: Wire, count: number): Promise<ReadonlyArray<ProbeRequest>> =>
    waitUntil(`asked for ${String(count)} probes`, () => {
      const asked = listProbeRequests(wire);
      return asked.length >= count ? asked : undefined;
    });

  const buildNoAdapterResult = (providerId: string): ProbeResult => ({
    harnessVersion: null,
    auth: { status: "error", message: `no adapter for ${providerId} in this runner build` },
    models: [],
  });

  const probeNow = (base: string, token: string, id: string, instanceId: string) =>
    send("POST", base, `/api/v1/runners/${id}/probe`, { body: { instanceId }, token });

  const patchInstance = (base: string, token: string, id: string, body: unknown) =>
    send("PATCH", base, `/api/v1/providers/${id}`, { body, token });

  /** A probe deadline short enough for a test to wait for. */
  const PROBE_DEADLINE = Duration.millis(200);

  it("probes every instance as soon as the runner sends its hello, and stores the answers", async () => {
    await withRegistry(async (harness) => {
      const token = await completeSetup(harness.base);
      const joined = await enlist(harness);
      const all = await listInstances(harness.base, token);
      // The three built-in providers, each with the instance the boot created.
      expect(all.map((one) => one.providerId).sort()).toEqual(["claude-code", "codex", "pi"]);

      const { wire } = await greet(harness.base, joined.credential);
      try {
        const asked = await waitForProbeRequests(wire, all.length);
        // One request per instance, keyed by instance id, never provider id:
        // one provider can have several accounts.
        expect([...asked].map((request) => request.instanceId).sort()).toEqual(
          [...all].map((one) => one.id).sort(),
        );
        for (const request of asked) {
          const instance = all.find((one) => one.id === request.instanceId);
          expect(request.providerId).toBe(instance?.providerId);
        }

        for (const request of asked) {
          const instance = all.find((one) => one.id === request.instanceId)!;
          wire.send({
            _tag: "probeReport",
            requestId: request.requestId,
            instanceId: request.instanceId,
            result:
              instance.providerId === "claude-code"
                ? buildProbeResult("2.1.263")
                : buildNoAdapterResult(instance.providerId),
          });
        }

        const claude = await findInstanceFor(harness.base, token, "claude-code");
        const snapshot = await readSnapshot(harness.base, token, claude.id, joined.runnerId);
        expect(snapshot.harnessVersion).toBe("2.1.263");
        expect(snapshot.auth).toMatchObject({ status: "ok", identity: "rogier@example.com" });
        expect(snapshot.models.map((model) => model.slug)).toEqual(["default"]);

        // A provider this runner build has no adapter for still gets a
        // snapshot, which shows why, instead of staying blank forever.
        const codex = await findInstanceFor(harness.base, token, "codex");
        const refused = await readSnapshot(harness.base, token, codex.id, joined.runnerId);
        expect(refused.auth.status).toBe("error");
        expect(refused.auth.message).toBe("no adapter for codex in this runner build");
      } finally {
        wire.close();
      }
    });
  });

  it("probes every online runner again when an instance's config changes", async () => {
    await withRegistry(async (harness) => {
      const token = await completeSetup(harness.base);
      const first = await enlist(harness);
      const second = await enlist(harness);
      const all = await listInstances(harness.base, token);
      const claude = all.find((one) => one.providerId === "claude-code")!;

      const one = await greet(harness.base, first.credential);
      const two = await greet(harness.base, second.credential);
      try {
        await waitForProbeRequests(one.wire, all.length);
        await waitForProbeRequests(two.wire, all.length);
        const before = [listProbeRequests(one.wire).length, listProbeRequests(two.wire).length];

        const patched = await patchInstance(harness.base, token, claude.id, {
          name: "work account",
        });
        expect(patched.status, await patched.clone().text()).toBe(200);

        // The probe runs with the config, so every snapshot of the instance is
        // now out of date.
        await waitForProbeRequests(one.wire, before[0]! + 1);
        await waitForProbeRequests(two.wire, before[1]! + 1);
        for (const wire of [one.wire, two.wire]) {
          expect(listProbeRequests(wire).at(-1)?.instanceId).toBe(claude.id);
        }
      } finally {
        one.wire.close();
        two.wire.close();
      }
    });
  });

  it("probes on demand and returns the snapshot from the report", async () => {
    await withRegistry(async (harness) => {
      const token = await completeSetup(harness.base);
      const joined = await enlist(harness);
      const claude = await findInstanceFor(harness.base, token, "claude-code");
      const { wire } = await greet(harness.base, joined.credential);
      try {
        const opening = await waitForProbeRequests(wire, 3);
        const already = opening.length;

        const pending = probeNow(harness.base, token, joined.runnerId, claude.id);
        const asked = await waitForProbeRequests(wire, already + 1);
        const request = asked.at(-1)!;
        expect(request.instanceId).toBe(claude.id);
        wire.send({
          _tag: "probeReport",
          requestId: request.requestId,
          instanceId: claude.id,
          result: buildProbeResult("2.1.300"),
        });

        const response = await pending;
        expect(response.status, await response.clone().text()).toBe(200);
        const answered = (await response.json()) as Instance["snapshots"][number];
        expect(answered.runnerId).toBe(joined.runnerId);
        expect(answered.harnessVersion).toBe("2.1.300");
      } finally {
        wire.close();
      }
    });
  });

  it("rejects probing a runner that is not online, and sends that connection nothing", async () => {
    await withRegistry(async (harness) => {
      const token = await completeSetup(harness.base);
      const joined = await enlist(harness);
      const claude = await findInstanceFor(harness.base, token, "claude-code");
      // A socket with no hello: it has not identified itself as a runner yet.
      const wire = await dial(harness.base, joined.credential);
      try {
        const response = await probeNow(harness.base, token, joined.runnerId, claude.id);
        expect(response.status, await response.clone().text()).toBe(409);
        expect(await response.json()).toMatchObject({ error: { code: "invalid_state" } });
        expect(wire.frames).toEqual([]);
      } finally {
        wire.close();
      }
    });
  });

  it("fails for a runner that never answers a probe, and says how long it waited", async () => {
    await withRegistry(
      async (harness) => {
        const token = await completeSetup(harness.base);
        const joined = await enlist(harness);
        const claude = await findInstanceFor(harness.base, token, "claude-code");
        const { wire } = await greet(harness.base, joined.credential);
        try {
          const already = (await waitForProbeRequests(wire, 3)).length;

          const response = await probeNow(harness.base, token, joined.runnerId, claude.id);
          await waitForProbeRequests(wire, already + 1);

          expect(response.status, await response.clone().text()).toBe(409);
          const refusal = (await response.json()) as { error: { code: string; message: string } };
          expect(refusal.error.code).toBe("invalid_state");
          expect(refusal.error.message).toContain(Duration.format(PROBE_DEADLINE));
        } finally {
          wire.close();
        }
      },
      { probeDeadline: PROBE_DEADLINE },
    );
  });

  it("ignores a report nobody asked for", async () => {
    await withRegistry(async (harness) => {
      const token = await completeSetup(harness.base);
      const joined = await enlist(harness);
      const claude = await findInstanceFor(harness.base, token, "claude-code");
      const { wire } = await greet(harness.base, joined.credential);
      try {
        const asked = await waitForProbeRequests(wire, 3);
        const mine = asked.find((request) => request.instanceId === claude.id)!;

        // A request id this controller never sent. Storing it would let a
        // runner write any instance's snapshot at any time.
        wire.send({
          _tag: "probeReport",
          requestId: "01999999-0000-7000-8000-00000000dead",
          instanceId: claude.id,
          result: buildProbeResult("0.0.0-unasked"),
        });
        // Then the real answer, so the test waits for an event rather than for
        // a fixed time.
        wire.send({
          _tag: "probeReport",
          requestId: mine.requestId,
          instanceId: claude.id,
          result: buildProbeResult("2.1.263"),
        });

        const snapshot = await readSnapshot(harness.base, token, claude.id, joined.runnerId);
        expect(snapshot.harnessVersion).toBe("2.1.263");
      } finally {
        wire.close();
      }
    });
  });

  it("ignores a report from the connection a runner has already replaced", async () => {
    await withRegistry(async (harness) => {
      const token = await completeSetup(harness.base);
      const joined = await enlist(harness);
      const claude = await findInstanceFor(harness.base, token, "claude-code");
      const first = await greet(harness.base, joined.credential);
      const asked = await waitForProbeRequests(first.wire, 3);
      const stale = asked.find((request) => request.instanceId === claude.id)!;

      const second = await greet(harness.base, joined.credential);
      try {
        first.wire.send({
          _tag: "probeReport",
          requestId: stale.requestId,
          instanceId: claude.id,
          result: buildProbeResult("0.0.0-superseded"),
        });

        const fresh = await waitForProbeRequests(second.wire, 3);
        const current = fresh.find((request) => request.instanceId === claude.id)!;
        second.wire.send({
          _tag: "probeReport",
          requestId: current.requestId,
          instanceId: claude.id,
          result: buildProbeResult("2.1.263"),
        });

        const snapshot = await readSnapshot(harness.base, token, claude.id, joined.runnerId);
        expect(snapshot.harnessVersion).toBe("2.1.263");
      } finally {
        first.wire.close();
        second.wire.close();
      }
    });
  });

  it("freezes without waiting for a probe's answer, and stores the answer once the transfer is cancelled", async () => {
    await withRegistry(async (harness) => {
      const token = await completeSetup(harness.base);
      const joined = await enlist(harness);
      const claude = await findInstanceFor(harness.base, token, "claude-code");
      const { wire } = await greet(harness.base, joined.credential);
      try {
        const asked = await waitForProbeRequests(wire, 3);
        const request = asked.find((one) => one.instanceId === claude.id)!;

        // The probes are unanswered, and their deadline is the default 20
        // seconds. The freeze must not wait for them.
        const promotionToken = await freezeController(harness.base, token);

        wire.send({
          _tag: "probeReport",
          requestId: request.requestId,
          instanceId: claude.id,
          result: buildProbeResult("2.1.263"),
        });
        await delay(QUIET_MS);
        const frozen = (await (
          await get(harness.base, `/api/v1/providers/${claude.id}`, token)
        ).json()) as Instance;
        expect(frozen.snapshots, "a frozen controller stores no snapshot").toEqual([]);

        await thaw(harness.base, promotionToken);
        const snapshot = await readSnapshot(harness.base, token, claude.id, joined.runnerId);
        expect(snapshot.harnessVersion).toBe("2.1.263");
      } finally {
        wire.close();
      }
    });
  });

  it("probes every instance of every online runner again on the interval", async () => {
    const INTERVAL = Duration.millis(150);
    await withRegistry(
      async (harness) => {
        const token = await completeSetup(harness.base);
        const joined = await enlist(harness);
        const all = await listInstances(harness.base, token);
        const { wire } = await greet(harness.base, joined.credential);
        try {
          // The probes after the hello, then the tick's: every instance again,
          // not just the one somebody last looked at.
          await waitForProbeRequests(wire, all.length * 2);
          const second = listProbeRequests(wire).slice(all.length, all.length * 2);
          expect([...second].map((request) => request.instanceId).sort()).toEqual(
            [...all].map((one) => one.id).sort(),
          );
        } finally {
          wire.close();
        }
      },
      { probeInterval: INTERVAL },
    );
  });
});

describe("installing a harness on a runner", () => {
  const BARE: RunnerFacts = {
    ...FACTS,
    providers: [
      { name: "claude", present: false },
      { name: "codex", present: false },
      { name: "pi", present: false },
    ],
  };

  const INSTALLED: RunnerFacts = {
    ...BARE,
    providers: [
      { name: "claude", present: true, path: "/root/.local/bin/claude" },
      { name: "codex", present: false },
      { name: "pi", present: false },
    ],
  };

  const installHarness = (base: string, token: string, id: string, providerId: string) =>
    send("POST", base, `/api/v1/runners/${id}/install-harness`, { body: { providerId }, token });

  it("runs the installer, stores the facts the runner then reports, and probes the harness", async () => {
    await withRegistry(async (harness) => {
      const token = await completeSetup(harness.base);
      const joined = await enlist(harness);
      const { wire } = await greet(harness.base, joined.credential, { facts: BARE });
      try {
        await waitForRunner(
          harness.base,
          token,
          joined.runnerId,
          (one) => one.connectivity === "online",
        );
        const providers = await get(harness.base, "/api/v1/providers", token);
        const claude = (
          (await providers.json()) as ReadonlyArray<{
            id: string;
            providerId: string;
          }>
        ).find((one) => one.providerId === "claude-code")!;
        const before = listProbeRequests(wire).length;

        const pending = installHarness(harness.base, token, joined.runnerId, "claude-code");
        const request = await waitForFrame<InstallRequest>(wire, "installRequest");
        expect(request.providerId).toBe("claude-code");
        // The runner reports its new facts, then reports that the install
        // finished: the response must not show the machine as it was before.
        wire.send({ _tag: "factsReport", facts: INSTALLED });
        wire.send({ _tag: "installResult", requestId: request.requestId, ok: true });

        const response = await pending;
        expect(response.status, await response.clone().text()).toBe(200);
        const row = (await response.json()) as RunnerDetail;
        expect(row.facts?.providers).toEqual(INSTALLED.providers);

        // A harness that was just installed has never been probed.
        await waitUntil("probed after the install", () => listProbeRequests(wire)[before]);
        expect(
          listProbeRequests(wire)
            .slice(before)
            .map((one) => one.instanceId),
        ).toContain(claude.id);
      } finally {
        wire.close();
      }
    });
  });

  it("returns the installer's error message when it failed, and leaves the facts unchanged", async () => {
    await withRegistry(async (harness) => {
      const token = await completeSetup(harness.base);
      const joined = await enlist(harness);
      const { wire } = await greet(harness.base, joined.credential, { facts: BARE });
      try {
        await waitForRunner(
          harness.base,
          token,
          joined.runnerId,
          (one) => one.connectivity === "online",
        );

        const pending = installHarness(harness.base, token, joined.runnerId, "claude-code");
        const request = await waitForFrame<InstallRequest>(wire, "installRequest");
        wire.send({
          _tag: "installResult",
          requestId: request.requestId,
          ok: false,
          message: "install.sh: could not download the manifest",
        });

        const response = await pending;
        expect(response.status, await response.clone().text()).toBe(409);
        const refusal = (await response.json()) as { error: { code: string; message: string } };
        expect(refusal.error.code).toBe("invalid_state");
        // The installer's own message: "the install failed" is not something
        // an operator can act on.
        expect(refusal.error.message).toContain("could not download the manifest");
        expect((await readRunner(harness.base, token, joined.runnerId)).facts).toEqual(BARE);
      } finally {
        wire.close();
      }
    });
  });

  it("rejects a harness this runner build has no adapter for, before asking the runner", async () => {
    await withRegistry(async (harness) => {
      const token = await completeSetup(harness.base);
      const joined = await enlist(harness);
      const { wire } = await greet(harness.base, joined.credential, { facts: BARE });
      try {
        await waitForRunner(
          harness.base,
          token,
          joined.runnerId,
          (one) => one.connectivity === "online",
        );

        const response = await installHarness(harness.base, token, joined.runnerId, "codex");
        expect(response.status, await response.clone().text()).toBe(400);
        expect(await response.json()).toMatchObject({ error: { code: "validation" } });
        // The runner's hello already listed the adapters its build has.
        expect(wire.frames.filter((frame) => frame._tag === "installRequest")).toEqual([]);
      } finally {
        wire.close();
      }
    });
  });

  it("rejects installing on a runner that is not online", async () => {
    await withRegistry(async (harness) => {
      const token = await completeSetup(harness.base);
      const joined = await enlist(harness);
      const wire = await dial(harness.base, joined.credential);
      try {
        const response = await installHarness(harness.base, token, joined.runnerId, "claude-code");
        expect(response.status, await response.clone().text()).toBe(409);
        expect(await response.json()).toMatchObject({ error: { code: "invalid_state" } });
        expect(wire.frames).toEqual([]);
      } finally {
        wire.close();
      }
    });
  });
});

/**
 * Nothing about a login is stored (the code is only valid for the running
 * login's URL), so these tests check the frames and the errors, not a stored
 * record.
 */
describe("logging a runner's provider instance in", () => {
  const startLogin = (base: string, token: string, instanceId: string, runnerId: string) =>
    send("POST", base, `/api/v1/providers/${instanceId}/login`, { body: { runnerId }, token });

  const submitCode = (
    base: string,
    token: string,
    instanceId: string,
    body: { readonly runnerId: string; readonly code: string },
  ) => send("POST", base, `/api/v1/providers/${instanceId}/login-code`, { body, token });

  const waitForProbe = (wire: Wire, instanceId: string, after: number): Promise<ProbeRequest> =>
    waitUntil(`probed ${instanceId}`, () =>
      wire.frames
        .slice(after)
        .find(
          (frame): frame is ProbeRequest =>
            frame._tag === "probeRequest" && frame.instanceId === instanceId,
        ),
    );

  const AUTHORIZE_URL = "https://claude.ai/oauth/authorize?code=challenge";

  const DEVICE_URL = "https://auth.openai.com/codex/device";

  /** A login deadline short enough for a test to wait for. */
  const LOGIN_DEADLINE = Duration.millis(200);

  it("asks the runner to start a login and returns the URL it printed", async () => {
    await withRegistry(async (harness) => {
      const token = await completeSetup(harness.base);
      const joined = await enlist(harness);
      const claude = await findInstanceFor(harness.base, token, "claude-code");
      const { wire } = await greet(harness.base, joined.credential);
      try {
        const pending = startLogin(harness.base, token, claude.id, joined.runnerId);
        const request = await waitForFrame<LoginStart>(wire, "loginStart");
        // Keyed by instance, because the credential is stored in the
        // instance's own config directory.
        expect(request.instanceId).toBe(claude.id);
        expect(request.providerId).toBe("claude-code");
        wire.send({ _tag: "loginUrl", requestId: request.requestId, url: AUTHORIZE_URL });

        const response = await pending;
        expect(response.status, await response.clone().text()).toBe(200);
        expect(await response.json()).toEqual({ url: AUTHORIZE_URL });
      } finally {
        wire.close();
      }
    });
  });

  it("returns the one-time code when the runner printed one instead of prompting", async () => {
    await withRegistry(async (harness) => {
      const token = await completeSetup(harness.base);
      const joined = await enlist(harness);
      const claude = await findInstanceFor(harness.base, token, "claude-code");
      const { wire } = await greet(harness.base, joined.credential);
      try {
        const pending = startLogin(harness.base, token, claude.id, joined.runnerId);
        const request = await waitForFrame<LoginStart>(wire, "loginStart");
        // A device login shows the user a code to type in the browser; there
        // is nothing for them to paste back here.
        wire.send({
          _tag: "loginUrl",
          requestId: request.requestId,
          url: DEVICE_URL,
          userCode: "CH61-0FI2N",
        });

        const response = await pending;
        expect(response.status, await response.clone().text()).toBe(200);
        expect(await response.json()).toEqual({ url: DEVICE_URL, userCode: "CH61-0FI2N" });
      } finally {
        wire.close();
      }
    });
  });

  it("returns when the one-time code expires, counted from the lifetime the runner sent", async () => {
    await withRegistry(async (harness) => {
      const token = await completeSetup(harness.base);
      const joined = await enlist(harness);
      const claude = await findInstanceFor(harness.base, token, "claude-code");
      const { wire } = await greet(harness.base, joined.credential);
      try {
        const pending = startLogin(harness.base, token, claude.id, joined.runnerId);
        const request = await waitForFrame<LoginStart>(wire, "loginStart");
        const sentAt = Date.now();
        wire.send({
          _tag: "loginUrl",
          requestId: request.requestId,
          url: DEVICE_URL,
          userCode: "CH61-0FI2N",
          expiresInSeconds: 900,
        });

        const response = await pending;
        expect(response.status, await response.clone().text()).toBe(200);
        const started = (await response.json()) as { expiresAt: string };
        // The instant is the controller's own: when the answer arrived, plus
        // the lifetime, so the runner's clock plays no part in it.
        const expiresAt = Date.parse(started.expiresAt);
        expect(expiresAt).toBeGreaterThanOrEqual(sentAt + 900_000);
        expect(expiresAt).toBeLessThanOrEqual(Date.now() + 900_000);
      } finally {
        wire.close();
      }
    });
  });

  it("offers the login-ended frame at hello", async () => {
    await withRegistry(async (harness) => {
      const joined = await enlist(harness);
      const { wire, answer } = await greet(harness.base, joined.credential);
      try {
        expect(answer.capabilities).toContain(LOGIN_ENDED_CAPABILITY);
      } finally {
        wire.close();
      }
    });
  });

  /**
   * Starts a device login on the runner, answers it the way the runner does,
   * and returns the login's request id once the controller answered the
   * caller. `nth` is the index of this login's `loginStart` among those the
   * wire has received.
   */
  const startDeviceLogin = async (
    harness: ServerHarness,
    token: string,
    login: { readonly instanceId: string; readonly runnerId: string; readonly wire: Wire },
    nth = 0,
  ): Promise<string> => {
    const pending = startLogin(harness.base, token, login.instanceId, login.runnerId);
    const request = await waitForFrame<LoginStart>(login.wire, "loginStart", nth);
    login.wire.send({
      _tag: "loginUrl",
      requestId: request.requestId,
      url: DEVICE_URL,
      userCode: "CH61-0FI2N",
    });
    const response = await pending;
    expect(response.status, await response.clone().text()).toBe(200);
    return request.requestId;
  };

  const answerProbe = (wire: Wire, probe: ProbeRequest): void => {
    wire.send({
      _tag: "probeReport",
      requestId: probe.requestId,
      instanceId: probe.instanceId,
      result: buildProbeResult("2.1.263"),
    });
  };

  const countProbes = (wire: Wire, instanceId: string): number =>
    wire.frames.filter((frame) => frame._tag === "probeRequest" && frame.instanceId === instanceId)
      .length;

  /** A runner that can drive Codex too, whose instance serves as a second, independent login. */
  const TWO_ADAPTERS: Partial<RunnerHello> = {
    facts: {
      ...FACTS,
      providers: [
        ...FACTS.providers,
        { name: "codex", present: true, path: "/usr/local/bin/codex" },
      ],
      adapters: ["claude-code", "codex"],
    },
  };

  /**
   * Runs a device login on the Codex instance to its end and waits for the
   * probe that end causes. The frames the controller handled before it have
   * then been handled, so a probe they would have caused has been sent.
   */
  const settleCodexLogin = async (
    harness: ServerHarness,
    token: string,
    login: { readonly instanceId: string; readonly runnerId: string; readonly wire: Wire },
    nth: number,
  ): Promise<void> => {
    const before = login.wire.frames.length;
    const requestId = await startDeviceLogin(harness, token, login, nth);
    login.wire.send({ _tag: "loginEnded", requestId });
    answerProbe(login.wire, await waitForProbe(login.wire, login.instanceId, before));
  };

  it("probes the instance again on that runner when a device login ends", async () => {
    await withRegistry(async (harness) => {
      const token = await completeSetup(harness.base);
      const joined = await enlist(harness);
      const claude = await findInstanceFor(harness.base, token, "claude-code");
      const { wire } = await greet(harness.base, joined.credential);
      try {
        // Let the probe every connection starts go out first, so the one
        // awaited below can only be the one the frame caused.
        await waitForProbe(wire, claude.id, 0);
        const requestId = await startDeviceLogin(harness, token, {
          instanceId: claude.id,
          runnerId: joined.runnerId,
          wire,
        });
        const before = wire.frames.length;

        wire.send({ _tag: "loginEnded", requestId });

        answerProbe(wire, await waitForProbe(wire, claude.id, before));
        // The probe stores the snapshot, which announces it on the provider
        // topic; a screen waiting on the login reads it from there.
        await waitUntil("recorded the logged-in snapshot", async () => {
          const response = await get(harness.base, `/api/v1/providers/${claude.id}`, token);
          const one = (await response.json()) as Instance;
          return one.snapshots.find(
            (each) => each.runnerId === joined.runnerId && each.auth.status === "ok",
          );
        });
      } finally {
        wire.close();
      }
    });
  });

  it("ignores the end of a login it did not start, and keeps the connection", async () => {
    await withRegistry(async (harness) => {
      const token = await completeSetup(harness.base);
      const joined = await enlist(harness);
      const claude = await findInstanceFor(harness.base, token, "claude-code");
      const codex = await findInstanceFor(harness.base, token, "codex");
      const { wire } = await greet(harness.base, joined.credential, TWO_ADAPTERS);
      try {
        await waitForProbe(wire, claude.id, 0);
        // A runner cannot make the controller probe whenever it likes. The
        // report is not a protocol error either: the Codex login below runs
        // over the same connection.
        wire.send({ _tag: "loginEnded", requestId: crypto.randomUUID() });

        await settleCodexLogin(
          harness,
          token,
          { instanceId: codex.id, runnerId: joined.runnerId, wire },
          0,
        );

        expect(countProbes(wire, claude.id)).toBe(1);
      } finally {
        wire.close();
      }
    });
  });

  it("ignores the end of a login that another runner reports", async () => {
    await withRegistry(async (harness) => {
      const token = await completeSetup(harness.base);
      const joined = await enlist(harness);
      const other = await enlist(harness);
      const claude = await findInstanceFor(harness.base, token, "claude-code");
      const { wire } = await greet(harness.base, joined.credential);
      const intruder = await greet(harness.base, other.credential);
      try {
        await waitForProbe(wire, claude.id, 0);
        await waitForProbe(intruder.wire, claude.id, 0);
        const requestId = await startDeviceLogin(harness, token, {
          instanceId: claude.id,
          runnerId: joined.runnerId,
          wire,
        });
        const before = wire.frames.length;

        // Had the other runner's report been read, it would have used up the
        // login, and the report from the login's own runner would cause no
        // probe.
        intruder.wire.send({ _tag: "loginEnded", requestId });
        wire.send({ _tag: "loginEnded", requestId });

        answerProbe(wire, await waitForProbe(wire, claude.id, before));
        expect(countProbes(intruder.wire, claude.id)).toBe(1);
      } finally {
        wire.close();
        intruder.wire.close();
      }
    });
  });

  it("probes once for one login, however often the runner reports its end", async () => {
    await withRegistry(async (harness) => {
      const token = await completeSetup(harness.base);
      const joined = await enlist(harness);
      const claude = await findInstanceFor(harness.base, token, "claude-code");
      const codex = await findInstanceFor(harness.base, token, "codex");
      const { wire } = await greet(harness.base, joined.credential, TWO_ADAPTERS);
      try {
        await waitForProbe(wire, claude.id, 0);
        const requestId = await startDeviceLogin(harness, token, {
          instanceId: claude.id,
          runnerId: joined.runnerId,
          wire,
        });
        const before = wire.frames.length;
        wire.send({ _tag: "loginEnded", requestId });
        answerProbe(wire, await waitForProbe(wire, claude.id, before));

        wire.send({ _tag: "loginEnded", requestId });
        await settleCodexLogin(
          harness,
          token,
          { instanceId: codex.id, runnerId: joined.runnerId, wire },
          1,
        );

        // The probe every connection starts, and the one the first report caused.
        expect(countProbes(wire, claude.id)).toBe(2);
      } finally {
        wire.close();
      }
    });
  });

  it("runs one probe at a time per instance, and one more for a login that ended during it", async () => {
    await withRegistry(async (harness) => {
      const token = await completeSetup(harness.base);
      const joined = await enlist(harness);
      const claude = await findInstanceFor(harness.base, token, "claude-code");
      const codex = await findInstanceFor(harness.base, token, "codex");
      const { wire } = await greet(harness.base, joined.credential, TWO_ADAPTERS);
      const login = { instanceId: claude.id, runnerId: joined.runnerId, wire };
      const sentinel = { instanceId: codex.id, runnerId: joined.runnerId, wire };
      try {
        await waitForProbe(wire, claude.id, 0);
        const firstLogin = await startDeviceLogin(harness, token, login, 0);
        let before = wire.frames.length;
        wire.send({ _tag: "loginEnded", requestId: firstLogin });
        // Held unanswered, so the next login ends while this probe runs.
        const first = await waitForProbe(wire, claude.id, before);

        const secondLogin = await startDeviceLogin(harness, token, login, 1);
        wire.send({ _tag: "loginEnded", requestId: secondLogin });
        await settleCodexLogin(harness, token, sentinel, 2);
        expect(countProbes(wire, claude.id)).toBe(2);

        // The first probe may have read the state from before the second
        // login, so one more probe follows it.
        before = wire.frames.length;
        answerProbe(wire, first);
        answerProbe(wire, await waitForProbe(wire, claude.id, before));

        await settleCodexLogin(harness, token, sentinel, 3);
        expect(countProbes(wire, claude.id)).toBe(3);
      } finally {
        wire.close();
      }
    });
  });

  it("probes when a login ends that replaced a login which then failed", async () => {
    await withRegistry(async (harness) => {
      const token = await completeSetup(harness.base);
      const joined = await enlist(harness);
      const claude = await findInstanceFor(harness.base, token, "claude-code");
      const codex = await findInstanceFor(harness.base, token, "codex");
      const { wire } = await greet(harness.base, joined.credential, TWO_ADAPTERS);
      try {
        await waitForProbe(wire, claude.id, 0);
        const pendingFirst = startLogin(harness.base, token, claude.id, joined.runnerId);
        const first = await waitForFrame<LoginStart>(wire, "loginStart", 0);
        const pendingSecond = startLogin(harness.base, token, claude.id, joined.runnerId);
        const second = await waitForFrame<LoginStart>(wire, "loginStart", 1);

        // The runner stops the first login to start the second, so the first
        // fails only after the controller began waiting for the second's end.
        wire.send({
          _tag: "loginFailed",
          requestId: first.requestId,
          message: "the login ended without a URL",
        });
        const failed = await pendingFirst;
        expect(failed.status, await failed.clone().text()).toBe(409);
        wire.send({
          _tag: "loginUrl",
          requestId: second.requestId,
          url: DEVICE_URL,
          userCode: "CH61-0FI2N",
        });
        const started = await pendingSecond;
        expect(started.status, await started.clone().text()).toBe(200);
        const before = wire.frames.length;

        wire.send({ _tag: "loginEnded", requestId: second.requestId });

        answerProbe(wire, await waitForProbe(wire, claude.id, before));
        await settleCodexLogin(
          harness,
          token,
          { instanceId: codex.id, runnerId: joined.runnerId, wire },
          2,
        );
        // The probe every connection starts, and the one the second login's end caused.
        expect(countProbes(wire, claude.id)).toBe(2);
      } finally {
        wire.close();
      }
    });
  });

  it("probes when a device login ends after a newer login on it was refused", async () => {
    await withRegistry(async (harness) => {
      const token = await completeSetup(harness.base);
      const joined = await enlist(harness);
      const claude = await findInstanceFor(harness.base, token, "claude-code");
      const { wire } = await greet(harness.base, joined.credential);
      const login = { instanceId: claude.id, runnerId: joined.runnerId, wire };
      try {
        await waitForProbe(wire, claude.id, 0);
        const requestId = await startDeviceLogin(harness, token, login, 0);
        const pending = startLogin(harness.base, token, claude.id, joined.runnerId);
        const refused = await waitForFrame<LoginStart>(wire, "loginStart", 1);
        // A runner refuses a login it cannot run before it stops the login
        // already running, so the first login keeps going.
        wire.send({
          _tag: "loginFailed",
          requestId: refused.requestId,
          message: "no claude on this machine",
        });
        const response = await pending;
        expect(response.status, await response.clone().text()).toBe(409);
        const before = wire.frames.length;

        wire.send({ _tag: "loginEnded", requestId });

        answerProbe(wire, await waitForProbe(wire, claude.id, before));
      } finally {
        wire.close();
      }
    });
  });

  it("probes when a device login ends after a newer login on it got no answer", async () => {
    await withRegistry(
      async (harness) => {
        const token = await completeSetup(harness.base);
        const joined = await enlist(harness);
        const claude = await findInstanceFor(harness.base, token, "claude-code");
        const { wire } = await greet(harness.base, joined.credential);
        const login = { instanceId: claude.id, runnerId: joined.runnerId, wire };
        try {
          await waitForProbe(wire, claude.id, 0);
          const requestId = await startDeviceLogin(harness, token, login, 0);
          // The newer login's answer never arrives, for example because the
          // connection dropped before the runner read the request.
          const response = await startLogin(harness.base, token, claude.id, joined.runnerId);
          expect(response.status, await response.clone().text()).toBe(409);
          const before = wire.frames.length;

          wire.send({ _tag: "loginEnded", requestId });

          answerProbe(wire, await waitForProbe(wire, claude.id, before));
        } finally {
          wire.close();
        }
      },
      { loginDeadline: LOGIN_DEADLINE },
    );
  });

  it("ignores the end of a device login that a later device login replaced", async () => {
    await withRegistry(async (harness) => {
      const token = await completeSetup(harness.base);
      const joined = await enlist(harness);
      const claude = await findInstanceFor(harness.base, token, "claude-code");
      const codex = await findInstanceFor(harness.base, token, "codex");
      const { wire } = await greet(harness.base, joined.credential, TWO_ADAPTERS);
      const login = { instanceId: claude.id, runnerId: joined.runnerId, wire };
      try {
        await waitForProbe(wire, claude.id, 0);
        const first = await startDeviceLogin(harness, token, login, 0);
        const second = await startDeviceLogin(harness, token, login, 1);
        const third = await startDeviceLogin(harness, token, login, 2);

        // The runner stopped the first two logins to start the next, and
        // reports no end for a login it stopped. The controller stopped
        // waiting for them, so a report for either causes no probe.
        wire.send({ _tag: "loginEnded", requestId: first });
        wire.send({ _tag: "loginEnded", requestId: second });
        await settleCodexLogin(
          harness,
          token,
          { instanceId: codex.id, runnerId: joined.runnerId, wire },
          3,
        );
        expect(countProbes(wire, claude.id)).toBe(1);

        const before = wire.frames.length;
        wire.send({ _tag: "loginEnded", requestId: third });
        answerProbe(wire, await waitForProbe(wire, claude.id, before));
      } finally {
        wire.close();
      }
    });
  });

  it("ignores the end of a device login that a paste-a-code login replaced", async () => {
    await withRegistry(async (harness) => {
      const token = await completeSetup(harness.base);
      const joined = await enlist(harness);
      const claude = await findInstanceFor(harness.base, token, "claude-code");
      const codex = await findInstanceFor(harness.base, token, "codex");
      const { wire } = await greet(harness.base, joined.credential, TWO_ADAPTERS);
      try {
        await waitForProbe(wire, claude.id, 0);
        const replaced = await startDeviceLogin(
          harness,
          token,
          { instanceId: claude.id, runnerId: joined.runnerId, wire },
          0,
        );
        const pending = startLogin(harness.base, token, claude.id, joined.runnerId);
        const request = await waitForFrame<LoginStart>(wire, "loginStart", 1);
        wire.send({ _tag: "loginUrl", requestId: request.requestId, url: AUTHORIZE_URL });
        const response = await pending;
        expect(response.status, await response.clone().text()).toBe(200);

        wire.send({ _tag: "loginEnded", requestId: replaced });
        await settleCodexLogin(
          harness,
          token,
          { instanceId: codex.id, runnerId: joined.runnerId, wire },
          2,
        );

        expect(countProbes(wire, claude.id)).toBe(1);
      } finally {
        wire.close();
      }
    });
  });

  it("ignores the end of a paste-a-code login, whose code submission already reports it", async () => {
    await withRegistry(async (harness) => {
      const token = await completeSetup(harness.base);
      const joined = await enlist(harness);
      const claude = await findInstanceFor(harness.base, token, "claude-code");
      const codex = await findInstanceFor(harness.base, token, "codex");
      const { wire } = await greet(harness.base, joined.credential, TWO_ADAPTERS);
      try {
        await waitForProbe(wire, claude.id, 0);
        const pending = startLogin(harness.base, token, claude.id, joined.runnerId);
        const request = await waitForFrame<LoginStart>(wire, "loginStart", 0);
        wire.send({ _tag: "loginUrl", requestId: request.requestId, url: AUTHORIZE_URL });
        const response = await pending;
        expect(response.status, await response.clone().text()).toBe(200);

        wire.send({ _tag: "loginEnded", requestId: request.requestId });
        await settleCodexLogin(
          harness,
          token,
          { instanceId: codex.id, runnerId: joined.runnerId, wire },
          1,
        );

        expect(countProbes(wire, claude.id)).toBe(1);
      } finally {
        wire.close();
      }
    });
  });

  it("ignores the end of a login reported before the hello", async () => {
    await withRegistry(async (harness) => {
      const token = await completeSetup(harness.base);
      const joined = await enlist(harness);
      const claude = await findInstanceFor(harness.base, token, "claude-code");
      const first = await greet(harness.base, joined.credential);
      const requestId = await startDeviceLogin(harness, token, {
        instanceId: claude.id,
        runnerId: joined.runnerId,
        wire: first.wire,
      });
      first.wire.close();
      await first.wire.closed();

      const wire = await dial(harness.base, joined.credential);
      try {
        // Until the hello arrives, this connection has only shown that it
        // holds a credential, so its report is not read. Had it been read, it
        // would have used up the login, and the report after the hello below
        // would cause no probe.
        wire.send({ _tag: "loginEnded", requestId });
        wire.send(buildHello());
        await waitForFrame(wire, "controllerHello");
        await waitForProbe(wire, claude.id, 0);
        const before = wire.frames.length;

        wire.send({ _tag: "loginEnded", requestId });

        await waitForProbe(wire, claude.id, before);
      } finally {
        wire.close();
      }
    });
  });

  it("returns the runner's error message when no URL came back", async () => {
    await withRegistry(async (harness) => {
      const token = await completeSetup(harness.base);
      const joined = await enlist(harness);
      const claude = await findInstanceFor(harness.base, token, "claude-code");
      const { wire } = await greet(harness.base, joined.credential);
      try {
        const pending = startLogin(harness.base, token, claude.id, joined.runnerId);
        const request = await waitForFrame<LoginStart>(wire, "loginStart");
        wire.send({
          _tag: "loginFailed",
          requestId: request.requestId,
          message: "claude: could not reach platform.claude.com",
        });

        const response = await pending;
        expect(response.status, await response.clone().text()).toBe(409);
        const refusal = (await response.json()) as { error: { code: string; message: string } };
        expect(refusal.error.code).toBe("invalid_state");
        // The vendor's own message: a login that failed for a reason the user
        // can act on must not look like Hercule being broken.
        expect(refusal.error.message).toContain("could not reach platform.claude.com");
      } finally {
        wire.close();
      }
    });
  });

  it("fails for a runner that never answers, and says how long it waited", async () => {
    await withRegistry(
      async (harness) => {
        const token = await completeSetup(harness.base);
        const joined = await enlist(harness);
        const claude = await findInstanceFor(harness.base, token, "claude-code");
        const { wire } = await greet(harness.base, joined.credential);
        try {
          const response = await startLogin(harness.base, token, claude.id, joined.runnerId);
          await waitForFrame<LoginStart>(wire, "loginStart");

          expect(response.status, await response.clone().text()).toBe(409);
          const refusal = (await response.json()) as { error: { code: string; message: string } };
          expect(refusal.error.code).toBe("invalid_state");
          expect(refusal.error.message).toContain(Duration.format(LOGIN_DEADLINE));
        } finally {
          wire.close();
        }
      },
      { loginDeadline: LOGIN_DEADLINE },
    );
  });

  it("rejects a provider this runner build has no adapter for, before asking the runner", async () => {
    await withRegistry(async (harness) => {
      const token = await completeSetup(harness.base);
      const joined = await enlist(harness);
      const codex = await findInstanceFor(harness.base, token, "codex");
      const { wire } = await greet(harness.base, joined.credential);
      try {
        const response = await startLogin(harness.base, token, codex.id, joined.runnerId);
        expect(response.status, await response.clone().text()).toBe(400);
        expect(await response.json()).toMatchObject({ error: { code: "validation" } });
        expect(wire.frames.filter((frame) => frame._tag === "loginStart")).toEqual([]);
      } finally {
        wire.close();
      }
    });
  });

  it("rejects a login on a runner that is not online, and sends that connection nothing", async () => {
    await withRegistry(async (harness) => {
      const token = await completeSetup(harness.base);
      const joined = await enlist(harness);
      const claude = await findInstanceFor(harness.base, token, "claude-code");
      const wire = await dial(harness.base, joined.credential);
      try {
        const response = await startLogin(harness.base, token, claude.id, joined.runnerId);
        expect(response.status, await response.clone().text()).toBe(409);
        expect(await response.json()).toMatchObject({ error: { code: "invalid_state" } });
        expect(wire.frames).toEqual([]);
      } finally {
        wire.close();
      }
    });
  });

  it("sends the pasted code to the runner and returns the new snapshot", async () => {
    await withRegistry(async (harness) => {
      const token = await completeSetup(harness.base);
      const joined = await enlist(harness);
      const claude = await findInstanceFor(harness.base, token, "claude-code");
      const { wire } = await greet(harness.base, joined.credential);
      try {
        const starting = startLogin(harness.base, token, claude.id, joined.runnerId);
        const started = await waitForFrame<LoginStart>(wire, "loginStart");
        wire.send({ _tag: "loginUrl", requestId: started.requestId, url: AUTHORIZE_URL });
        expect((await starting).status).toBe(200);
        const before = wire.frames.length;

        const pending = submitCode(harness.base, token, claude.id, {
          runnerId: joined.runnerId,
          code: "the-pasted-code",
        });
        const sent = await waitForFrame<LoginCode>(wire, "loginCode");
        expect(sent.instanceId).toBe(claude.id);
        expect(sent.code).toBe("the-pasted-code");
        wire.send({ _tag: "loginResult", requestId: sent.requestId, ok: true });

        // A harness that was just logged in has not been probed for its
        // account yet, so the response is a new snapshot, not the old one.
        const probe = await waitForProbe(wire, claude.id, before);
        wire.send({
          _tag: "probeReport",
          requestId: probe.requestId,
          instanceId: claude.id,
          result: buildProbeResult("2.1.263"),
        });

        const response = await pending;
        expect(response.status, await response.clone().text()).toBe(200);
        const snapshot = (await response.json()) as Instance["snapshots"][number];
        expect(snapshot.runnerId).toBe(joined.runnerId);
        expect(snapshot.auth).toMatchObject({ status: "ok", identity: "rogier@example.com" });

        // The code and the URL are valid for one exchange and are never
        // stored.
        const logged = await harness.audit("provider.loggedIn");
        expect(logged).toHaveLength(1);
        expect(logged[0]?.payload).toEqual({ instanceId: claude.id, runnerId: joined.runnerId });
        expect(logged[0]?.actor).toBe("user");
        expect(JSON.stringify(logged[0])).not.toContain("the-pasted-code");
      } finally {
        wire.close();
      }
    });
  });

  it("returns the CLI's error message for a bad code, and accepts another", async () => {
    await withRegistry(async (harness) => {
      const token = await completeSetup(harness.base);
      const joined = await enlist(harness);
      const claude = await findInstanceFor(harness.base, token, "claude-code");
      const { wire } = await greet(harness.base, joined.credential);
      try {
        const starting = startLogin(harness.base, token, claude.id, joined.runnerId);
        const started = await waitForFrame<LoginStart>(wire, "loginStart");
        wire.send({ _tag: "loginUrl", requestId: started.requestId, url: AUTHORIZE_URL });
        await starting;

        const refused = submitCode(harness.base, token, claude.id, {
          runnerId: joined.runnerId,
          code: "half-a-code",
        });
        const first = await waitForFrame<LoginCode>(wire, "loginCode");
        wire.send({
          _tag: "loginResult",
          requestId: first.requestId,
          ok: false,
          message: "Invalid code. Please make sure the full code was copied.",
        });

        const response = await refused;
        // An error the user can fix by pasting again, not a state the login
        // cannot recover from.
        expect(response.status, await response.clone().text()).toBe(400);
        const refusal = (await response.json()) as { error: { code: string; message: string } };
        expect(refusal.error.code).toBe("validation");
        expect(refusal.error.message).toContain("Invalid code");

        // The child is still up, so a second paste reaches the same login.
        const accepted = submitCode(harness.base, token, claude.id, {
          runnerId: joined.runnerId,
          code: "the-whole-code",
        });
        const second = await waitForFrame<LoginCode>(wire, "loginCode", 1);
        expect(second.code).toBe("the-whole-code");
        wire.send({ _tag: "loginResult", requestId: second.requestId, ok: true });
        const probe = await waitForProbe(wire, claude.id, wire.frames.length - 1);
        wire.send({
          _tag: "probeReport",
          requestId: probe.requestId,
          instanceId: claude.id,
          result: buildProbeResult("2.1.263"),
        });
        expect((await accepted).status).toBe(200);
      } finally {
        wire.close();
      }
    });
  });

  it("rejects a code when no login is in progress", async () => {
    await withRegistry(async (harness) => {
      const token = await completeSetup(harness.base);
      const joined = await enlist(harness);
      const claude = await findInstanceFor(harness.base, token, "claude-code");
      const { wire } = await greet(harness.base, joined.credential);
      try {
        const pending = submitCode(harness.base, token, claude.id, {
          runnerId: joined.runnerId,
          code: "a-code-nobody-asked-for",
        });
        const sent = await waitForFrame<LoginCode>(wire, "loginCode");
        wire.send({
          _tag: "loginFailed",
          requestId: sent.requestId,
          message: "no login in progress",
        });

        const response = await pending;
        expect(response.status, await response.clone().text()).toBe(409);
        const refusal = (await response.json()) as { error: { code: string; message: string } };
        expect(refusal.error.code).toBe("invalid_state");
        expect(refusal.error.message).toContain("no login in progress");
      } finally {
        wire.close();
      }
    });
  });
});

/** Cancels the transfer of `promotionToken`, which thaws the controller. */
const thaw = async (base: string, promotionToken: string): Promise<void> => {
  const response = await requestTransfer(base, promotionToken, "DELETE");
  expect(response.status).toBe(204);
};

/**
 * Returns the runner's connectivity as the database holds it. A sealed
 * controller answers no request, so the tests read its database directly.
 */
const readConnectivityFromDatabase = async (
  harness: ServerHarness,
  runnerId: string,
): Promise<string> => {
  const rows = await Effect.runPromise(
    Effect.orDie(
      harness.sql<{ connectivity: string }>`
        SELECT connectivity FROM runners WHERE id = ${uuidFromString(runnerId)}
      `,
    ),
  );
  return rows[0]!.connectivity;
};

/**
 * How long a test waits to show that something did not happen. A frame or a
 * write the controller was going to make arrives well within this.
 */
const QUIET_MS = 300;

describe("a runner connection during a promotion", () => {
  it("holds a hello that arrives while frozen, and answers it with the new address once sealed", async () => {
    await withServer(async (harness) => {
      const token = await completeSetupWithNoProviderInstance(harness);
      const joined = await enlist(harness);
      const promotionToken = await freezeController(harness.base, token);

      const wire = await dial(harness.base, joined.credential);
      wire.send(buildHello());
      await delay(QUIET_MS);
      expect(wire.frames, "a frozen controller holds the hello").toEqual([]);

      await sealController(harness.base, promotionToken);
      const pointer = await waitForFrame<ForwardingPointer>(wire, "forwardingPointer");
      expect(pointer.newAddress).toBe(NEW_CONTROLLER_ADDRESS);
      await delay(QUIET_MS);
      // Exactly one pointer: the connection never joined the connections the
      // seal announces itself to, and it never got a hello of its own.
      expect(wire.frames.map((frame) => frame._tag)).toEqual(["forwardingPointer"]);
      expect(await readConnectivityFromDatabase(harness, joined.runnerId)).not.toBe("online");
      wire.close();
    });
  });

  it("holds a hello that arrives while frozen, and answers it once the transfer is cancelled", async () => {
    await withServer(async (harness) => {
      const token = await completeSetupWithNoProviderInstance(harness);
      const joined = await enlist(harness);
      const promotionToken = await freezeController(harness.base, token);

      const wire = await dial(harness.base, joined.credential);
      wire.send(buildHello());
      await delay(QUIET_MS);
      expect(wire.frames, "a frozen controller holds the hello").toEqual([]);
      // Reading still works while frozen.
      expect((await readRunner(harness.base, token, joined.runnerId)).connectivity).not.toBe(
        "online",
      );

      await thaw(harness.base, promotionToken);
      await waitForFrame<ControllerHello>(wire, "controllerHello");
      await waitForRunner(
        harness.base,
        token,
        joined.runnerId,
        (one) => one.connectivity === "online",
      );
      expect(await readStateTransitions(harness)).toEqual(["online"]);
      wire.close();
    });
  });

  it("records a runner that disconnects while frozen as unreachable only once the transfer is cancelled", async () => {
    await withServer(async (harness) => {
      const token = await completeSetupWithNoProviderInstance(harness);
      const joined = await enlist(harness);
      const { wire } = await greet(harness.base, joined.credential);
      await waitForRunner(
        harness.base,
        token,
        joined.runnerId,
        (one) => one.connectivity === "online",
      );
      const promotionToken = await freezeController(harness.base, token);

      wire.close();
      await delay(QUIET_MS);
      // The copy the new machine took has the runner online, and nothing is
      // written after the copy.
      expect((await readRunner(harness.base, token, joined.runnerId)).connectivity).toBe("online");
      expect(await readStateTransitions(harness)).toEqual(["online"]);

      await thaw(harness.base, promotionToken);
      await waitForRunner(
        harness.base,
        token,
        joined.runnerId,
        (one) => one.connectivity === "unreachable",
      );
      expect(await readStateTransitions(harness)).toEqual(["online", "unreachable"]);
    });
  });

  it("records a runner that says goodbye while frozen as offline only once the transfer is cancelled", async () => {
    await withServer(async (harness) => {
      const token = await completeSetupWithNoProviderInstance(harness);
      const joined = await enlist(harness);
      const { wire } = await greet(harness.base, joined.credential);
      await waitForRunner(
        harness.base,
        token,
        joined.runnerId,
        (one) => one.connectivity === "online",
      );
      const promotionToken = await freezeController(harness.base, token);

      wire.send({ _tag: "goodbye" });
      wire.close();
      await delay(QUIET_MS);
      expect((await readRunner(harness.base, token, joined.runnerId)).connectivity).toBe("online");
      expect(await readStateTransitions(harness)).toEqual(["online"]);

      await thaw(harness.base, promotionToken);
      await waitForRunner(
        harness.base,
        token,
        joined.runnerId,
        (one) => one.connectivity === "offline",
      );
      // The held departure keeps its kind: a runner that said goodbye was not
      // lost, so it never reads as unreachable.
      expect(await readStateTransitions(harness)).toEqual(["online", "offline"]);
    });
  });

  it("keeps a runner online that disconnects and connects again while frozen", async () => {
    await withServer(async (harness) => {
      const token = await completeSetupWithNoProviderInstance(harness);
      const joined = await enlist(harness);
      const first = await greet(harness.base, joined.credential);
      await waitForRunner(
        harness.base,
        token,
        joined.runnerId,
        (one) => one.connectivity === "online",
      );
      const promotionToken = await freezeController(harness.base, token);

      first.wire.close();
      const second = await dial(harness.base, joined.credential);
      second.send(buildHello());
      await delay(QUIET_MS);

      await thaw(harness.base, promotionToken);
      await waitForFrame<ControllerHello>(second, "controllerHello");
      await delay(QUIET_MS);
      // The held hello and the held departure both run after the thaw, in
      // either order. Either way the runner ends online: the departure is
      // written before the hello, or the hello drops it.
      expect((await readRunner(harness.base, token, joined.runnerId)).connectivity).toBe("online");
      expect((await readStateTransitions(harness)).at(-1)).toBe("online");
      second.close();
    });
  });

  it("writes nothing for a runner that disconnects from a sealed controller", async () => {
    await withServer(async (harness) => {
      const token = await completeSetupWithNoProviderInstance(harness);
      const joined = await enlist(harness);
      const { wire } = await greet(harness.base, joined.credential);
      await waitForRunner(
        harness.base,
        token,
        joined.runnerId,
        (one) => one.connectivity === "online",
      );
      const promotionToken = await freezeController(harness.base, token);
      await sealController(harness.base, promotionToken);
      await waitForFrame<ForwardingPointer>(wire, "forwardingPointer");

      wire.close();
      await delay(QUIET_MS);
      expect(await readConnectivityFromDatabase(harness, joined.runnerId)).toBe("online");
      expect(await readStateTransitions(harness)).toEqual(["online"]);
    });
  });
});
