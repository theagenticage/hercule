/**
 * Tests `hercule runner --local`, the child process the controller supervises.
 * The tests run it as a real process, read its stdout as it arrives, and hold
 * its stdin the way the controller does.
 *
 * The only thing that sets this entry point apart from `hercule runner` is the
 * handshake on those two pipes. So the test spawns the real dispatcher instead
 * of calling a function: if the first line is one byte off, or something is
 * printed before it, the controller cannot tell what it spawned. The
 * controller is a stub HTTP server, because these tests are not about the
 * controller's responses.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { locateRunnerDir } from "@hercule/home";

/** The dispatcher's source entry point, which runs `hercule` without compiling it. */
const HERCULE = join(
  dirname(import.meta.dirname),
  "..",
  "..",
  "packages",
  "hercule",
  "src",
  "main.ts",
);

const homes: Array<string> = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const createTemporaryHome = (): string => {
  const home = mkdtempSync(join(tmpdir(), "hercule-local-runner-"));
  homes.push(home);
  return home;
};

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Creates a Hercule Home that has already joined the controller at `controllerUrl`. */
const createEnrolledHome = (controllerUrl: string, runnerId: string): string => {
  const home = createTemporaryHome();
  mkdirSync(locateRunnerDir(home), { recursive: true });
  writeFileSync(
    join(locateRunnerDir(home), "runner.json"),
    JSON.stringify({
      runnerId,
      credential: "the-credential-the-join-handed-back",
      controllerUrl,
      controllerIdentityId: "0199e0e7-1111-7000-8000-000000000000",
      controllerPublicKey: "AAAA",
      storageDirectory: "deadbeefdeadbeef",
    }),
  );
  return home;
};

/** A request the stub controller received. */
interface Asked {
  readonly path: string;
  readonly authorization: string | null;
}

/** The child process, with its pipes held the way the controller holds them. */
interface Child {
  /** Everything the child has written to stdout so far. */
  readonly out: () => string;
  readonly err: () => string;
  readonly write: (text: string) => void;
  readonly closeStdin: () => void;
  readonly exited: Promise<number>;
  readonly kill: () => void;
}

const spawnLocalRunner = (home: string): Child => {
  const process_ = Bun.spawn(
    [process.execPath, "run", HERCULE, "runner", "--local", "--home", home],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  let out = "";
  let err = "";
  const drain = async (stream: ReadableStream<Uint8Array>, take: (text: string) => void) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) take(decoder.decode(chunk, { stream: true }));
  };
  void drain(process_.stdout, (text) => {
    out += text;
  });
  void drain(process_.stderr, (text) => {
    err += text;
  });
  return {
    out: () => out,
    err: () => err,
    write: (text) => {
      void process_.stdin.write(text);
    },
    closeStdin: () => void process_.stdin.end(),
    exited: process_.exited,
    kill: () => process_.kill("SIGKILL"),
  };
};

/** Waits until `ready` returns true, or until `within` ms pass. Never fails: the assertion after it reports what went wrong. */
const waitUntil = async (ready: () => boolean, within = 10_000): Promise<void> => {
  for (let waited = 0; waited < within && !ready(); waited += 20) await delay(20);
};

