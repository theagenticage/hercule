/**
 * The runner socket against the real controller: who is let in, what the two
 * ends say to each other first, and what the liveness check does to the row.
 *
 * This drives a real WebSocket against a real listener, because the whole point
 * of the socket is the wire. The credential is a real one, handed back by a real
 * join, and the frames are the published catalogue's, decoded rather than eyed:
 * a controller that answers something `@hercule/protocol` cannot read is a
 * controller no runner can talk to.
 *
 * Three things are asserted here and nothing else is. A machine gets in with the
 * credential its join handed it and with nothing else, and a refused upgrade
 * costs no socket. The hello settles compatibility - one version is refused, and
 * every other kind of skew is not - and leaves the row saying what the runner
 * said about itself, stamped on nobody's behalf but the system's. And the row
 * then follows the connection: a pong keeps it, silence loses it, an announced
 * departure reads differently from a vanished one, and a new hello brings it
 * back from either.
 *
 * The shipped 15 and 60 seconds are asserted as the exported constants; the
 * behaviour is asserted with values of tens of milliseconds handed to the
 * harness, because a real Bun listener cannot be driven by a `TestClock`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Duration, Effect, Schema } from "effect";
import {
  ControllerToRunner,
  PROTOCOL_VERSION,
  encodeChallengeBytes,
  type ControllerHello,
  type ControllerToRunner as ControllerMessage,
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
import { completeSetup, get, send, withServer, type ServerHarness } from "../http/testing";
// The two shipped durations are read off the domain's own exports rather than
// imported by name, so a file that is otherwise about the wire still reports
// each behaviour's failure separately when the constants are not there yet.
import { RUNNER_PING_INTERVAL, RUNNER_SILENCE_LIMIT } from "./socket";

/** Where a runner dials, on the same authority the API is served from. */
const SOCKET_PATH = "/api/v1/runners/socket";

const buildSocketUrl = (base: string): string => `${base.replace(/^http:/, "ws:")}${SOCKET_PATH}`;

/** Standard base64, which is how the catalogue carries bytes. */
const encodeBase64 = (raw: Uint8Array): string => Buffer.from(raw).toString("base64");

/** The bytes standard base64 stands for, in a buffer WebCrypto will take. */
const decodeBase64Bytes = (encoded: string): Uint8Array<ArrayBuffer> => {
  const decoded = Buffer.from(encoded, "base64");
  const out = new Uint8Array(decoded.byteLength);
  out.set(decoded);
  return out;
};

/** A fresh nonce, the way a runner makes one. */
const mintNonce = (): string => encodeBase64(crypto.getRandomValues(new Uint8Array(16)));

/** What a runner in these tests says about the machine it is on. */
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
 * The controller probes on its own schedule, so a wait says what it is waiting
 * for rather than how long, and names what never happened when it runs out.
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

/** One runner's end of the socket, driven frame by frame. */
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
 * Opens the socket with a credential, as a runner does: the credential rides
 * the upgrade request, so a connection that opens has already been let in.
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
      // A refused upgrade shows up here; the close handler records the reason.
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
 * Whether the listener upgrades at all for an `Authorization` header, without
 * caring what happens afterwards.
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
 * The upgrade request as plain HTTP, so a refusal can be read as the status and
 * the envelope it really is rather than as a socket that did not open.
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

/** A runner's opening frame, in this build's version unless a test says otherwise. */
const buildHello = (overrides: Partial<RunnerHello> = {}): RunnerHello => ({
  _tag: "runnerHello",
  protocolVersion: PROTOCOL_VERSION,
  capabilities: [],
  binaryVersion: THIS_BUILD,
  nonce: mintNonce(),
  facts: FACTS,
  ...overrides,
});

/** Enlists a machine the way one enlists: a minted token, spent on the join. */
const enlist = async (harness: ServerHarness): Promise<JoinAnswer> => {
  const response = await send("POST", harness.base, "/api/v1/runners/join", {
    body: {},
    token: await harness.joinToken(),
  });
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json()) as JoinAnswer;
};

/** The row as the fleet reads it. */
const readRunner = async (base: string, token: string, id: string): Promise<RunnerDetail> => {
  const response = await get(base, `/api/v1/runners/${id}`, token);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as RunnerDetail;
};

/** The delay between two reads of a runner row while `waitForRunner` polls. */
const ROW_POLL_INTERVAL_MS = 10;

/** How many times `waitForRunner` reads the row before it gives up. */
const ROW_POLL_ATTEMPTS = 300;

