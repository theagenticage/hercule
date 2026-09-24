/**
 * The join, as the one function both entry points call.
 *
 * The controller is a stub `fetch`: this package must reach no controller code,
 * so what is proved here is what the join leaves on disk and hands back, given
 * an answer of the shape the controller sends.
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

/** An empty Hercule Home, as a machine that has never joined has. */
const createTemporaryHome = (): string => {
  const home = mkdtempSync(pathJoin(tmpdir(), "hercule-join-"));
  homes.push(home);
  return home;
};

/** What the controller answers a join with. */
const buildJoinAnswer = (runnerId: string, name: string) => ({
  runnerId,
  name,
  credential: `credential-for-${runnerId}`,
  controllerIdentityId: "0199e0e7-1111-7000-8000-000000000000",
  controllerPublicKey: "IH5nqcbHvGUYs1n9y0sBnPGSNVYA3ZfCpZKDvXH7pqA=",
});

/** A controller that answers every join with the same row. */
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

/** The six fields `runner.json` holds, and nothing else. */
const RUNNER_JSON_FIELDS = [
  "controllerIdentityId",
  "controllerPublicKey",
  "controllerUrl",
  "credential",
  "runnerId",
  "storageDirectory",
];

describe("the join", () => {
  it("writes runner.json readable by nobody else, holding exactly what a runner needs", async () => {
    const home = createTemporaryHome();
    const body = buildJoinAnswer("0199e0e7-2222-7000-8000-000000000000", "hercule-thalia");

    const result = await runJoin({ home, body });

    expect(result.runnerId).toBe(body.runnerId);
    expect(result.name).toBe(body.name);
    expect(result.configPath).toBe(pathJoin(home, "runner", "runner.json"));
    expect(existsSync(result.configPath)).toBe(true);

    // A bearer credential on a shared machine: the file is the runner's alone.
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

    // The file names the directory; the answer says where it is.
    expect(result.storageDirectory).toBe(
      pathJoin(home, "runner", String(written["storageDirectory"])),
    );
    expect(statSync(result.storageDirectory).isDirectory()).toBe(true);
    // Workspaces and provider homes live in here, so it is the runner's alone
    // for the same reason the file is.
    expect(statSync(result.storageDirectory).mode & 0o777).toBe(0o700);
  });

  it("gives a second enrolment its own runner and its own directory, leaving the first in place", async () => {
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

    // A re-enlisted machine never adopts a previous life's folders, and never
    // deletes them either: they stay for manual recovery.
    expect(statSync(first.storageDirectory).isDirectory()).toBe(true);
    expect(statSync(second.storageDirectory).isDirectory()).toBe(true);

    // The replacement is the runner's alone too: a second enrolment must not
    // inherit whatever mode the first file happened to end up at.
    expect(statSync(second.configPath).mode & 0o777).toBe(0o600);

    const written = JSON.parse(readFileSync(second.configPath, "utf8")) as Record<string, unknown>;
    expect(written["runnerId"]).toBe(second.runnerId);
    expect(pathJoin(home, "runner", String(written["storageDirectory"]))).toBe(
      second.storageDirectory,
    );
  });
});

/**
 * The `--reserved` flag, through the runner role's `run(argv)`: the flag is
 * argv, so the parsing and the request body it produces are one behaviour.
 */
describe("hercule runner join --reserved", () => {
  /** The body of the one join request `run(argv)` made. */
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
      ]),
    ).toEqual({ reserved: true });
  });

  it("sends reserved: false without it", async () => {
    const home = createTemporaryHome();
    expect(
      await captureJoinBody([
        "--home",
        home,
        "join",
        "http://127.0.0.1:4937",
        "--token",
        "a-join-token",
      ]),
    ).toEqual({ reserved: false });
  });
});
