/**
 * The loopback listener a browser asks "which runner is on this machine?".
 *
 * Everything here is asserted over the wire, because the wire is the whole
 * point: a page served by the controller fetches this listener directly, so
 * what matters is the body it gets back, the CORS header that lets it read
 * that body, and the fact that nobody off this machine can reach it at all.
 *
 * The port is checked from both sides of its rule: the one it was asked for
 * when that one is free, and something else when it is not - a second runner on
 * one machine, or anything at all already sitting on the number, must not stop
 * a runner from starting. Every port here is one this test took and can give
 * back, because a fixed number is one every other runner on the machine, this
 * suite's own children included, is competing for.
 */
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { networkInterfaces } from "node:os";
import { IDENTITY_PORT_COUNT } from "@hydra/protocol";
import { identityListener } from "./identity";
import { probeFacts, type Machine } from "./probe";

/** A controller URL with a path on it: the header carries the origin, not the URL. */
const CONTROLLER_URL = "http://controller.test:4937/some/path";
const CONTROLLER_ORIGIN = "http://controller.test:4937";

const RUNNER_ID = "r_local";

/** Runs the listener, hands its bound port to the test, and closes it after. */
const withListener = <A>(
  options: { readonly runnerId: string; readonly controllerUrl: string; readonly port: number },
  use: (port: number) => Promise<A>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const port = yield* identityListener(options);
        return yield* Effect.promise(() => use(port));
      }),
    ),
  );

/** Holds a port the way another process would, until it is let go of. */
const occupy = (port: number): { readonly port: number; readonly release: () => Promise<void> } => {
  const server = Bun.serve({ port, hostname: "127.0.0.1", fetch: () => new Response("taken") });
  return { port: server.port!, release: () => server.stop(true) };
};

/**
 * A run of consecutive ports, all held. Nothing reserves the numbers after a
 * free one, so a run that turns out to be partly taken is given back and tried
 * again from somewhere else rather than failing as though the code were wrong.
 */
const occupyRun = async (
  length: number,
): Promise<{ readonly base: number; readonly release: () => Promise<void> }> => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const base = await freePort();
    const held: Array<{ readonly release: () => Promise<void> }> = [];
    try {
      for (let offset = 0; offset < length; offset += 1) held.push(occupy(base + offset));
      return {
        base,
        release: async () => void (await Promise.all(held.map((one) => one.release()))),
      };
    } catch {
      await Promise.all(held.map((one) => one.release()));
    }
  }
  throw new Error(`no run of ${String(length)} free ports on this machine`);
};

/** A port nothing is on, and nothing takes while this test holds the number. */
const freePort = async (): Promise<number> => {
  const held = occupy(0);
  await held.release();
  return held.port;
};

/** A non-loopback IPv4 address of this machine, or undefined when it has none. */
const lanAddress = (): string | undefined =>
  Object.values(networkInterfaces())
    .flat()
    .find((one) => one !== undefined && one.family === "IPv4" && !one.internal)?.address;

/** A machine with nothing installed: the facts test is about the port, not the tools. */
const bareMachine: Machine = {
  locate: () => undefined,
  version: () => Effect.succeed(undefined),
};

