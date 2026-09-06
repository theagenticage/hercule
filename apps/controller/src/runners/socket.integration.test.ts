/**
 * The runner socket against the real controller: who is let in, what the two
 * ends say to each other first, and what the liveness check does to the row.
 *
 * This drives a real WebSocket against a real listener, because the whole point
 * of the socket is the wire. The credential is a real one, handed back by a real
 * join, and the frames are the published catalogue's, decoded rather than eyed:
 * a controller that answers something `@hydra/protocol` cannot read is a
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
  signedChallenge,
  type ControllerHello,
  type ControllerToRunner as ControllerMessage,
  type JoinAnswer,
  type RunnerFacts,
  type RunnerHello,
  type RunnerToController as RunnerMessage,
} from "@hydra/protocol";
import type { RunnerDetail } from "@hydra/contract";
import { uuidFromString } from "../db";
import { completeSetup, get, send, withServer, type ServerHarness } from "../http/testing";
// The two shipped durations are read off the domain's own exports rather than
// imported by name, so a file that is otherwise about the wire still reports
// each behaviour's failure separately when the constants are not there yet.
import { RUNNER_PING_INTERVAL, RUNNER_SILENCE_LIMIT } from "./socket";

/** Where a runner dials, on the same authority the API is served from. */
const SOCKET_PATH = "/api/v1/runners/socket";

const socketUrl = (base: string): string => `${base.replace(/^http:/, "ws:")}${SOCKET_PATH}`;

/** Standard base64, which is how the catalogue carries bytes. */
const base64 = (raw: Uint8Array): string => Buffer.from(raw).toString("base64");

/** The bytes standard base64 stands for, in a buffer WebCrypto will take. */
const bytes = (encoded: string): Uint8Array<ArrayBuffer> => {
  const decoded = Buffer.from(encoded, "base64");
  const out = new Uint8Array(decoded.byteLength);
  out.set(decoded);
  return out;
};

/** A fresh nonce, the way a runner makes one. */
const nonce = (): string => base64(crypto.getRandomValues(new Uint8Array(16)));

/** What a runner in these tests says about the machine it is on. */
const FACTS: RunnerFacts = {
  os: "darwin",
  arch: "arm64",
  totalMemoryBytes: 68719476736,
  docker: false,
  toolchains: [{ name: "git", version: "2.50.1", path: "/usr/bin/git" }],
  providers: [{ name: "claude", present: true, path: "/usr/local/bin/claude" }],
  identityPort: 4939,
};

const THIS_BUILD = "0.1.0";

const GIB = 1024 * 1024 * 1024;

const decodeFrame = (raw: unknown): ControllerMessage =>
  Effect.runSync(Schema.decodeUnknownEffect(ControllerToRunner)(raw));

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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

/**
 * Opens the socket with a credential, as a runner does: the credential rides
 * the upgrade request, so a connection that opens has already been let in.
 */
