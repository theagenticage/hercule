/**
 * `hercule runner --local`: the supervised child, driven the only way its
 * contract can be driven - as a process, with its stdout read a byte at a time
 * and its stdin held by whoever spawned it.
 *
 * The whole of what makes this entry point different from `hercule runner` is the
 * handshake on those two pipes, so the test spawns the real dispatcher rather
 * than calling into a function: a first line that is one byte off, or a line
 * printed after something else, is a controller that cannot tell what it
 * spawned. The controller it talks to is a stub listener, because none of this
 * is about what a controller answers.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runnerDirIn } from "@hercule/home";

/** The dispatcher, run from source: `hercule` before it is compiled. */
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

const temporaryHome = (): string => {
  const home = mkdtempSync(join(tmpdir(), "hercule-local-runner-"));
  homes.push(home);
  return home;
};

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A home this machine has already joined from, pointed at this address. */
const enrolledAt = (controllerUrl: string, runnerId: string): string => {
  const home = temporaryHome();
  mkdirSync(runnerDirIn(home), { recursive: true });
  writeFileSync(
    join(runnerDirIn(home), "runner.json"),
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

/** What the stub controller was asked for, in the order it was asked. */
interface Asked {
  readonly path: string;
  readonly authorization: string | null;
}

/** The child, with its pipes held the way the controller holds them. */
interface Child {
  /** Everything it has written to stdout so far. */
  readonly out: () => string;
  readonly err: () => string;
  readonly write: (text: string) => void;
  readonly closeStdin: () => void;
  readonly exited: Promise<number>;
  readonly kill: () => void;
}

const spawnLocal = (home: string): Child => {
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

/** Waits for a condition, or gives up and lets the assertion say what it saw. */
const until = async (ready: () => boolean, within = 10_000): Promise<void> => {
  for (let waited = 0; waited < within && !ready(); waited += 20) await delay(20);
};

describe("hercule runner --local", () => {
  it("says who it is on its first line, and says nothing else before it dials", async () => {
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
    const child = spawnLocal(enrolledAt(`http://127.0.0.1:${String(server.port)}`, runnerId));

    try {
      await until(() => asked.length > 0);
      // Whatever it has printed by the time it dials is all it prints before
      // dialing, and it is one line, with no room in it for anything else.
      expect(child.out()).toBe(`{"runnerId":"${runnerId}"}\n`);
      expect(asked[0]?.path).toBe("/api/v1/runners/socket");
    } finally {
      child.kill();
      await server.stop(true);
    }
  }, 30_000);

  it("asks to join when it has not, and joins with the token it is handed", async () => {
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
    const home = temporaryHome();
    const child = spawnLocal(home);

    try {
      await until(() => child.out() !== "");
      expect(child.out()).toBe('{"join":true}\n');
      // The token never touches argv or the environment; it arrives here.
      child.write(
        `${JSON.stringify({ controllerUrl: `http://127.0.0.1:${String(server.port)}`, token })}\n`,
      );
      child.closeStdin();

      await until(() => asked.some((one) => one.path === "/api/v1/runners/join"));
      const join = asked.find((one) => one.path === "/api/v1/runners/join");
      expect(join, `it never joined; it said ${JSON.stringify(child.err())}`).toBeDefined();
      expect(join?.authorization).toBe(`Bearer ${token}`);
    } finally {
      child.kill();
      await server.stop(true);
    }
  }, 30_000);

  it("keeps trying to join a controller that is not listening yet", async () => {
    const token = "a-single-use-join-token";
    // The controller spawns its runner before it binds, so the address it hands
    // over answers nothing for the first moments of the child's life.
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
    const port = Number(server.port);
    await server.stop(true);

    const child = spawnLocal(temporaryHome());
    let asked = 0;
    let listener: ReturnType<typeof Bun.serve> | undefined;

    try {
      await until(() => child.out() !== "");
      expect(child.out()).toBe('{"join":true}\n');
      child.write(
        `${JSON.stringify({ controllerUrl: `http://127.0.0.1:${String(port)}`, token })}\n`,
      );
      child.closeStdin();

      // Long enough for the first attempts to fail against nothing at all.
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

      await until(() => asked > 0);
      expect(asked, `it gave up before the controller was there; it said ${child.err()}`).toBe(1);
    } finally {
      child.kill();
      await listener?.stop(true);
    }
  }, 30_000);

  it("gives up, saying so, when nobody hands it a token", async () => {
    const child = spawnLocal(temporaryHome());

    await until(() => child.out() !== "");
    expect(child.out()).toBe('{"join":true}\n');
    // The controller closed the pipe without writing: there is nothing this
    // runner can do and nothing it should sit waiting for.
    child.closeStdin();

    const code = await child.exited;
    expect(code).not.toBe(0);
    expect(child.err()).not.toBe("");
  }, 30_000);
});