describe("hercule runner --local", () => {
  it("prints its runner id as its first line, and prints nothing else before it connects", async () => {
    const runnerId = "0199e0e7-0000-7000-8000-000000000000";
    const asked: Array<Asked> = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        asked.push({
          path: new URL(request.url).pathname,
          authorization: request.headers.get("authorization"),
        });
        return new Response("no", { status: 401 });
      },
    });
    const child = spawnLocalRunner(
      createEnrolledHome(`http://127.0.0.1:${String(server.port)}`, runnerId),
    );

    try {
      await waitUntil(() => asked.length > 0);
      // By the time it connects, it has printed exactly one line: the
      // announcement, with nothing else in it.
      expect(child.out()).toBe(`{"runnerId":"${runnerId}"}\n`);
      expect(asked[0]?.path).toBe("/api/v1/runners/socket");
    } finally {
      child.kill();
      await server.stop(true);
    }
  }, 30_000);

  it("asks to join when it has not joined, and joins with the token it receives", async () => {
    const token = "a-single-use-join-token";
    const asked: Array<Asked> = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        asked.push({ path, authorization: request.headers.get("authorization") });
        if (path !== "/api/v1/runners/join") return new Response("no", { status: 401 });
        return Response.json(
          {
            runnerId: "0199e0e7-2222-7000-8000-000000000000",
            name: "amber-otter",
            credential: "the-credential-the-join-handed-back",
            controllerIdentityId: "0199e0e7-1111-7000-8000-000000000000",
            controllerPublicKey: "AAAA",
          },
          { status: 201 },
        );
      },
    });
    // No `runner.json`: this machine has never joined anything.
    const home = createTemporaryHome();
    const child = spawnLocalRunner(home);

    try {
      await waitUntil(() => child.out() !== "");
      expect(child.out()).toBe('{"join":true}\n');
      // The token never goes through argv or the environment, only stdin.
      child.write(
        `${JSON.stringify({ controllerUrl: `http://127.0.0.1:${String(server.port)}`, token })}\n`,
      );
      child.closeStdin();

      await waitUntil(() => asked.some((one) => one.path === "/api/v1/runners/join"));
      const join = asked.find((one) => one.path === "/api/v1/runners/join");
      expect(join, `it never joined; stderr: ${JSON.stringify(child.err())}`).toBeDefined();
      expect(join?.authorization).toBe(`Bearer ${token}`);

      // Once joined, the child says which runner it now is, so the controller
      // knows its local runner without waiting for the next start.
      await waitUntil(() => child.out().includes("runnerId"));
      expect(child.out()).toBe(
        '{"join":true}\n{"runnerId":"0199e0e7-2222-7000-8000-000000000000"}\n',
      );
    } finally {
      child.kill();
      await server.stop(true);
    }
  }, 30_000);

  it("keeps trying to join a controller that is not listening yet", async () => {
    const token = "a-single-use-join-token";
    // The controller spawns its runner before it binds its port, so nothing
    // listens on the address for the first moments of the child's life.
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
    const port = Number(server.port);
    await server.stop(true);

    const child = spawnLocalRunner(createTemporaryHome());
    let asked = 0;
    let listener: ReturnType<typeof Bun.serve> | undefined;

    try {
      await waitUntil(() => child.out() !== "");
      expect(child.out()).toBe('{"join":true}\n');
      child.write(
        `${JSON.stringify({ controllerUrl: `http://127.0.0.1:${String(port)}`, token })}\n`,
      );
      child.closeStdin();

      // Long enough for the first attempts to fail with nothing listening.
      await delay(300);
      listener = Bun.serve({
        hostname: "127.0.0.1",
        port,
        fetch(request) {
          if (new URL(request.url).pathname !== "/api/v1/runners/join") {
            return new Response("no", { status: 401 });
          }
          asked += 1;
          return Response.json(
            {
              runnerId: "0199e0e7-3333-7000-8000-000000000000",
              name: "amber-otter",
              credential: "the-credential-the-join-handed-back",
              controllerIdentityId: "0199e0e7-1111-7000-8000-000000000000",
              controllerPublicKey: "AAAA",
            },
            { status: 201 },
          );
        },
      });

      await waitUntil(() => asked > 0);
      expect(asked, `it gave up before the controller started; stderr: ${child.err()}`).toBe(1);
    } finally {
      child.kill();
      await listener?.stop(true);
    }
  }, 30_000);

  it("exits with an error when stdin closes without a token", async () => {
    const child = spawnLocalRunner(createTemporaryHome());

    await waitUntil(() => child.out() !== "");
    expect(child.out()).toBe('{"join":true}\n');
    // The controller closed the pipe without writing anything, so the runner
    // cannot join and has nothing to wait for.
    child.closeStdin();

    const code = await child.exited;
    expect(code).not.toBe(0);
    expect(child.err()).not.toBe("");
  }, 30_000);
});
