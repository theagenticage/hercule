/**
 * Tests the loopback listener a browser asks "which runner is on this
 * machine?".
 *
 * Every test makes real HTTP requests, because a page served by the
 * controller fetches this listener directly. What matters is:
 *
 * - the response body;
 * - the CORS header that lets the page read the body;
 * - that nothing outside this machine can reach the listener.
 *
 * The port tests cover both cases: the listener takes the requested port when
 * it is free, and another port when it is not. A second runner on the machine,
 * or any other process on that port, must not stop a runner from starting.
 * The tests never use a fixed port number, because every other runner on the
 * machine, including this suite's own child processes, may be using it.
 */
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { networkInterfaces } from "node:os";
import { IDENTITY_PORT_COUNT } from "@hercule/protocol";
import { serveIdentity } from "./identity";
import { probeFacts, type Machine } from "./probe";

/** A controller URL with a path, to show that the header holds only the origin. */
const CONTROLLER_URL = "http://controller.test:4937/some/path";
const CONTROLLER_ORIGIN = "http://controller.test:4937";

const RUNNER_ID = "r_local";

/** Starts the listener, passes its bound port to `use`, and closes the listener afterwards. */
const withListener = <A>(
  options: {
    readonly runnerId: string;
    readonly readControllerUrl: () => string;
    readonly port: number;
  },
  use: (port: number) => Promise<A>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const port = yield* serveIdentity(options);
        return yield* Effect.promise(() => use(port));
      }),
    ),
  );

/** Binds a port the way another process would, until `release` is called. */
const occupyPort = (
  port: number,
): { readonly port: number; readonly release: () => Promise<void> } => {
  const server = Bun.serve({ port, hostname: "127.0.0.1", fetch: () => new Response("taken") });
  return { port: server.port!, release: () => server.stop(true) };
};

/**
 * Binds `length` consecutive ports. Nothing reserves the ports after a free
 * one, so when some port in the range is already taken, the helper releases
 * the range and tries another one, instead of failing the test.
 */
const occupyPortRange = async (
  length: number,
): Promise<{
  readonly base: number;
  /** Releases one port of the range, so the listener under test can take it. */
  readonly releaseAt: (offset: number) => Promise<void>;
  readonly release: () => Promise<void>;
}> => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const base = await findFreePort();
    const held: Array<{ readonly release: () => Promise<void> }> = [];
    try {
      for (let offset = 0; offset < length; offset += 1) held.push(occupyPort(base + offset));
      const released = new Set<number>();
      const releaseAt = async (offset: number): Promise<void> => {
        released.add(offset);
        await held[offset]!.release();
      };
      return {
        base,
        releaseAt,
        release: async () =>
          void (await Promise.all(
            held.filter((_, offset) => !released.has(offset)).map((one) => one.release()),
          )),
      };
    } catch {
      await Promise.all(held.map((one) => one.release()));
    }
  }
  throw new Error(`no run of ${String(length)} free ports on this machine`);
};

/** Returns a port that was free a moment ago. Another process may still take it. */
const findFreePort = async (): Promise<number> => {
  const held = occupyPort(0);
  await held.release();
  return held.port;
};

/** Returns a non-loopback IPv4 address of this machine, or undefined when it has none. */
const findLanAddress = (): string | undefined =>
  Object.values(networkInterfaces())
    .flat()
    .find((one) => one !== undefined && one.family === "IPv4" && !one.internal)?.address;

/** A machine with nothing installed, because the facts test is about the port, not the tools. */
const bareMachine: Machine = {
  locate: () => undefined,
  version: () => Effect.succeed(undefined),
};

describe("the identity response", () => {
  it("returns the runner id and lets the controller origin read it", async () => {
    const { status, body, allowOrigin } = await withListener(
      { runnerId: RUNNER_ID, readControllerUrl: () => CONTROLLER_URL, port: await findFreePort() },
      async (port) => {
        const response = await fetch(`http://127.0.0.1:${port}/identity`);
        return {
          status: response.status,
          body: await response.json(),
          allowOrigin: response.headers.get("access-control-allow-origin"),
        };
      },
    );

    expect(status).toBe(200);
    expect(body).toEqual({ runnerId: RUNNER_ID });
    // The origin, not the whole controller URL, because a browser compares origins.
    expect(allowOrigin).toBe(CONTROLLER_ORIGIN);
  });

  it("lets the new controller origin read /identity after a re-point, without restarting", async () => {
    const newUrl = "http://b.example:9/moved";
    const newOrigin = "http://b.example:9";
    let controllerUrl = CONTROLLER_URL;

    await withListener(
      { runnerId: RUNNER_ID, readControllerUrl: () => controllerUrl, port: await findFreePort() },
      async (port) => {
        const before = await fetch(`http://127.0.0.1:${String(port)}/identity`);
        expect(before.headers.get("access-control-allow-origin")).toBe(CONTROLLER_ORIGIN);
        controllerUrl = newUrl;
        const after = await fetch(`http://127.0.0.1:${String(port)}/identity`);
        expect(after.status).toBe(200);
        expect(after.headers.get("access-control-allow-origin")).toBe(newOrigin);
      },
    );
  });
});

