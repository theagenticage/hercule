/**
 * Tests moving a controller to another machine with the release binary, the
 * way an operator does it (spec 03 section 8).
 *
 * Controller A runs in one throwaway Hercule Home and gets real data: a
 * project, a secret, and a runner joined from a Home of its own. The CLI on A
 * creates a promotion token, and `hercule promote` pulls A into an empty Home
 * B on another port. With `--no-service` the promote process then serves as
 * controller B, so no Service Unit is installed on this machine.
 *
 * The test then checks, through the CLI and the HTTP API only:
 *
 * - B serves A's data, and A's API key works on B.
 * - Both runners that were connected to A when it sealed follow the forwarding
 *   pointer to B on their own, and rewrite `runner.json` to point at B.
 * - A refuses every request with `controller_sealed` and B's address, also
 *   after a restart.
 *
 * On macOS the Master Key of each controller is a login keychain item named
 * after its Home. Removing a Home with `createTemporaryHome` deletes that item
 * too, so the test leaves no item behind, also when it fails.
 */
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PASSWORD,
  USERNAME,
  buildCleanEnv,
  completeSetup,
  findCompiledBinary,
  runCli,
  startController,
  type Controller,
  type Ran,
} from "../scripts/controller-process";
import {
  createTemporaryHome,
  parseJsonOutput,
  parseJsonOutputOrFail,
  readApiKey,
  type Page,
  type TemporaryHome,
} from "./harness";

/** How long a runner gets to reconnect: its backoff after a failed dial grows to 30 seconds. */
const RECONNECT_DEADLINE_MS = 90_000;

/** How long `stop` waits for a process to exit on SIGTERM before it sends SIGKILL. */
const STOP_BOUND_MS = 10_000;

const PROJECT_NAME = "Moving day";
const SECRET = { ownerKind: "plugin", ownerId: "github", name: "client_secret" } as const;

/** A process this test started and must stop, with everything it printed. */
interface Started {
  readonly pid: number;
  readonly output: () => string;
  readonly hasExited: () => boolean;
  /** Sends SIGTERM, then SIGKILL if the process has not exited within `STOP_BOUND_MS`. */
  readonly stop: () => Promise<void>;
}

/**
 * Starts the binary with `args` in `home` and returns at once. Used for the
 * two processes that run until the test stops them: the joined runner and
 * `hercule promote`, which goes on to serve as controller B.
 */
const startBinary = (binary: string, args: ReadonlyArray<string>, home: string): Started => {
  const chunks: Array<string> = [];
  const child = Bun.spawn([binary, ...args], {
    env: { ...buildCleanEnv(), HERCULE_HOME: home },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const collect = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const bytes of stream) chunks.push(decoder.decode(bytes, { stream: true }));
  };
  void collect(child.stdout);
  void collect(child.stderr);
  const hasExited = () => child.exitCode !== null || child.signalCode !== null;
  return {
    pid: child.pid,
    output: () => chunks.join(""),
    hasExited,
    stop: async () => {
      if (hasExited()) return;
      child.kill("SIGTERM");
      await Promise.race([child.exited, sleep(STOP_BOUND_MS)]);
      if (!hasExited()) child.kill("SIGKILL");
      await child.exited;
    },
  };
};

/**
 * Returns a port nothing listens on right now. `hercule promote` checks the
 * port is free before it spends the token, so a port taken in the meantime
 * fails the test without moving A.
 */
const findFreePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address !== null
          ? resolve(address.port)
          : reject(new Error("the probe listener has no port")),
      );
    });
  });

/**
 * Calls `look` until it returns a value, and returns that value. Fails with
 * `describe()` once `deadlineMs` has passed, so a timeout says what was last
 * seen.
 */
const waitFor = async <A>(
  what: string,
  look: () => Promise<A | undefined>,
  describe: () => string,
  deadlineMs: number,
): Promise<A> => {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const found = await look();
    if (found !== undefined) return found;
    if (Date.now() > deadline) {
      throw new Error(`${what} within ${String(deadlineMs / 1000)}s:\n${describe()}`);
    }
    await sleep(250);
  }
};