/**
 * The timeout for a test that calls `waitForRunner` four times. If the test timed
 * out before `waitForRunner` gave up, vitest would stop the test first, and the
 * failure would report the test instead of the row that never changed. Under
 * the load of the full suite, four waits can take longer than vitest's default
 * five seconds. So the timeout covers four full waits plus the setup before
 * them.
 */
const FOUR_ROW_WAITS_TIMEOUT_MS = ROW_POLL_INTERVAL_MS * ROW_POLL_ATTEMPTS * 4 + 10_000;

/** The row once it says what the test is waiting for, or as it stubbornly is. */
const waitForRunner = async (
  base: string,
  token: string,
  id: string,
  ready: (row: RunnerDetail) => boolean,
): Promise<RunnerDetail> => {
  let row = await readRunner(base, token, id);
  for (let attempt = 0; attempt < ROW_POLL_ATTEMPTS && !ready(row); attempt++) {
    await delay(ROW_POLL_INTERVAL_MS);
    row = await readRunner(base, token, id);
  }
  return row;
};

/** Whether the controller's signature over the given bytes is really its own. */
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

/** Opens a connection and greets the controller on it, answering as a runner does. */
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

/** The states the log says the runner passed through, oldest first. */
const readStateTransitions = async (harness: ServerHarness): Promise<ReadonlyArray<unknown>> =>
  (await harness.audit("runner.stateChanged")).map((entry) => entry.payload["state"]);

/** How the controller closes: a frame it refused, and a connection it is done with. */
const PROTOCOL_ERROR = 1002;
const GOING_AWAY = 1001;

/** An interval a test can wait out, with a silence limit it will not trip. */
const FAST = { interval: Duration.millis(40), silence: Duration.seconds(30) };

