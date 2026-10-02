/**
 * Tests `join`, the one function both entry points call, and
 * `runJoinCommand`, which joins and then installs the service.
 *
 * The controller is a stub `fetch`, because this package must not import any
 * controller code. So these tests check what the join writes to disk and
 * returns, given a response of the shape the controller sends.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ServiceError, Supervisor } from "@hercule/service";
import { run as runArgv } from "./index";
import { join, runJoinCommand, type JoinCommandOptions } from "./join";

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

  it("refuses to install the service before it joins, so the token stays unused", async () => {
    const home = createTemporaryHome();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetched = vi.spyOn(globalThis, "fetch");
    try {
      process.exitCode = 0;
      // A test runs from the source checkout, which a service cannot run.
      await runArgv(["--home", home, "join", "http://127.0.0.1:4937", "--token", "a-join-token"]);
      expect(process.exitCode).toBe(1);
      expect(fetched).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledWith(
        "hercule: A service runs the compiled hercule binary, and this Hercule runs from a source checkout. Build the binary with `pnpm build:binary` and run `./hercule service install`. To join without installing the service, add --no-service.",
      );
    } finally {
      error.mockRestore();
      fetched.mockRestore();
      process.exitCode = 0;
    }
  });
});

describe("runJoinCommand", () => {
  const unused = Effect.die(new Error("The test did not expect this verb."));

  /** Returns a fake Supervisor that records each verb, and fails a verb given a message. */
  const buildFakeSupervisor = (
    asked: Array<string>,
    failures: { readonly prepare?: string; readonly install?: string } = {},
  ) =>
    Layer.succeed(
      Supervisor,
      Supervisor.of({
        uninstallNote: undefined,
        prepare: () =>
          Effect.suspend(() => {
            asked.push("prepare");
            return failures.prepare === undefined
              ? Effect.void
              : Effect.fail(new ServiceError({ message: failures.prepare }));
          }),
        install: (unit) =>
          Effect.suspend(() => {
            asked.push("install");
            return failures.install === undefined
              ? Effect.succeed({
                  installed: true,
                  running: true,
                  pid: 42,
                  role: unit.role,
                  home: unit.home,
                  unitFile: "/u",
                })
              : Effect.fail(new ServiceError({ message: failures.install }));
          }),
        uninstall: unused,
        start: unused,
        stop: unused,
        restart: unused,
        readStatus: unused,
      }),
    );

  /** Runs the command for a fresh Home and returns its output, its error, and what it asked. */
  const runCommand = async (
    options: {
      readonly withService?: boolean;
      readonly failures?: { readonly prepare?: string; readonly install?: string };
      readonly prepareHome?: (home: string) => void;
    } = {},
  ) => {
    const home = createTemporaryHome();
    options.prepareHome?.(home);
    const program = pathJoin(home, "bin", "hercule");
    mkdirSync(pathJoin(home, "bin"));
    writeFileSync(program, "");
    chmodSync(program, 0o755);
    const asked: Array<string> = [];
    const out: Array<string> = [];
    const fetched = vi.fn(
      stubFetch(buildJoinAnswer("0199e0e7-6666-7000-8000-000000000000", "vega")),
    );
    const service: JoinCommandOptions["service"] =
      options.withService === false
        ? undefined
        : {
            request: {
              role: "runner",
              home,
              overrides: [],
              env: { PATH: "/usr/bin" },
              program,
            },
            supervisor: buildFakeSupervisor(asked, options.failures),
          };
    const result = await Effect.runPromise(
      Effect.result(
        runJoinCommand({
          controllerUrl: "http://127.0.0.1:4937",
          token: "a-join-token",
          home,
          reserved: false,
          fetch: Object.assign(fetched, { preconnect: () => {} }),
          service,
          out: (line) => out.push(line),
        }),
      ),
    );
    return {
      home,
      out,
      asked,
      fetched: fetched.mock.calls.length,
      message: result._tag === "Failure" ? result.failure.message : undefined,
    };
  };

  it("prepares the service, joins, installs it, and prints each step", async () => {
    const { home, out, asked, fetched, message } = await runCommand();
    expect(message).toBeUndefined();
    expect(fetched).toBe(1);
    expect(asked).toEqual(["prepare", "install"]);
    expect(out).toEqual([
      "This machine joined as vega.",
      `Its credential is in ${pathJoin(home, "runner", "runner.json")}.`,
      "Installing the service unit for `hercule runner`.",
      `The Hercule service runs \`hercule runner\` for the Hercule Home ${home}, as pid 42.`,
    ]);
  });

  it("joins without a Supervisor with --no-service", async () => {
    const { out, fetched, message } = await runCommand({ withService: false });
    expect(message).toBeUndefined();
    expect(fetched).toBe(1);
    expect(out).toHaveLength(2);
  });

  it("refuses before it joins when the Supervisor refuses, so the token stays unused", async () => {
    const { out, asked, fetched, message } = await runCommand({
      failures: { prepare: "Could not turn on lingering for ada" },
    });
    expect(message).toBe(
      "Could not turn on lingering for ada. To join without installing the service, add --no-service.",
    );
    expect(fetched).toBe(0);
    expect(asked).toEqual(["prepare"]);
    expect(out).toEqual([]);
  });

  it.each([true, false])(
    "refuses a Home that holds a controller database before it joins (service: %s)",
    async (withService) => {
      const { home, asked, fetched, message } = await runCommand({
        withService,
        prepareHome: (home) => {
          mkdirSync(pathJoin(home, "data"));
          writeFileSync(pathJoin(home, "data", "hercule.db"), "");
        },
      });
      expect(message).toBe(
        `The Hercule Home ${home} holds a controller database, and its runner.json belongs to the controller's own runner, so joining would point that runner at another controller. To make this machine a separate runner, give it its own Home with --home.`,
      );
      expect(fetched).toBe(0);
      expect(asked).toEqual([]);
    },
  );

  it("says to run `hercule service install` when the install fails after the join", async () => {
    const { out, asked, fetched, message } = await runCommand({
      failures: { install: "launchd said no." },
    });
    expect(message).toBe(
      "The service was not installed. launchd said no. This machine has joined, so once that is fixed, run `hercule service install` rather than joining again.",
    );
    expect(fetched).toBe(1);
    expect(asked).toEqual(["prepare", "install"]);
    expect(out.at(-1)).toBe("Installing the service unit for `hercule runner`.");
  });
});
