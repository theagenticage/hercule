/**
 * Tests `join`, the one function both entry points call.
 *
 * The controller is a stub `fetch`, because this package must not import any
 * controller code. So these tests check what the join writes to disk and
 * returns, given a response of the shape the controller sends.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import { run as runArgv } from "./index";
import { join } from "./join";

const homes: Array<string> = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

/** Creates an empty Hercule Home, like the one on a machine that has never joined. */
const createTemporaryHome = (): string => {
  const home = mkdtempSync(pathJoin(tmpdir(), "hercule-join-"));
  homes.push(home);
  return home;
};

/** Builds the response the controller sends to a join. */
const buildJoinAnswer = (runnerId: string, name: string) => ({
  runnerId,
  name,
  credential: `credential-for-${runnerId}`,
  controllerIdentityId: "0199e0e7-1111-7000-8000-000000000000",
  controllerPublicKey: "IH5nqcbHvGUYs1n9y0sBnPGSNVYA3ZfCpZKDvXH7pqA=",
});

/** Returns a stub `fetch` that responds to every join with the same body. */
const stubFetch = (body: unknown): typeof fetch =>
  Object.assign(
    () =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    { preconnect: () => {} },
  );

const runJoin = (options: {
  readonly home: string;
  readonly body: unknown;
  readonly token?: string;
}) =>
  Effect.runPromise(
    join({
      controllerUrl: "http://127.0.0.1:4937",
      token: options.token ?? "a-join-token",
      home: options.home,
      reserved: false,
      fetch: stubFetch(options.body),
    }),
  );

/** The six fields in `runner.json`. The file has no others. */
const RUNNER_JSON_FIELDS = [
  "controllerIdentityId",
  "controllerPublicKey",
  "controllerUrl",
  "credential",
  "runnerId",
  "storageDirectory",
];

describe("join", () => {
  it("writes runner.json with exactly the fields a runner needs, readable only by its owner", async () => {
    const home = createTemporaryHome();
    const body = buildJoinAnswer("0199e0e7-2222-7000-8000-000000000000", "hercule-thalia");

    const result = await runJoin({ home, body });

    expect(result.runnerId).toBe(body.runnerId);
    expect(result.name).toBe(body.name);
    expect(result.configPath).toBe(pathJoin(home, "runner", "runner.json"));
    expect(existsSync(result.configPath)).toBe(true);

    // The file holds a bearer credential, so on a shared machine only the
    // runner's user may read it.
    expect(statSync(result.configPath).mode & 0o777).toBe(0o600);

    const written = JSON.parse(readFileSync(result.configPath, "utf8")) as Record<string, unknown>;
    expect(Object.keys(written).sort()).toEqual(RUNNER_JSON_FIELDS);
    expect(written).toMatchObject({
      runnerId: body.runnerId,
      credential: body.credential,
      controllerUrl: "http://127.0.0.1:4937",
      controllerIdentityId: body.controllerIdentityId,
      controllerPublicKey: body.controllerPublicKey,
    });

    // The file holds the directory name; the result holds the full path.
    expect(result.storageDirectory).toBe(
      pathJoin(home, "runner", String(written["storageDirectory"])),
    );
    expect(statSync(result.storageDirectory).isDirectory()).toBe(true);
    // Workspaces and provider homes live in this directory, so only the
    // runner's user may open it, for the same reason as the file.
    expect(statSync(result.storageDirectory).mode & 0o777).toBe(0o700);
  });

  it("gives a second join its own runner and its own directory, and leaves the first directory in place", async () => {
    const home = createTemporaryHome();

    const first = await runJoin({
      home,
      body: buildJoinAnswer("0199e0e7-3333-7000-8000-000000000000", "iris"),
    });
    const second = await runJoin({
      home,
      body: buildJoinAnswer("0199e0e7-4444-7000-8000-000000000000", "vega"),
    });

    expect(second.runnerId).not.toBe(first.runnerId);
    expect(second.storageDirectory).not.toBe(first.storageDirectory);

    // A machine that joins again never reuses the folders of its previous
    // registration, and never deletes them either: they stay for manual
    // recovery.
    expect(statSync(first.storageDirectory).isDirectory()).toBe(true);
    expect(statSync(second.storageDirectory).isDirectory()).toBe(true);

    // The new file is private too: a second join must not inherit whatever
    // mode the first file happened to have.
    expect(statSync(second.configPath).mode & 0o777).toBe(0o600);

    const written = JSON.parse(readFileSync(second.configPath, "utf8")) as Record<string, unknown>;
    expect(written["runnerId"]).toBe(second.runnerId);
    expect(pathJoin(home, "runner", String(written["storageDirectory"]))).toBe(
      second.storageDirectory,
    );
  });
});

/**
 * Tests the `--reserved` flag through the runner role's `run(argv)`, so the
 * argument parsing and the request body it produces are tested together.
 */
describe("hercule runner join --reserved", () => {
  /** Runs `run(argv)` and returns the body of the single join request it made. */
  const captureJoinBody = async (argv: ReadonlyArray<string>): Promise<unknown> => {
    const bodies: Array<unknown> = [];
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetched = vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => {
      const body = init?.body;
      bodies.push(typeof body === "string" ? (JSON.parse(body) as unknown) : body);
      return Promise.resolve(
        new Response(
          JSON.stringify(buildJoinAnswer("0199e0e7-5555-7000-8000-000000000000", "lyra")),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      );
    });
    try {
      process.exitCode = 0;
      await runArgv(argv);
      expect(error).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(0);
      expect(bodies).toHaveLength(1);
      return bodies[0];
    } finally {
      log.mockRestore();
      error.mockRestore();
      fetched.mockRestore();
      process.exitCode = 0;
    }
  };

  it("sends reserved: true with the flag", async () => {
    const home = createTemporaryHome();
    expect(
      await captureJoinBody([
        "--home",
        home,
        "join",
        "http://127.0.0.1:4937",
        "--token",
        "a-join-token",
        "--reserved",
        "--no-service",
      ]),
    ).toEqual({ reserved: true });
  });

  it("sends reserved: false without the flag", async () => {
    const home = createTemporaryHome();
    expect(
      await captureJoinBody([
        "--home",
        home,
        "join",
        "http://127.0.0.1:4937",
        "--token",
        "a-join-token",
        "--no-service",
      ]),
    ).toEqual({ reserved: false });
  });
});