/** Reads the controller URL a runner Home's `runner.json` points at. */
const readPinnedControllerUrl = (home: string): string =>
  (
    JSON.parse(readFileSync(join(home, "runner", "runner.json"), "utf8")) as {
      readonly controllerUrl: string;
    }
  ).controllerUrl;

/** Reads the runner id a runner Home's `runner.json` holds. */
const readPinnedRunnerId = (home: string): string =>
  (JSON.parse(readFileSync(join(home, "runner", "runner.json"), "utf8")) as { runnerId: string })
    .runnerId;

/** Fails with the command's own output unless it exited 0. */
const expectSuccess = (ran: Ran): void => {
  expect(ran.code, `${ran.stdout}\n${ran.stderr}`).toBe(0);
};

/** The error envelope every refused request carries (spec 11 section 1.5). */
interface ErrorEnvelope {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: { readonly newAddress?: string };
  };
}

interface ControllerInfo {
  readonly id: string;
  readonly publicKey: string;
  readonly localRunnerId: string | null;
}

interface ListedRunner {
  readonly id: string;
  readonly connectivity: string;
}

let binary: string;
let homeA: TemporaryHome;
let homeB: TemporaryHome;
let homeRunner: TemporaryHome;
let controllerA: Controller | undefined;
let runner: Started | undefined;
let promoted: Started | undefined;

let urlA: string;
let urlB: string;
/** A's identity, read before the move. */
let identityA: ControllerInfo;
/** The id of the runner joined from its own Home. */
let joinedRunnerId: string;

/** Runs the CLI against A with the credential `hercule login` wrote into Home A. */
const runOnA = (args: ReadonlyArray<string>, stdin?: string): Promise<Ran> =>
  runCli(args, { home: homeA.home, binary, stdin });

/**
 * Runs the CLI against B with the API key created on A. That the key works on
 * B is part of what the test checks: the key's row moved with the database.
 */
const runOnB = (args: ReadonlyArray<string>): Promise<Ran> =>
  runCli(args, {
    home: homeB.home,
    binary,
    env: { HERCULE_API_URL: urlB, HERCULE_TOKEN: readApiKey(homeA.home) },
  });

/** Lists the runners B has, with their connectivity. */
const listRunnersOnB = async (): Promise<ReadonlyArray<ListedRunner>> =>
  parseJsonOutputOrFail<Page<ListedRunner>>(await runOnB(["runner", "list", "--json"])).items;

/** Waits until B lists `runnerId` as online. */
const waitForOnlineOnB = (runnerId: string, which: string): Promise<ListedRunner> => {
  let last: ReadonlyArray<ListedRunner> = [];
  return waitFor(
    `${which} did not come online on B`,
    async () => {
      last = await listRunnersOnB();
      return last.find((one) => one.id === runnerId && one.connectivity === "online");
    },
    () =>
      `B lists ${JSON.stringify(last)}\n--- runner ---\n${runner?.output() ?? ""}\n--- B ---\n${promoted?.output() ?? ""}`,
    RECONNECT_DEADLINE_MS,
  );
};