describe("opening the runner socket", () => {
  it("upgrades a machine holding the credential its join handed it", async () => {
    await withServer(async (harness) => {
      const joined = await enlist(harness);

      const wire = await dial(harness.base, joined.credential);
      // The upgrade is the whole of the admission: nothing is said on the
      // socket until the runner says the first thing.
      expect(wire.frames).toEqual([]);
      wire.close();
    });
  });

  it("refuses every credential that is not a live runner's, and opens no socket", async () => {
    await withServer(async (harness) => {
      const user = await completeSetup(harness.base);
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

      // A revoked runner is a retired one: its credential stops opening the
      // socket the moment the row is terminal.
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
  it("answers with a signature over the runner's nonce and brings the row online", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const joined = await enlist(harness);

      const { wire, sent, answer } = await greet(harness.base, joined.credential, {
        capabilities: ["sessions"],
      });

      expect(answer.protocolVersion).toBe(PROTOCOL_VERSION);
      // The identity a runner pins is the one its join handed it, byte for byte.
      expect(answer.identityId).toBe(joined.controllerIdentityId);
      expect(answer.publicKey).toBe(joined.controllerPublicKey);
      expect(answer.nonce).toBe(sent.nonce);
      expect(await verifySignature(answer, encodeChallengeBytes(joined.runnerId, sent.nonce))).toBe(
        true,
      );
      // Over the nonce alone the same signature is good on any connection, so a
      // peer holding any runner's credential could relay it to this one.
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

      // Negotiated means both said it: nothing is stored that only one end
      // claimed.
      expect(row.negotiatedCapabilities).not.toBeNull();
      for (const capability of row.negotiatedCapabilities ?? []) {
        expect(sent.capabilities, "the runner did not offer it").toContain(capability);
        expect(answer.capabilities, "the controller did not offer it").toContain(capability);
      }

      // Nobody holding a credential asked for this: a runner is never an actor.
      const entries = await harness.audit("runner.stateChanged");
      expect(entries).toHaveLength(1);
      expect(entries[0]?.actor).toBe("system");
      expect(entries[0]?.payload).toMatchObject({ runnerId: joined.runnerId, state: "online" });

      wire.close();
    });
  });

  it("brings a runner on another binary version online all the same", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
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
      // Stored, so the fleet can show the skew: warn, never block.
      expect(row.version).toBe("0.0.0-from-another-build");

      wire.close();
    });
  });

  it("closes a hello in a version it does not speak, saying why, and leaves the row alone", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const joined = await enlist(harness);

      const wire = await dial(harness.base, joined.credential);
      wire.send(buildHello({ protocolVersion: PROTOCOL_VERSION + 1 }));

      const ending = await wire.closed();
      expect(ending.reason, "a refused hello is a close with a reason").not.toBe("");
      // A refusal is a close, not a message: the catalogue has no error member.
      expect(wire.frames).toEqual([]);

      const row = await readRunner(harness.base, token, joined.runnerId);
      expect(row.connectivity).toBe("offline");
      expect(row.lastSeenAt).toBeNull();
      expect(row.version).toBeNull();
      expect(await readStateTransitions(harness)).toEqual([]);
    });
  });

  it("names the version when a runner sends a hello it cannot even decode", async () => {
    await withServer(async (harness) => {
      const joined = await enlist(harness);
      const wire = await dial(harness.base, joined.credential);

      // What a later build's hello looks like from here: a version this
      // controller does not speak, in a shape whose required fields it does not
      // have. It must read as a version it cannot speak, not as gibberish.
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
  it("stops believing in a runner it hung up on itself", async () => {
    await withServer(
      async (harness) => {
        const token = await completeSetup(harness.base);
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

        // A frame this build cannot read: what a newer runner sending a member
        // this catalogue does not carry looks like from here.
        wire.send({ _tag: "nonsense" } as unknown as RunnerMessage);
        const ending = await wire.closed();
        expect(ending.code, "the frame was refused, not the connection retired").toBe(
          PROTOCOL_ERROR,
        );
        expect(ending.reason).not.toBe("");

        // The controller closed it, so nobody announced anything: the runner is
        // as gone as one that vanished.
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

  it("takes one hello per connection and no more, however they arrive", async () => {
    await withServer(
      async (harness) => {
        const joined = await enlist(harness);
        const wire = await dial(harness.base, joined.credential);

        // Both in one go, without waiting for an answer to the first. The
        // transport hands each frame to its own fiber, so a controller that
        // looked at the two in parallel would sign twice, write the row twice
        // and answer twice for a frame anybody holding the credential can send
        // as often as they like.
        wire.send(buildHello());
        wire.send(buildHello());

        const ending = await wire.closed();
        expect(ending.code, "the second hello was refused").toBe(PROTOCOL_ERROR);
        expect(ending.reason).not.toBe("");
        expect(wire.frames.filter((frame) => frame._tag === "controllerHello")).toHaveLength(1);
        expect(await readStateTransitions(harness)).toEqual(["online", "unreachable"]);
      },
      { pings: FAST },
    );
  });

  it("hangs up the older connection when a runner dials again, and keeps it online", async () => {
    await withServer(
      async (harness) => {
        const token = await completeSetup(harness.base);
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
        // The runner holds one connection; the one it replaced is let go, and
        // let go rather than refused: it did nothing wrong.
        const ending = await older.wire.closed();
        expect(ending.code).toBe(GOING_AWAY);
        expect(ending.reason).not.toBe("");

        // And the older connection's parting word does not land on the row the
        // newer one is holding.
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
  it("pings every 15 seconds and gives up on 60 seconds of silence", () => {
    expect(Duration.toMillis(RUNNER_PING_INTERVAL)).toBe(15_000);
    expect(Duration.toMillis(RUNNER_SILENCE_LIMIT)).toBe(60_000);
  });

  it("pings on the interval, and every pong advances what the row last saw", async () => {
    await withServer(
      async (harness) => {
        const token = await completeSetup(harness.base);
        const joined = await enlist(harness);
        const { wire } = await greet(harness.base, joined.credential);

        const first = await waitForRunner(
          harness.base,
          token,
          joined.runnerId,
          (one) => one.connectivity === "online",
        );
        expect(first.lastSeenAt).not.toBeNull();

        // Four intervals' worth of pings, each answered the way a runner
        // answers one.
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
        // Answering kept it where it was.
        expect(later.connectivity).toBe("online");

        wire.close();
      },
      { pings: FAST },
    );
  });

  it("keeps a runner that answers, for longer than silence would have cost it", async () => {
    await withServer(
      async (harness) => {
        const token = await completeSetup(harness.base);
        const joined = await enlist(harness);
        const { wire } = await greet(harness.base, joined.credential);

        // Ten intervals, five silence limits' worth of time: a runner that
        // answers is a runner the controller goes on believing in, and nothing
        // but a pong is what says so.
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
      { pings: { ...FAST, silence: Duration.millis(80) } },
    );
  });

  it("loses a runner that stops answering, stamped on nobody's behalf", async () => {
    await withServer(
      async (harness) => {
        const token = await completeSetup(harness.base);
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

        // The socket stays up and the runner says nothing on it, which is the
        // case a transport-level ping would have hidden.
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

  it("reads an announced departure as offline and a vanished one as unreachable", async () => {
    await withServer(
      async (harness) => {
        const token = await completeSetup(harness.base);
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
        // It never passed through `unreachable` on the way: the departure was
        // announced, so there was no silence to interpret.
        expect(await readStateTransitions(harness)).toEqual(["online", "offline"]);

        // A new hello takes it back out of `offline`.
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

        // And a connection that just goes away is not a departure.
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

        // A new hello takes it back out of `unreachable` too.
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
        // Five moves on the one axis a connection owns, and none on the other:
        // where a runner stands with its owner is not the socket's to say.
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
  /** A watermark as a runner sends one, with the disk the test wants. */
  const buildResourceReport = (diskFreeBytes: number) => ({
    diskFreeBytes,
    availableMemoryBytes: 16 * 1024 * 1024 * 1024,
  });

  it(
    "stores the watermark a runner reports and hands it back on the row",
    async () => {
      await withServer(
        async (harness) => {
          const token = await completeSetup(harness.base);
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

          // Above the shipped ten-gibibyte watermark, so this reading is a
          // machine still accepting work.
          wire.send({ _tag: "watermarkReport", watermark: buildResourceReport(200 * GIB) });
          const stored = await waitForRunner(
            harness.base,
            token,
            joined.runnerId,
            (one) => one.watermark !== null,
          );
          expect(stored.watermark).toEqual(buildResourceReport(200 * GIB));

          const before = await harness.audit("runner.placementsChanged");
          // A machine nobody had heard from is taken to be accepting work, so a
          // first reading of a healthy disk is not news about it.
          expect(before).toHaveLength(0);

          // The same reading again, then a different disk that means the same
          // thing for placement. Waiting for the second one to land is what
          // proves the first was seen and deliberately left no row.
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

          // The disk filled up, below the shipped watermark: this one is a
          // change of what the fleet may do with the machine, and that is what
          // gets recorded.
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
          // Nobody holding a credential asked for this: a runner is never an actor.
          expect(flip?.actor).toBe("system");
          expect(flip?.payload).toMatchObject({
            runnerId: joined.runnerId,
            acceptingPlacements: false,
          });

          // And a `system` stamp the event schema cannot encode would fail the
          // whole page rather than the row, so it is read back over the wire too.
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
    },
    FOUR_ROW_WAITS_TIMEOUT_MS,
  );

  it("records a machine that comes back with no room left", async () => {
    await withServer(
      async (harness) => {
        const token = await completeSetup(harness.base);
        const joined = await enlist(harness);
        const { wire } = await greet(harness.base, joined.credential);
        await waitForRunner(
          harness.base,
          token,
          joined.runnerId,
          (one) => one.connectivity === "online",
        );

        // Its very first reading, and the disk is full. Nothing had been heard
        // about this machine before, but a machine that cannot take work is
        // news whether or not anything was.
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
        const token = await completeSetup(harness.base);
        const joined = await enlist(harness);
        const { wire } = await greet(harness.base, joined.credential);

        const online = await waitForRunner(
          harness.base,
          token,
          joined.runnerId,
          (one) => one.connectivity === "online",
        );
        expect(online.facts).toEqual(FACTS);

        // The machine gained a `gh` while the connection was up.
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
        // The whole report replaces the whole column: only the latest reading
        // is worth anything, so nothing is merged.
        expect(changed.facts).toEqual(grown);

        wire.close();
      },
      { pings: FAST },
    );
  });

  it("caps sessions at one per 2 GiB until somebody overrides it", async () => {
    await withServer(
      async (harness) => {
        const token = await completeSetup(harness.base);
        const joined = await enlist(harness);
        // A cap can only be derived once the machine has said how big it is,
        // and it says that in its hello.
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

        // A machine too small for even one 2 GiB session still takes one.
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

        // What the user said stands: the machine reporting a different size is
        // not a reason to throw the answer away.
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

  it("keeps the row readable when the stored watermark is one it cannot read", async () => {
    await withServer(
      async (harness) => {
        const token = await completeSetup(harness.base);
        const joined = await enlist(harness);
        const { wire } = await greet(harness.base, joined.credential);
        await waitForRunner(
          harness.base,
          token,
          joined.runnerId,
          (one) => one.connectivity === "online",
        );

        // A column written by a build that said something else. The read side
        // answers it as absent; the write side must not choke on it, or this
        // runner would lose its socket a minute after every hello, forever.
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

  it("stores nothing a connection that has not said who it is reports", async () => {
    await withServer(
      async (harness) => {
        const token = await completeSetup(harness.base);
        const joined = await enlist(harness);
        // A credential is proof that a machine was enlisted, not that this
        // connection is that machine speaking the protocol. Until the hello
        // lands there is nothing to attach a report to.
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

  it("gives a connection that never says hello nothing, and lets go of it", async () => {
    await withServer(
      async (harness) => {
        const token = await completeSetup(harness.base);
        const joined = await enlist(harness);
        // A credential, a socket, and no hello. It answers every ping, which is
        // the one way a connection can look alive without ever joining.
        const wire = await dial(harness.base, joined.credential);
        const answering = setInterval(() => {
          wire.send({ _tag: "pong" });
        }, 10);

        const ended = await wire.closed();
        clearInterval(answering);

        expect(ended.code).toBe(1001);
        const row = await readRunner(harness.base, token, joined.runnerId);
        // Nothing about this machine was ever heard, so nothing about the row
        // may say it was: "last seen a moment ago" is what places work.
        expect(row.lastSeenAt).toBeNull();
        expect(row.connectivity).toBe("offline");
      },
      { pings: { ...FAST, silence: Duration.millis(200) } },
    );
  });

  it("keeps its hands off what the row last saw; only a pong touches that", async () => {
    await withServer(
      async (harness) => {
        const token = await completeSetup(harness.base);
        const joined = await enlist(harness);
        const { wire } = await greet(harness.base, joined.credential);

        const online = await waitForRunner(
          harness.base,
          token,
          joined.runnerId,
          (one) => one.connectivity === "online",
        );
        expect(online.lastSeenAt).not.toBeNull();

        // Long enough that a report which touched the timestamp would show it.
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
        // Liveness is the heartbeat's to say. A machine can report a disk while
        // being unable to answer a ping, and the row must read that as silence.
        expect(reported.lastSeenAt).toBe(online.lastSeenAt);
        expect(reported.connectivity).toBe("online");

        wire.close();
      },
      { pings: { ...FAST, interval: Duration.seconds(30), silence: Duration.seconds(60) } },
    );
  });
});

describe("what the controller stopping does to its local runner", () => {
  /** The dispatcher, run from source: `hercule` before it is compiled. */
  const HERCULE = `${import.meta.dirname}/../../../../packages/hercule/src/main.ts`;

  it("leaves the row offline when the child is asked to stop, never unreachable", async () => {
    const home = mkdtempSync(join(tmpdir(), "hercule-local-child-"));
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
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
        // The handshake the controller does: it reads the child's first line
        // and answers on its stdin, exactly as the boot step does.
        for (let waited = 0; waited < 15_000 && said === ""; waited += 20) await delay(20);
        expect(said).toBe('{"join":true}\n');
        void child.stdin.write(
          `${JSON.stringify({ controllerUrl: harness.base, token: await harness.joinToken() })}\n`,
        );
        await child.stdin.end();

        // It joins, dials, and the fleet reads it as a machine ready for work.
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

        // What the drain does: the child is asked to stop, and it announces
        // that it is going rather than simply vanishing.
        child.kill("SIGTERM");
        expect(await child.exited).toBe(0);

        const row = await waitForRunner(
          harness.base,
          token,
          runnerId,
          (one) => one.connectivity === "offline",
        );
        expect(row.connectivity).toBe("offline");
        // Never through `unreachable`: a runner that says goodbye was not lost.
        expect(await readStateTransitions(harness)).toEqual(["online", "offline"]);
      } finally {
        child.kill("SIGKILL");
      }
    });
    rmSync(home, { recursive: true, force: true });
  }, 60_000);
});

describe("retiring a runner the controller is holding a connection with", () => {
  /** How the controller ends a connection it will not have back. */
  const POLICY_VIOLATION = 1008;

  const retireRunner = (base: string, token: string, id: string): Promise<Response> =>
    send("POST", base, `/api/v1/runners/${id}/retire`, { body: {}, token });

  it("closes the live connection saying the runner was retired", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
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

      // Retire revokes a credential, so the machine still holding it has to be
      // told on the connection it already has, not only at the next dial.
      const ending = await wire.closed();
      expect(ending.code).toBe(POLICY_VIOLATION);
      expect(ending.reason).toBe("RETIRED");
    });
  });

  it("refuses the retired credential at the upgrade, and says which refusal it is", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const joined = await enlist(harness);

      expect((await retireRunner(harness.base, token, joined.runnerId)).status).toBe(200);

      const revoked = await requestUpgrade(harness.base, `Bearer ${joined.credential}`);
      expect(revoked.status).toBe(401);
      const refusal = (await revoked.json()) as { error: { code: string; message: string } };
      expect(refusal.error.code).toBe("unauthenticated");
      // The machine is holding a credential that was real: it needs to be sent
      // to `join`, not left retrying a credential it thinks is merely unknown.
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
  // The shipped deadline is ten seconds, which no test can wait out, so these
  // servers are handed their own - the way `pings` is handed over.
  const FACTS_DEADLINE = Duration.millis(200);

  const refreshFacts = (base: string, token: string, id: string): Promise<Response> =>
    send("POST", base, `/api/v1/runners/${id}/refresh-facts`, { body: {}, token });

  /**
   * Takes the next frame and says it is the request for facts. The frame was
   * decoded against the published catalogue on its way in, so what is left to
   * assert is which member of it the controller sent.
   */
  const expectFactsRequest = async (wire: Wire): Promise<void> => {
    const frame = await wire.next();
    expect(frame._tag, JSON.stringify(frame)).toBe("factsRequest");
  };

  /** The machine gained a `gh` since it said hello. */
  const GROWN: RunnerFacts = {
    ...FACTS,
    toolchains: [...FACTS.toolchains, { name: "gh", version: "2.99.0", path: "/usr/local/bin/gh" }],
  };

  it("asks the online runner and answers with the row carrying what it reported", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const joined = await enlist(harness);
      const { wire } = await greet(harness.base, joined.credential);
      try {
        await waitForRunner(
          harness.base,
          token,
          joined.runnerId,
          (one) => one.connectivity === "online",
        );

        // The operation is in flight while the runner answers: the request goes
        // out on the connection the controller is already holding.
        const pending = refreshFacts(harness.base, token, joined.runnerId);
        await expectFactsRequest(wire);
        wire.send({ _tag: "factsReport", facts: GROWN });

        const response = await pending;
        expect(response.status, await response.clone().text()).toBe(200);
        // What comes back is the runner as the report left it, not the runner
        // as it was when the button was pressed.
        const answered = (await response.json()) as RunnerDetail;
        expect(answered.id).toBe(joined.runnerId);
        expect(answered.facts).toEqual(GROWN);
        expect((await readRunner(harness.base, token, joined.runnerId)).facts).toEqual(GROWN);
      } finally {
        wire.close();
      }
    });
  });

  it("answers a report that says nothing new, rather than waiting for a change", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
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
        // The very facts the hello carried. A controller waiting for the row to
        // change would wait for ever on the machine nothing happened to, which
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

  it("is not answered by a probe report a runner spells the facts key into", async () => {
    await withServer(
      async (harness) => {
        const token = await completeSetup(harness.base);
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
          // A request id the controller never issued, spelling out what the
          // facts wait might plausibly be keyed under. It wakes nothing, so the
          // caller runs out its deadline: a runner does not get to answer a
          // question it was not asked.
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

  it("refuses a runner that is not online, and sends that connection nothing", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const joined = await enlist(harness);
      // A credential and a socket, and no hello: a connection exists, and the
      // machine on the other end is not a runner the controller can ask
      // anything of.
      const wire = await dial(harness.base, joined.credential);
      try {
        expect((await readRunner(harness.base, token, joined.runnerId)).connectivity).toBe(
          "offline",
        );

        const response = await refreshFacts(harness.base, token, joined.runnerId);
        expect(response.status, await response.clone().text()).toBe(409);
        expect(await response.json()).toMatchObject({ error: { code: "invalid_state" } });
        // Nothing was asked of it: a request sent down a connection that has
        // not said who it is would be answered by whoever holds the credential.
        expect(wire.frames).toEqual([]);
      } finally {
        wire.close();
      }
    });
  });

  it("answers two callers waiting at once with the one report they share", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const joined = await enlist(harness);
      const { wire } = await greet(harness.base, joined.credential);
      try {
        await waitForRunner(
          harness.base,
          token,
          joined.runnerId,
          (one) => one.connectivity === "online",
        );

        // Two presses of the same button. Neither may be told the machine went
        // quiet because the other one was listening.
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

  it("answers a caller still waiting when the report lands after another gave up", async () => {
    await withServer(
      async (harness) => {
        const token = await completeSetup(harness.base);
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
          // Long enough that the second caller still has time in hand when the
          // first has run out of it.
          await delay(700);
          const late = refreshFacts(harness.base, token, joined.runnerId);
          expect((await early).status).toBe(409);

          wire.send({ _tag: "factsReport", facts: GROWN });
          const answered = await late;
          expect(answered.status, await answered.clone().text()).toBe(200);
          expect(((await answered.json()) as RunnerDetail).facts).toEqual(GROWN);
          // Giving up did not take the wait with it: the second caller joined
          // the wait the first left behind and was answered by the report.
          expect(wire.frames.filter((frame) => frame._tag === "factsRequest")).toHaveLength(2);
        } finally {
          wire.close();
        }
      },
      { factsDeadline: Duration.seconds(1) },
    );
  });

  it("asks again after a request nobody answered, and the next report lands", async () => {
    await withServer(
      async (harness) => {
        const token = await completeSetup(harness.base);
        const joined = await enlist(harness);
        const { wire } = await greet(harness.base, joined.credential);
        try {
          await waitForRunner(
            harness.base,
            token,
            joined.runnerId,
            (one) => one.connectivity === "online",
          );

          // The machine says nothing to the first request, and the caller runs
          // out of time with no report ever arriving.
          const abandoned = await refreshFacts(harness.base, token, joined.runnerId);
          expect(abandoned.status).toBe(409);
          await expectFactsRequest(wire);

          // Pressing the button again has to reach the machine. A request the
          // machine never answered is not one still in flight.
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

  it("gives up on a runner that never reports, saying how long it waited", async () => {
    await withServer(
      async (harness) => {
        const token = await completeSetup(harness.base);
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
          // The frame goes out, and the runner says nothing back.
          await expectFactsRequest(wire);

          const response = await pending;
          expect(response.status, await response.clone().text()).toBe(409);
          const refusal = (await response.json()) as { error: { code: string; message: string } };
          expect(refusal.error.code).toBe("invalid_state");
          // The refusal says how long the controller waited, so a slow machine
          // reads differently from a broken one, and it says the deadline this
          // server is running with rather than the shipped one.
          expect(refusal.error.message).toContain(Duration.format(FACTS_DEADLINE));
          // A machine that did not answer said nothing about itself either.
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
 * Against the shipped registry, so "one request per instance" is about the
 * three providers the binary really ships. The probe deadline and interval are
 * handed over like the ping interval: a real Bun listener cannot be driven by a
 * `TestClock`.
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
  models: [{ slug: "default", name: "Default", options: [] }],
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

  /** Short enough that a test can wait it out. */
  const PROBE_DEADLINE = Duration.millis(200);

  it("asks the runner about every instance as soon as it has said hello, and keeps what it answers", async () => {
    await withRegistry(async (harness) => {
      const token = await completeSetup(harness.base);
      const joined = await enlist(harness);
      const all = await listInstances(harness.base, token);
      // The three shipped providers, each with the instance the boot opened.
      expect(all.map((one) => one.providerId).sort()).toEqual(["claude-code", "codex", "pi"]);

      const { wire } = await greet(harness.base, joined.credential);
      try {
        const asked = await waitForProbeRequests(wire, all.length);
        // One request per instance, routed on the instance id and never on the
        // provider id: one provider can hold several accounts.
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

        // A provider this runner build cannot drive is a snapshot too: the row
        // reads why instead of staying blank for ever.
        const codex = await findInstanceFor(harness.base, token, "codex");
        const refused = await readSnapshot(harness.base, token, codex.id, joined.runnerId);
        expect(refused.auth.status).toBe("error");
        expect(refused.auth.message).toBe("no adapter for codex in this runner build");
      } finally {
        wire.close();
      }
    });
  });

  it("asks every online runner again when an instance's config changed", async () => {
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

        // The config is what the probe runs under, so every snapshot of it is
        // now stale.
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

  it("asks on demand and answers with the snapshot the report left behind", async () => {
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

  it("refuses to probe a runner that is not online, and sends that connection nothing", async () => {
    await withRegistry(async (harness) => {
      const token = await completeSetup(harness.base);
      const joined = await enlist(harness);
      const claude = await findInstanceFor(harness.base, token, "claude-code");
      // A socket with no hello: nothing has said it is a runner yet.
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

  it("gives up on a runner that never answers a probe, saying how long it waited", async () => {
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

        // A request id this controller never issued. Storing it would let a
        // runner write any instance's snapshot at any time.
        wire.send({
          _tag: "probeReport",
          requestId: "01999999-0000-7000-8000-00000000dead",
          instanceId: claude.id,
          result: buildProbeResult("0.0.0-unasked"),
        });
        // Then the real answer, so the test waits for something rather than
        // for a while.
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

  it("asks every instance of every online runner again on the interval", async () => {
    const INTERVAL = Duration.millis(150);
    await withRegistry(
      async (harness) => {
        const token = await completeSetup(harness.base);
        const joined = await enlist(harness);
        const all = await listInstances(harness.base, token);
        const { wire } = await greet(harness.base, joined.credential);
        try {
          // The hello's round, then the tick's: the whole set again, not just
          // whichever instance somebody last looked at.
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

  it("runs the installer, takes the machine's word for what it now has, and probes it", async () => {
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
        // The runner reports what the machine now has, then says the install
        // finished: the row must not answer with the machine as it was.
        wire.send({ _tag: "factsReport", facts: INSTALLED });
        wire.send({ _tag: "installResult", requestId: request.requestId, ok: true });

        const response = await pending;
        expect(response.status, await response.clone().text()).toBe(200);
        const row = (await response.json()) as RunnerDetail;
        expect(row.facts?.providers).toEqual(INSTALLED.providers);

        // A harness that was just installed has never been asked anything.
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

  it("says what the installer said when it failed, and leaves the machine as it was", async () => {
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
        // The installer's own words: "the install failed" is not something an
        // operator can act on.
        expect(refusal.error.message).toContain("could not download the manifest");
        expect((await readRunner(harness.base, token, joined.runnerId)).facts).toEqual(BARE);
      } finally {
        wire.close();
      }
    });
  });

  it("refuses a harness this runner build has no adapter for, before asking the machine", async () => {
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
        // The runner already said which adapters its build has.
        expect(wire.frames.filter((frame) => frame._tag === "installRequest")).toEqual([]);
      } finally {
        wire.close();
      }
    });
  });

  it("refuses to install on a runner that is not online", async () => {
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
 * Nothing about a login is stored - the code is only good for the live child's
 * URL - so these tests drive the wire and the refusals, not a record.
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

  /** A deadline a test can wait out. */
  const LOGIN_DEADLINE = Duration.millis(200);

  it("asks the machine to start a login and answers with the URL it printed", async () => {
    await withRegistry(async (harness) => {
      const token = await completeSetup(harness.base);
      const joined = await enlist(harness);
      const claude = await findInstanceFor(harness.base, token, "claude-code");
      const { wire } = await greet(harness.base, joined.credential);
      try {
        const pending = startLogin(harness.base, token, claude.id, joined.runnerId);
        const request = await waitForFrame<LoginStart>(wire, "loginStart");
        // Routed on the instance, because the config directory the credential
        // lands in is the instance's own.
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

  it("carries the one-time code back when the machine printed one instead of prompting", async () => {
    await withRegistry(async (harness) => {
      const token = await completeSetup(harness.base);
      const joined = await enlist(harness);
      const claude = await findInstanceFor(harness.base, token, "claude-code");
      const { wire } = await greet(harness.base, joined.credential);
      try {
        const pending = startLogin(harness.base, token, claude.id, joined.runnerId);
        const request = await waitForFrame<LoginStart>(wire, "loginStart");
        // A device login shows the user a code to type in the browser; there is
        // nothing for them to paste back here.
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

  it("says what the machine said when no URL came back", async () => {
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
        // The vendor's own words: a login that failed for a reason the user can
        // act on must not read as Hercule being broken.
        expect(refusal.error.message).toContain("could not reach platform.claude.com");
      } finally {
        wire.close();
      }
    });
  });

  it("gives up on a machine that never answers, saying how long it waited", async () => {
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

  it("refuses a provider this runner build has no adapter for, before asking the machine", async () => {
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

  it("refuses to log in on a runner that is not online, and sends that connection nothing", async () => {
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

  it("hands the pasted code to the machine and answers with the snapshot it left behind", async () => {
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

        // A harness that has just been logged in has never been asked who it is
        // holding, so the answer is a fresh snapshot rather than the stale one.
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

        // The code and the URL are good for one exchange and are never
        // written down.
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

  it("hands back what the CLI said about a bad code, and takes another", async () => {
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
        // A refusal the user can act on by pasting again, not a state the
        // exchange cannot recover from.
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

  it("refuses a code when no login is in progress", async () => {
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