const dial = (base: string, credential: string): Promise<Wire> =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(socketUrl(base), {
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
const opens = (base: string, authorization?: string): Promise<"open" | "refused" | "hung"> =>
  new Promise((resolve) => {
    const socket = new WebSocket(socketUrl(base), {
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
const upgrade = (base: string, authorization?: string): Promise<Response> =>
  fetch(`${base}${SOCKET_PATH}`, {
    headers: {
      connection: "Upgrade",
      upgrade: "websocket",
      "sec-websocket-key": base64(crypto.getRandomValues(new Uint8Array(16))),
      "sec-websocket-version": "13",
      ...(authorization === undefined ? {} : { authorization }),
    },
  });

/** A runner's opening frame, in this build's version unless a test says otherwise. */
const helloFrom = (overrides: Partial<RunnerHello> = {}): RunnerHello => ({
  _tag: "runnerHello",
  protocolVersion: PROTOCOL_VERSION,
  capabilities: [],
  binaryVersion: THIS_BUILD,
  nonce: nonce(),
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

/** The row once it says what the test is waiting for, or as it stubbornly is. */
const rowWhen = async (
  base: string,
  token: string,
  id: string,
  ready: (row: RunnerDetail) => boolean,
): Promise<RunnerDetail> => {
  let row = await readRunner(base, token, id);
  for (let attempt = 0; attempt < 300 && !ready(row); attempt++) {
    await delay(10);
    row = await readRunner(base, token, id);
  }
  return row;
};

/** Whether the controller's signature over the given bytes is really its own. */
const verifies = async (
  hello: ControllerHello,
  payload: Uint8Array<ArrayBuffer>,
): Promise<boolean> => {
  const key = await crypto.subtle.importKey(
    "spki",
    bytes(hello.publicKey),
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify({ name: "Ed25519" }, key, bytes(hello.signature), payload);
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
  const sent = helloFrom(overrides);
  wire.send(sent);
  const answer = await wire.next();
  expect(answer._tag, JSON.stringify(answer)).toBe("controllerHello");
  return { wire, sent, answer: answer as ControllerHello };
};

/** The states the log says the runner passed through, oldest first. */
const transitions = async (harness: ServerHarness): Promise<ReadonlyArray<unknown>> =>
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
        const response = await upgrade(harness.base, header);
        expect(response.status, what).toBe(401);
        expect(await response.json(), what).toMatchObject({
          error: { code: "unauthenticated" },
        });
        expect(await opens(harness.base, header), what).toBe("refused");
      }

      // A revoked runner is a retired one: its credential stops opening the
      // socket the moment the row is terminal.
      const live = await opens(harness.base, `Bearer ${joined.credential}`);
      expect(live, "the credential opened the socket before the runner was retired").toBe("open");
      await Effect.runPromise(
        Effect.orDie(harness.sql.unsafe(`UPDATE runners SET lifecycle = 'retired'`)),
      );

      const revoked = await upgrade(harness.base, `Bearer ${joined.credential}`);
      expect(revoked.status, "retired").toBe(401);
      expect(await opens(harness.base, `Bearer ${joined.credential}`), "retired").toBe("refused");
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
      expect(await verifies(answer, signedChallenge(joined.runnerId, sent.nonce))).toBe(true);
      // Over the nonce alone the same signature is good on any connection, so a
      // peer holding any runner's credential could relay it to this one.
      expect(await verifies(answer, bytes(sent.nonce))).toBe(false);

      const row = await rowWhen(
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

      const row = await rowWhen(
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
      wire.send(helloFrom({ protocolVersion: PROTOCOL_VERSION + 1 }));

      const ending = await wire.closed();
      expect(ending.reason, "a refused hello is a close with a reason").not.toBe("");
      // A refusal is a close, not a message: the catalogue has no error member.
      expect(wire.frames).toEqual([]);

      const row = await readRunner(harness.base, token, joined.runnerId);
      expect(row.connectivity).toBe("offline");
      expect(row.lastSeenAt).toBeNull();
      expect(row.version).toBeNull();
      expect(await transitions(harness)).toEqual([]);
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
            await rowWhen(
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
        const row = await rowWhen(
          harness.base,
          token,
          joined.runnerId,
          (one) => one.connectivity === "unreachable",
        );
        expect(row.connectivity).toBe("unreachable");
        expect(await transitions(harness)).toEqual(["online", "unreachable"]);
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
        wire.send(helloFrom());
        wire.send(helloFrom());

        const ending = await wire.closed();
        expect(ending.code, "the second hello was refused").toBe(PROTOCOL_ERROR);
        expect(ending.reason).not.toBe("");
        expect(wire.frames.filter((frame) => frame._tag === "controllerHello")).toHaveLength(1);
        expect(await transitions(harness)).toEqual(["online", "unreachable"]);
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
            await rowWhen(
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
        expect(await transitions(harness)).toEqual(["online"]);

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

        const first = await rowWhen(
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

        const later = await rowWhen(
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
        expect(await transitions(harness)).toEqual(["online"]);

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
            await rowWhen(
              harness.base,
              token,
              joined.runnerId,
              (one) => one.connectivity === "online",
            )
          ).connectivity,
        ).toBe("online");

        // The socket stays up and the runner says nothing on it, which is the
        // case a transport-level ping would have hidden.
        const row = await rowWhen(
          harness.base,
          token,
          joined.runnerId,
          (one) => one.connectivity === "unreachable",
        );
        expect(row.connectivity).toBe("unreachable");

        expect(await transitions(harness)).toEqual(["online", "unreachable"]);
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
            await rowWhen(
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
            await rowWhen(
              harness.base,
              token,
              joined.runnerId,
              (one) => one.connectivity === "offline",
            )
          ).connectivity,
        ).toBe("offline");
        // It never passed through `unreachable` on the way: the departure was
        // announced, so there was no silence to interpret.
        expect(await transitions(harness)).toEqual(["online", "offline"]);

        // A new hello takes it back out of `offline`.
        const back = await greet(harness.base, joined.credential);
        expect(
          (
            await rowWhen(
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
            await rowWhen(
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
            await rowWhen(
              harness.base,
              token,
              joined.runnerId,
              (one) => one.connectivity === "online",
            )
          ).connectivity,
        ).toBe("online");

        expect(await transitions(harness)).toEqual([
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
  const watermarkOf = (diskFreeBytes: number, acceptingPlacements: boolean) => ({
    diskFreeBytes,
    availableMemoryBytes: 16 * 1024 * 1024 * 1024,
    acceptingPlacements,
  });

  it("stores the watermark a runner reports and hands it back on the row", async () => {
    await withServer(
      async (harness) => {
        const token = await completeSetup(harness.base);
        const joined = await enlist(harness);
        const { wire } = await greet(harness.base, joined.credential);

        const online = await rowWhen(
          harness.base,
          token,
          joined.runnerId,
          (one) => one.connectivity === "online",
        );
        // A runner that has only just said hello has said nothing about its
        // disk yet.
        expect(online.watermark).toBeNull();

        wire.send({ _tag: "watermarkReport", watermark: watermarkOf(200 * GIB, true) });
        const stored = await rowWhen(
          harness.base,
          token,
          joined.runnerId,
          (one) => one.watermark !== null,
        );
        expect(stored.watermark).toEqual(watermarkOf(200 * GIB, true));

        const before = await harness.audit("runner.placementsChanged");
        // A machine nobody had heard from is taken to be accepting work, so a
        // first reading of a healthy disk is not news about it.
        expect(before).toHaveLength(0);

        // The same reading again, then a different disk that means the same
        // thing for placement. Waiting for the second one to land is what
        // proves the first was seen and deliberately left no row.
        wire.send({ _tag: "watermarkReport", watermark: watermarkOf(200 * GIB, true) });
        wire.send({ _tag: "watermarkReport", watermark: watermarkOf(150 * GIB, true) });
        const again = await rowWhen(
          harness.base,
          token,
          joined.runnerId,
          (one) => one.watermark?.diskFreeBytes === 150 * GIB,
        );
        expect(again.watermark).toEqual(watermarkOf(150 * GIB, true));
        expect(
          await harness.audit("runner.placementsChanged"),
          "nothing about placement changed",
        ).toHaveLength(before.length);

        // The disk filled up: this one is a change of what the fleet may do
        // with the machine, and that is what gets recorded.
        wire.send({ _tag: "watermarkReport", watermark: watermarkOf(4 * GIB, false) });
        const short = await rowWhen(
          harness.base,
          token,
          joined.runnerId,
          (one) => one.watermark?.acceptingPlacements === false,
        );
        expect(short.watermark).toEqual(watermarkOf(4 * GIB, false));

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
  });

  it("records a machine that comes back with no room left", async () => {
    await withServer(
      async (harness) => {
        const token = await completeSetup(harness.base);
        const joined = await enlist(harness);
        const { wire } = await greet(harness.base, joined.credential);
        await rowWhen(harness.base, token, joined.runnerId, (one) => one.connectivity === "online");

        // Its very first reading, and the disk is full. Nothing had been heard
        // about this machine before, but a machine that cannot take work is
        // news whether or not anything was.
        wire.send({ _tag: "watermarkReport", watermark: watermarkOf(4 * GIB, false) });
        await rowWhen(harness.base, token, joined.runnerId, (one) => one.watermark !== null);

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

        const online = await rowWhen(
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

        const changed = await rowWhen(
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

        const sixteen = await rowWhen(
          harness.base,
          token,
          joined.runnerId,
          (one) => one.facts?.totalMemoryBytes === 16 * GIB,
        );
        expect(sixteen.maxConcurrentSessions).toBe(8);

        // A machine too small for even one 2 GiB session still takes one.
        wire.send({ _tag: "factsReport", facts: { ...FACTS, totalMemoryBytes: 3 * GIB } });
        const small = await rowWhen(
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
        const overridden = await rowWhen(
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
        await rowWhen(harness.base, token, joined.runnerId, (one) => one.connectivity === "online");

        // A column written by a build that said something else. The read side
        // answers it as absent; the write side must not choke on it, or this
        // runner would lose its socket a minute after every hello, forever.
        await Effect.runPromise(
          Effect.orDie(
            harness.sql`UPDATE runners SET watermark = 'not json at all'
                        WHERE id = ${uuidFromString(joined.runnerId)}`,
          ),
        );

        wire.send({ _tag: "watermarkReport", watermark: watermarkOf(200 * GIB, true) });
        const stored = await rowWhen(
          harness.base,
          token,
          joined.runnerId,
          (one) => one.watermark !== null,
        );
        expect(stored.watermark).toEqual(watermarkOf(200 * GIB, true));
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

        wire.send({ _tag: "watermarkReport", watermark: watermarkOf(4 * GIB, false) });
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

        const online = await rowWhen(
          harness.base,
          token,
          joined.runnerId,
          (one) => one.connectivity === "online",
        );
        expect(online.lastSeenAt).not.toBeNull();

        // Long enough that a report which touched the timestamp would show it.
        await delay(50);
        wire.send({ _tag: "watermarkReport", watermark: watermarkOf(200 * GIB, true) });
        wire.send({ _tag: "factsReport", facts: { ...FACTS, docker: true } });

        const reported = await rowWhen(
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
  /** The dispatcher, run from source: `hydra` before it is compiled. */
  const HYDRA = `${import.meta.dirname}/../../../../packages/hydra/src/main.ts`;

  it("leaves the row offline when the child is asked to stop, never unreachable", async () => {
    const home = mkdtempSync(join(tmpdir(), "hydra-local-child-"));
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const child = Bun.spawn(
        [process.execPath, "run", HYDRA, "runner", "--local", "--home", home],
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

        const row = await rowWhen(
          harness.base,
          token,
          runnerId,
          (one) => one.connectivity === "offline",
        );
        expect(row.connectivity).toBe("offline");
        // Never through `unreachable`: a runner that says goodbye was not lost.
        expect(await transitions(harness)).toEqual(["online", "offline"]);
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

  const retire = (base: string, token: string, id: string): Promise<Response> =>
    send("POST", base, `/api/v1/runners/${id}/retire`, { body: {}, token });

  it("closes the live connection saying the runner was retired", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const joined = await enlist(harness);
      const { wire } = await greet(harness.base, joined.credential);
      expect(
        (
          await rowWhen(
            harness.base,
            token,
            joined.runnerId,
            (one) => one.connectivity === "online",
          )
        ).connectivity,
      ).toBe("online");

      const response = await retire(harness.base, token, joined.runnerId);
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

      expect((await retire(harness.base, token, joined.runnerId)).status).toBe(200);

      const revoked = await upgrade(harness.base, `Bearer ${joined.credential}`);
      expect(revoked.status).toBe(401);
      const refusal = (await revoked.json()) as { error: { code: string; message: string } };
      expect(refusal.error.code).toBe("unauthenticated");
      // The machine is holding a credential that was real: it needs to be sent
      // to `join`, not left retrying a credential it thinks is merely unknown.
      expect(refusal.error.message).toContain("retired");
      expect(await opens(harness.base, `Bearer ${joined.credential}`)).toBe("refused");

      const stranger = await upgrade(harness.base, "Bearer a-credential-nobody-was-issued");
      expect(stranger.status).toBe(401);
      const unknown = (await stranger.json()) as { error: { code: string; message: string } };
      expect(unknown.error.message).toContain("unknown credential");
      expect(unknown.error.message).not.toContain("retired");
    });
  });
});