beforeAll(async () => {
  binary = findCompiledBinary();
  homeA = createTemporaryHome();
  homeB = createTemporaryHome();
  homeRunner = createTemporaryHome();

  // 1. Controller A, set up, with the CLI on A logged in.
  controllerA = await startController({ home: homeA.home, binary });
  urlA = controllerA.url;
  expectSuccess(await completeSetup({ home: homeA.home, url: urlA, binary }));
  expectSuccess(
    await runCli(["login", urlA, "--username", USERNAME, "--password-stdin"], {
      home: homeA.home,
      binary,
      stdin: PASSWORD,
    }),
  );

  // 2. Data that must move: a project, and a secret encrypted under A's Master Key.
  expectSuccess(await runOnA(["project", "create", "--name", PROJECT_NAME, "--json"]));
  expectSuccess(
    await runOnA(
      ["secret", "set", SECRET.ownerKind, SECRET.ownerId, SECRET.name, "--json"],
      "e2e-client-secret",
    ),
  );

  // 3. A runner joined from a Home of its own, running and online on A.
  const joinToken = parseJsonOutputOrFail<{ readonly token: string }>(
    await runOnA(["runner", "join-token", "create", "--json"]),
  ).token;
  expectSuccess(
    await runCli(["runner", "join", urlA, "--token", joinToken, "--no-service"], {
      home: homeRunner.home,
      binary,
    }),
  );
  joinedRunnerId = readPinnedRunnerId(homeRunner.home);
  runner = startBinary(binary, ["runner"], homeRunner.home);
  let fleetA: ReadonlyArray<ListedRunner> = [];
  await waitFor(
    "the joined runner and A's local runner did not come online on A",
    async () => {
      fleetA = parseJsonOutputOrFail<Page<ListedRunner>>(
        await runOnA(["runner", "list", "--connectivity", "online", "--json"]),
      ).items;
      identityA = parseJsonOutputOrFail<ControllerInfo>(
        await runOnA(["controller", "read", "--json"]),
      );
      const online = new Set(fleetA.map((one) => one.id));
      return online.has(joinedRunnerId) &&
        identityA.localRunnerId !== null &&
        online.has(identityA.localRunnerId)
        ? true
        : undefined;
    },
    () => `A lists ${JSON.stringify(fleetA)}\n--- runner ---\n${runner?.output() ?? ""}`,
    RECONNECT_DEADLINE_MS,
  );

  // 4. The promotion token, as the operator reads it: the printed command.
  // The CLI reached A on loopback, which another machine cannot use, so the
  // command holds a placeholder for A's URL.
  const minted = await runOnA(["controller", "promotion-token", "create"]);
  expectSuccess(minted);
  const command = minted.stdout.split("\n")[0]!;
  expect(command).toMatch(/^hercule promote --from <this-controller-url> --token \S+$/);
  const token = command.split(" ").at(-1)!;

  // 5. B: an empty Home on another port pulls A, then serves as the controller.
  const portB = await findFreePort();
  urlB = `http://127.0.0.1:${String(portB)}`;
  promoted = startBinary(
    binary,
    [
      "promote",
      "--from",
      urlA,
      "--token",
      token,
      "--address",
      urlB,
      "--yes",
      "--no-service",
      "-c",
      `bind.port=${String(portB)}`,
    ],
    homeB.home,
  );
  const started = promoted;
  await waitFor(
    "B did not start serving",
    async () => {
      if (started.hasExited()) throw new Error(`promote exited:\n${started.output()}`);
      if (!started.output().includes(`Hercule is listening on ${urlB}.`)) return undefined;
      const response = await fetch(`${urlB}/api/v1/setup`).catch(() => undefined);
      return response?.ok === true ? true : undefined;
    },
    () => started.output(),
    60_000,
  );
}, 240_000);

afterAll(async () => {
  // Every step runs even when an earlier one fails, so nothing outlives the
  // suite: no process, no Home, and no keychain item.
  await promoted?.stop().catch(() => undefined);
  await runner?.stop().catch(() => undefined);
  await controllerA?.stop().catch(() => undefined);
  for (const home of [homeA, homeB, homeRunner]) home?.remove();
}, 60_000);