describe("what the listener answers", () => {
  it("names the runner and lets the controller origin read it", async () => {
    const { status, body, allowOrigin } = await withListener(
      { runnerId: RUNNER_ID, controllerUrl: CONTROLLER_URL, port: await freePort() },
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
    // The origin, not the whole controller URL: a browser matches origins.
    expect(allowOrigin).toBe(CONTROLLER_ORIGIN);
  });
});

describe("the port it binds", () => {
  it("takes the port it is asked for when that port is free", async () => {
    const wanted = await freePort();

    const port = await withListener(
      { runnerId: RUNNER_ID, controllerUrl: CONTROLLER_URL, port: wanted },
      (bound) => Promise.resolve(bound),
    );

    expect(port).toBe(wanted);
  });

  it("walks the whole set of ports a browser may ask before it gives up on one", async () => {
    // Every port in the set but the last, so the walk has to reach the end of
    // it. How many ports that is cannot be told apart here from the last-resort
    // bind - an ephemeral port is handed out from the same place - so the count
    // itself is pinned where it is enforced, in the policy the browser reads.
    const run = await occupyRun(IDENTITY_PORT_COUNT - 1);
    try {
      const { port, body } = await withListener(
        { runnerId: RUNNER_ID, controllerUrl: CONTROLLER_URL, port: run.base },
        async (bound) => {
          const response = await fetch(`http://127.0.0.1:${String(bound)}/identity`);
          return { port: bound, body: await response.json() };
        },
      );

      expect(port).toBe(run.base + IDENTITY_PORT_COUNT - 1);
      // A port it moved to is a port it actually serves on, not a number.
      expect(body).toEqual({ runnerId: RUNNER_ID });
    } finally {
      await run.release();
    }
  });

  it("still serves when every port a browser may ask is taken", async () => {
    // The last resort: a machine can host sessions without being one a page can
    // recognise, so the listener takes whatever is free rather than giving up.
    const run = await occupyRun(IDENTITY_PORT_COUNT);
    try {
      const { port, body } = await withListener(
        { runnerId: RUNNER_ID, controllerUrl: CONTROLLER_URL, port: run.base },
        async (bound) => {
          const response = await fetch(`http://127.0.0.1:${String(bound)}/identity`);
          return { port: bound, body: await response.json() };
        },
      );

      expect(port).toBeGreaterThanOrEqual(run.base + IDENTITY_PORT_COUNT);
      expect(body).toEqual({ runnerId: RUNNER_ID });
    } finally {
      await run.release();
    }
  });

  it("is the port the facts report", async () => {
    const held = occupy(0);
    try {
      const port = await withListener(
        { runnerId: RUNNER_ID, controllerUrl: CONTROLLER_URL, port: held.port },
        (bound) => Promise.resolve(bound),
      );
      const facts = await Effect.runPromise(probeFacts(bareMachine, port));

      // What the fleet is told is where the browser will actually find it.
      expect(facts.identityPort).toBe(port);
      expect(facts.identityPort).not.toBe(held.port);
    } finally {
      await held.release();
    }
  });

  it("lets the port go when the scope that opened it closes", async () => {
    const wanted = await freePort();

    const port = await withListener(
      { runnerId: RUNNER_ID, controllerUrl: CONTROLLER_URL, port: wanted },
      (bound) => Promise.resolve(bound),
    );

    // A runner that stopped must not leave the number held: the next one on
    // this machine would be pushed off it for the life of the process.
    const after = occupy(port);
    expect(after.port).toBe(port);
    await after.release();
  });
});

describe("who can reach it", () => {
  it("refuses everything that is not loopback", async ({ skip }) => {
    const lan = lanAddress();
    if (lan === undefined) skip("this machine has no non-loopback IPv4 address");

    const outcome = await withListener(
      { runnerId: RUNNER_ID, controllerUrl: CONTROLLER_URL, port: await freePort() },
      async (port) => {
        // Loopback first, so a failure off the machine is the binding and not
        // a listener that was never up.
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

describe("what it refuses", () => {
  const refusals = async (
    port: number,
  ): Promise<{ elsewhere: number; posted: number; renamed: number; named: number }> => {
    const elsewhere = await fetch(`http://127.0.0.1:${String(port)}/runner`);
    const posted = await fetch(`http://127.0.0.1:${String(port)}/identity`, { method: "POST" });
    // A name that resolves to 127.0.0.1 arrives here looking like loopback, so
    // a page on any website could otherwise read this as same-origin.
    const renamed = await fetch(`http://127.0.0.1:${String(port)}/identity`, {
      headers: { host: "a-name-that-resolves-here.example" },
    });
    // The other name for this machine, however it is spelled.
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

  it("answers only a GET of /identity that came to loopback by address", async () => {
    const wanted = await freePort();

    const seen = await withListener(
      { runnerId: RUNNER_ID, controllerUrl: CONTROLLER_URL, port: wanted },
      refusals,
    );

    expect(seen).toEqual({ elsewhere: 404, posted: 404, renamed: 404, named: 200 });
  });
});