describe("the port the listener binds", () => {
  it("takes the requested port when that port is free", async () => {
    const wanted = await findFreePort();

    const port = await withListener(
      { runnerId: RUNNER_ID, readControllerUrl: () => CONTROLLER_URL, port: wanted },
      (bound) => Promise.resolve(bound),
    );

    expect(port).toBe(wanted);
  });

  it("tries every port in the set the web app checks before it takes a random one", async () => {
    // Take every port in the set except the last, so the listener has to try
    // them all. This test cannot tell a correct port count apart from the
    // random fallback, because both can hand out the same ports. So the count
    // itself is tested where the web app reads it.
    //
    // The test binds the whole set first, and releases the last port only once
    // the rest are held. Another process can still take that free port in the
    // meantime, and then the listener falls back to a random port. That is a
    // race with another process, not a bug, so the test tries again.
    const attempt = async (): Promise<{ landed: boolean; body: unknown }> => {
      const run = await occupyPortRange(IDENTITY_PORT_COUNT);
      await run.releaseAt(IDENTITY_PORT_COUNT - 1);
      try {
        const { port, body } = await withListener(
          { runnerId: RUNNER_ID, readControllerUrl: () => CONTROLLER_URL, port: run.base },
          async (bound) => {
            const response = await fetch(`http://127.0.0.1:${String(bound)}/identity`);
            return { port: bound, body: await response.json() };
          },
        );
        return { landed: port === run.base + IDENTITY_PORT_COUNT - 1, body };
      } finally {
        await run.release();
      }
    };

    let last = await attempt();
    for (let tries = 0; tries < 5 && !last.landed; tries += 1) last = await attempt();

    expect(last.landed, "the walk reached the last port of the set").toBe(true);
    // The listener really serves on the port it reported.
    expect(last.body).toEqual({ runnerId: RUNNER_ID });
  });

  it("still serves when every port in the set is taken", async () => {
    // The fallback: a machine can host sessions even when the web app cannot
    // recognise it, so the listener takes any free port instead of giving up.
    const run = await occupyPortRange(IDENTITY_PORT_COUNT);
    try {
      const { port, body } = await withListener(
        { runnerId: RUNNER_ID, readControllerUrl: () => CONTROLLER_URL, port: run.base },
        async (bound) => {
          const response = await fetch(`http://127.0.0.1:${String(bound)}/identity`);
          return { port: bound, body: await response.json() };
        },
      );

      // The OS picks the fallback port, and it may be below or above the taken
      // range. The test only checks that the port is outside the range and
      // that the listener serves on it.
      const inRun = port >= run.base && port < run.base + IDENTITY_PORT_COUNT;
      expect(inRun).toBe(false);
      expect(body).toEqual({ runnerId: RUNNER_ID });
    } finally {
      await run.release();
    }
  });

  it("reports the bound port in the runner's facts", async () => {
    const held = occupyPort(0);
    try {
      const port = await withListener(
        { runnerId: RUNNER_ID, readControllerUrl: () => CONTROLLER_URL, port: held.port },
        (bound) => Promise.resolve(bound),
      );
      const facts = await Effect.runPromise(probeFacts(bareMachine, port));

      // The facts must hold the port the browser will actually find.
      expect(facts.identityPort).toBe(port);
      expect(facts.identityPort).not.toBe(held.port);
    } finally {
      await held.release();
    }
  });

  it("releases the port when its scope closes", async () => {
    const wanted = await findFreePort();

    const port = await withListener(
      { runnerId: RUNNER_ID, readControllerUrl: () => CONTROLLER_URL, port: wanted },
      (bound) => Promise.resolve(bound),
    );

    // A runner that stopped must not keep the port. Otherwise the next runner
    // on this machine would have to use another port for as long as the
    // process lives.
    const after = occupyPort(port);
    expect(after.port).toBe(port);
    await after.release();
  });
});

describe("who can reach the listener", () => {
  it("is not reachable on a non-loopback address", async ({ skip }) => {
    const lan = findLanAddress();
    if (lan === undefined) skip("this machine has no non-loopback IPv4 address");

    const outcome = await withListener(
      { runnerId: RUNNER_ID, readControllerUrl: () => CONTROLLER_URL, port: await findFreePort() },
      async (port) => {
        // Check loopback first, so a failure on the LAN address proves the
        // binding and not a listener that never started.
        const near = await fetch(`http://127.0.0.1:${port}/identity`);
        try {
          const far = await fetch(`http://${lan}:${port}/identity`, {
            signal: AbortSignal.timeout(2000),
          });
          return { near: near.status, far: far.status as number | "refused" };
        } catch {
          return { near: near.status, far: "refused" as const };
        }
      },
    );

    expect(outcome.near).toBe(200);
    expect(outcome.far).toBe("refused");
  });
});

describe("requests the listener rejects", () => {
  const fetchRefusals = async (
    port: number,
  ): Promise<{ elsewhere: number; posted: number; renamed: number; named: number }> => {
    const elsewhere = await fetch(`http://127.0.0.1:${String(port)}/runner`);
    const posted = await fetch(`http://127.0.0.1:${String(port)}/identity`, { method: "POST" });
    // A DNS name that resolves to 127.0.0.1 looks like loopback here, so
    // without the `Host` check a page on any website could read the response.
    const renamed = await fetch(`http://127.0.0.1:${String(port)}/identity`, {
      headers: { host: "a-name-that-resolves-here.example" },
    });
    // `localhost` is allowed, in any letter case.
    const named = await fetch(`http://127.0.0.1:${String(port)}/identity`, {
      headers: { host: `LocalHost:${String(port)}` },
    });
    return {
      elsewhere: elsewhere.status,
      posted: posted.status,
      renamed: renamed.status,
      named: named.status,
    };
  };

  it("responds only to a GET of /identity with a loopback Host header", async () => {
    const wanted = await findFreePort();

    const seen = await withListener(
      { runnerId: RUNNER_ID, readControllerUrl: () => CONTROLLER_URL, port: wanted },
      fetchRefusals,
    );

    expect(seen).toEqual({ elsewhere: 404, posted: 404, renamed: 404, named: 200 });
  });
});