describe("hercule promote through the binary", () => {
  it("says what it does, and B serves A's identity and data", async () => {
    const said = promoted!.output();
    expect(said).toContain(`Controller ${identityA.id} at ${urlA}.`);
    expect(said).toContain(`${urlA} is sealed. Its runners reconnect to ${urlB}.`);

    const identityB = parseJsonOutputOrFail<ControllerInfo>(
      await runOnB(["controller", "read", "--json"]),
    );
    expect(identityB.id).toBe(identityA.id);
    expect(identityB.publicKey).toBe(identityA.publicKey);

    const projects = parseJsonOutputOrFail<Page<{ readonly name: string }>>(
      await runOnB(["project", "list", "--json"]),
    ).items;
    expect(projects.map((one) => one.name)).toContain(PROJECT_NAME);

    const secrets = parseJsonOutputOrFail<Page<Record<string, string>>>(
      await runOnB(["secret", "list", "--owner-kind", SECRET.ownerKind, "--json"]),
    ).items;
    expect(secrets).toEqual([expect.objectContaining(SECRET)]);

    // The password moved too: a fresh login on B works.
    const clientHome = createTemporaryHome();
    try {
      expectSuccess(
        await runCli(["login", urlB, "--username", USERNAME, "--password-stdin"], {
          home: clientHome.home,
          binary,
          stdin: PASSWORD,
        }),
      );
    } finally {
      clientHome.remove();
    }
  }, 60_000);

  it(
    "moves both runners that were connected to A over to B, and B starts its own",
    async () => {
      // A runner comes online only once it has checked the controller's
      // signature on the hello against the public key it pinned when it joined.
      // B signs with the private key it received in A's database, encrypted
      // under A's Master Key and re-encrypted under B's own. So a runner online
      // on B shows the key decrypted after the move.
      await waitForOnlineOnB(joinedRunnerId, "the joined runner");
      await waitForOnlineOnB(identityA.localRunnerId!, "A's local runner");
      expect(readPinnedControllerUrl(homeRunner.home)).toBe(urlB);
      expect(readPinnedControllerUrl(homeA.home)).toBe(urlB);

      // B starts a local runner of its own in its own Home (spec 03 section 8.6).
      const identityB = await waitFor(
        "B's own local runner did not join",
        async () => {
          const read = parseJsonOutputOrFail<ControllerInfo>(
            await runOnB(["controller", "read", "--json"]),
          );
          return read.localRunnerId === null ? undefined : read;
        },
        () => promoted!.output(),
        RECONNECT_DEADLINE_MS,
      );
      expect(identityB.localRunnerId).not.toBe(identityA.localRunnerId);
      await waitForOnlineOnB(identityB.localRunnerId!, "B's local runner");
      expect(readPinnedControllerUrl(homeB.home)).toBe(urlB);
    },
    4 * RECONNECT_DEADLINE_MS,
  );

  it("seals A: every request, a write included, gets B's address, also after a restart", async () => {
    /** Checks that A refuses a read and a write, with B's address. */
    const expectSealed = async (): Promise<void> => {
      for (const args of [
        ["controller", "read", "--json"],
        ["project", "create", "--name", "Written on A after the move", "--json"],
      ]) {
        const ran = await runOnA(args);
        expect(ran.code, `${ran.stdout}\n${ran.stderr}`).not.toBe(0);
        const refused = parseJsonOutput(ran) as ErrorEnvelope;
        expect(refused.error.code).toBe("controller_sealed");
        expect(refused.error.details?.newAddress).toBe(urlB);
      }
      const response = await fetch(`${controllerA!.url}/api/v1/controller`, {
        headers: { authorization: `Bearer ${readApiKey(homeA.home)}` },
      });
      expect(response.status).toBe(503);
    };

    await expectSealed();

    // The seal is kept in A's database, so a restarted A is still sealed,
    // and its log says so rather than reading like a healthy boot.
    const port = controllerA!.port;
    await controllerA!.stop();
    controllerA = undefined;
    const logFile = join(homeA.home, "logs", "controller.log");
    const loggedBeforeRestart = readFileSync(logFile, "utf8").length;
    controllerA = await startController({ home: homeA.home, port, binary });
    expect(readFileSync(logFile, "utf8").slice(loggedBeforeRestart)).toContain(
      `This controller is sealed: it has moved to ${urlB}`,
    );
    await expectSealed();
  }, 90_000);
});
