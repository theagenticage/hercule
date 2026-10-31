/**
 * The live-pull acceptance: two controller Homes on different ports plus a
 * remote runner Home. `hercule promote` moves A to B; B serves the same
 * identity and the attachment written on A; A's local runner re-points; a
 * remote runner that missed the announcement is re-pointed with
 * `hercule runner set-controller`; A answers `controller_sealed` and a
 * forwarding pointer, also after a restart. Cancelling before the transfer
 * leaves A serving. `--force-unseal` restores A. The Master Key on B is the
 * platform store. `--no-service` leaves `hercule serve` running in the
 * foreground on B.
 */
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import {
  encodeForwardingPointerBytes,
  PROTOCOL_VERSION,
  type RunnerHello,
} from "@hercule/protocol";
import { buildHomePaths, locateRunnerFile } from "@hercule/home";
import {
  buildCleanEnv,
  completeSetup,
  deleteMasterKeyItem,
  PASSWORD,
  ROOT,
  runCli,
  startController,
  USERNAME,
  type Controller,
} from "../../../../scripts/controller-process";
import { mintUuid } from "../db";
import { promote } from "./promote";
import { createPromotionToken, findFreePort } from "./testing";
import { get, post, readErrorBody, send } from "../http/testing";
import { dialRunnerSocket, takeFrameWithTag } from "../runners/testing";

const ENTRYPOINT = join(ROOT, "packages/hercule/src/main.ts");
const BUN = process.execPath.endsWith("/bun") ? process.execPath : "bun";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const SECRET_OWNER = "0198e4b0-0000-7000-8000-000000000001";
const SECRET_VALUE = "ghp_promotion-two-home-secret";
const TEST_TIMEOUT_MS = 180_000;
const RUNNER_WAIT_MS = 45_000;

interface ListedRunner {
  readonly id: string;
  readonly name: string;
  readonly connectivity: string;
}

interface ControllerInfo {
  readonly id: string;
  readonly publicKey: string;
  readonly localRunnerId: string | null;
}

const homes: Array<string> = [];
const controllers: Array<Controller> = [];
const children: Array<ReturnType<typeof Bun.spawn>> = [];

/**
 * The step the first test is in, and the output of every process it started.
 * This test has failed once by running into its timeout, which names no step.
 * When a test fails, `afterEach` calls `reportFailure`, so the next failure
 * shows where the test waited and what the processes printed and logged.
 */
let step = "";
const outputs: Array<{ readonly name: string; readonly text: () => string }> = [];

/** Records the step the test is about to wait on. */
const enterStep = (name: string): void => {
  step = name;
};

/**
 * Prints the step the test failed in, the output of every process it
 * started, and the process logs in each Home, to stderr.
 */
const reportFailure = (): void => {
  const sections = [`The test failed while waiting for: ${step}`];
  for (const output of outputs) sections.push(`--- ${output.name}\n${output.text()}`);
  for (const home of homes) {
    const logs = join(home, "logs");
    if (!existsSync(logs)) continue;
    for (const file of readdirSync(logs)) {
      sections.push(`--- ${join(logs, file)}\n${readFileSync(join(logs, file), "utf8")}`);
    }
  }
  console.error(sections.join("\n"));
};

const stopChild = async (child: ReturnType<typeof Bun.spawn>): Promise<void> => {
  if (child.exitCode === null) child.kill("SIGTERM");
  await Promise.race([child.exited, delay(2_000)]);
  if (child.exitCode === null) child.kill("SIGKILL");
};

const stopHeld = async (controller: Controller): Promise<void> => {
  await Promise.race([
    controller.stop().catch(() => -1),
    delay(8_000).then(() => {
      try {
        process.kill(controller.pid, "SIGKILL");
      } catch {
        // The process already exited.
      }
    }),
  ]);
};

afterEach(async (context) => {
  // Before the cleanup, which stops the processes and removes the Homes.
  if (context.task.result?.state === "fail") reportFailure();
  const toKill = children.splice(0);
  const toStop = controllers.splice(0);
  const toRemove = homes.splice(0);
  await Promise.all(toKill.map(stopChild));
  await Promise.all(toStop.map(stopHeld));
  for (const home of toRemove) {
    deleteMasterKeyItem(home);
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 60_000);

const createHome = (): string => {
  const home = mkdtempSync(join(tmpdir(), "hercule-promote-homes-"));
  homes.push(home);
  return home;
};

const writeHomeConfig = (home: string, port: number): void => {
  writeFileSync(
    join(home, "config.toml"),
    [
      'data.dir = "data"',
      'bind.host = "127.0.0.1"',
      `bind.port = ${String(port)}`,
      'log.level = "info"',
      "",
    ].join("\n"),
  );
};

const holdController = async (home: string, port?: number, extraArgs?: ReadonlyArray<string>) => {
  const controller = await startController({
    home,
    ...(port === undefined ? {} : { port }),
    ...(extraArgs === undefined ? {} : { extraArgs }),
    timeoutMs: 40_000,
  });
  controllers.push(controller);
  outputs.push({ name: `hercule serve on ${controller.url} in ${home}`, text: controller.output });
  return controller;
};

const login = async (base: string): Promise<string> => {
  const response = await post(base, "/api/v1/auth/login", {
    username: USERNAME,
    password: PASSWORD,
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { token: string }).token;
};

const readController = async (base: string, token: string): Promise<ControllerInfo> => {
  const response = await get(base, "/api/v1/controller", token);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as ControllerInfo;
};

const listRunners = async (base: string, token: string): Promise<ReadonlyArray<ListedRunner>> => {
  const response = await get(base, "/api/v1/runners", token);
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { items: ReadonlyArray<ListedRunner> }).items;
};

const waitUntil = async <A>(
  what: string,
  look: () => A | undefined | Promise<A | undefined>,
  within = RUNNER_WAIT_MS,
): Promise<A> => {
  const deadline = Date.now() + within;
  for (;;) {
    const found = await look();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await delay(200);
  }
};

const waitForRunnerOnline = (
  base: string,
  token: string,
  runnerId: string,
): Promise<ListedRunner> =>
  waitUntil(`runner ${runnerId} to show online`, async () => {
    const found = (await listRunners(base, token)).find((runner) => runner.id === runnerId);
    return found?.connectivity === "online" ? found : undefined;
  });

const readPinnedUrl = (home: string): string => {
  const pin = JSON.parse(readFileSync(locateRunnerFile(home), "utf8")) as {
    readonly controllerUrl: string;
    readonly credential: string;
    readonly controllerPublicKey: string;
  };
  return pin.controllerUrl;
};

const readPin = (home: string) =>
  JSON.parse(readFileSync(locateRunnerFile(home), "utf8")) as {
    readonly runnerId: string;
    readonly credential: string;
    readonly controllerUrl: string;
    readonly controllerPublicKey: string;
  };

const startRemoteRunner = (home: string): ReturnType<typeof Bun.spawn> => {
  const child = Bun.spawn([BUN, ENTRYPOINT, "runner"], {
    cwd: ROOT,
    env: { ...buildCleanEnv(), HERCULE_HOME: home },
    stdout: "ignore",
    stderr: "pipe",
  });
  children.push(child);
  return child;
};

const drainSpawnOutput = (child: ReturnType<typeof Bun.spawn>): { readonly text: () => string } => {
  const chunks: Array<string> = [];
  const read = async (stream: ReadableStream<Uint8Array> | number | undefined) => {
    if (typeof stream !== "object" || stream === null) return;
    const decoder = new TextDecoder();
    for await (const chunk of stream) chunks.push(decoder.decode(chunk));
  };
  void read(child.stdout);
  void read(child.stderr);
  return { text: () => chunks.join("") };
};

const startPromote = (
  home: string,
  from: string,
  token: string,
  address: string,
): { readonly child: ReturnType<typeof Bun.spawn>; readonly output: () => string } => {
  const child = Bun.spawn(
    [
      BUN,
      ENTRYPOINT,
      "promote",
      "--from",
      from,
      "--token",
      token,
      "--address",
      address,
      "--yes",
      "--no-service",
    ],
    {
      cwd: ROOT,
      env: { ...buildCleanEnv(), HERCULE_HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  children.push(child);
  const drained = drainSpawnOutput(child);
  outputs.push({ name: `hercule promote into ${home}`, text: drained.text });
  return { child, output: drained.text };
};

const assertMasterKeyPresent = (home: string): void => {
  if (process.platform === "darwin") {
    const result = Bun.spawnSync([
      "security",
      "find-generic-password",
      "-s",
      "Hercule",
      "-a",
      home,
      "-w",
    ]);
    expect(result.exitCode).toBe(0);
    return;
  }
  const path = join(home, "master.key");
  expect(existsSync(path)).toBe(true);
  expect(statSync(path).mode & 0o777).toBe(0o600);
};

const encodeBase64 = (raw: Uint8Array): string => Buffer.from(raw).toString("base64");

const decodeBase64Bytes = (encoded: string): Uint8Array<ArrayBuffer> => {
  const decoded = Buffer.from(encoded, "base64");
  const out = new Uint8Array(decoded.byteLength);
  out.set(decoded);
  return out;
};

const verifyAddressSignature = async (
  publicKey: string,
  newAddress: string,
  signature: string,
): Promise<boolean> => {
  const key = await crypto.subtle.importKey(
    "spki",
    decodeBase64Bytes(publicKey),
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    { name: "Ed25519" },
    key,
    decodeBase64Bytes(signature),
    encodeForwardingPointerBytes(newAddress),
  );
};

const buildHello = (): RunnerHello => ({
  _tag: "runnerHello",
  protocolVersion: PROTOCOL_VERSION,
  capabilities: [],
  binaryVersion: "0.1.0",
  nonce: encodeBase64(crypto.getRandomValues(new Uint8Array(16))),
  facts: {
    os: "linux",
    arch: "x64",
    totalMemoryBytes: 1,
    docker: false,
    toolchains: [],
    harnesses: [],
    adapters: [],
    identityPort: 4939,
  },
});

const expectSealedWithPointer = async (
  base: string,
  token: string,
  newAddress: string,
  publicKey: string,
  credential: string,
): Promise<void> => {
  const read = await get(base, "/api/v1/controller", token);
  expect(read.status).toBe(503);
  const body = await readErrorBody(read);
  expect(body.code).toBe("controller_sealed");
  expect(body.message).toContain(newAddress);

  const wire = await dialRunnerSocket(base, credential);
  wire.send(buildHello());
  const pointer = await takeFrameWithTag(wire, "forwardingPointer");
  expect(pointer.newAddress).toBe(newAddress);
  expect(await verifyAddressSignature(publicKey, pointer.newAddress, pointer.signature)).toBe(true);
  wire.close();
};

/**
 * Adds a Claude subscription account to the database of a running controller,
 * because setup creates the default assistant on an account and a fresh
 * install has none. A real user adds it with the add-account sheet, which needs
 * a signed-in client; this test has none before setup finishes.
 */
const addProviderAccount = (home: string): void => {
  const database = new Database(join(home, "data", "hercule.db"));
  try {
    // The controller keeps running and writes its own rows while it boots. Without
    // a timeout SQLite fails at once with "database is locked" instead of waiting.
    database.run("PRAGMA busy_timeout = 5000");
    const now = new Date().toISOString();
    database
      .query(
        `INSERT INTO provider_accounts
           (id, provider_id, kind, label, default_harness_id, created_at, updated_at)
         VALUES (?, 'anthropic/anthropic', 'subscription-per-machine', NULL,
                 'claude-code/claude-code', ?, ?)`,
      )
      .run(mintUuid(), now, now);
  } finally {
    database.close();
  }
};

const finishSetup = async (home: string, url: string): Promise<void> => {
  addProviderAccount(home);
  const completed = await completeSetup({ home, url });
  expect(completed.code, `${completed.stdout}\n${completed.stderr}`).toBe(0);
};

describe("promotion across two Homes", () => {
  it(
    "moves A to B, re-points the local runner, set-controllers a missed remote runner, seals A across a restart, and restores A with --force-unseal",
    async () => {
      step = "";
      outputs.length = 0;
      const aHome = createHome();
      const bHome = createHome();
      const runnerHome = createHome();
      enterStep("A to start");
      const a = await holdController(aHome);
      await finishSetup(aHome, a.url);
      const user = await login(a.url);

      enterStep("A's local runner to join");
      const identity = await waitUntil("A's local runner to join", async () => {
        const info = await readController(a.url, user);
        return info.localRunnerId === null ? undefined : info;
      });
      const localRunnerId = identity.localRunnerId!;
      await waitForRunnerOnline(a.url, user, localRunnerId);

      const uploaded = await fetch(`${a.url}/api/v1/attachments?name=promo.png`, {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          authorization: `Bearer ${user}`,
          connection: "close",
        },
        body: PNG,
      });
      expect(uploaded.status, await uploaded.clone().text()).toBe(201);
      const attachment = (await uploaded.json()) as { id: string };

      const stored = await send("PUT", a.url, `/api/v1/secrets/runner/${SECRET_OWNER}/api-token`, {
        body: { value: SECRET_VALUE },
        token: user,
      });
      expect(stored.status, await stored.clone().text()).toBe(200);

      const joinMinted = await post(a.url, "/api/v1/runners/join-tokens", {}, user);
      expect(joinMinted.status, await joinMinted.clone().text()).toBe(201);
      const joinToken = ((await joinMinted.json()) as { token: string }).token;
      enterStep("`hercule runner join` against A");
      const joined = await runCli(["runner", "join", a.url, "--token", joinToken, "--no-service"], {
        home: runnerHome,
      });
      expect(joined.code, `${joined.stdout}\n${joined.stderr}`).toBe(0);
      const remotePin = readPin(runnerHome);

      const token = await createPromotionToken(a.url, user);

      const portB = await findFreePort();
      writeHomeConfig(bHome, portB);
      const bUrl = `http://127.0.0.1:${String(portB)}`;
      enterStep("`hercule promote` to serve B");
      const promoted = startPromote(bHome, a.url, token, bUrl);
      let bUser: string;
      try {
        bUser = await waitUntil(
          "B to accept login after promote",
          async () => {
            if (promoted.child.exitCode !== null) {
              throw new Error(
                `promote exited ${String(promoted.child.exitCode)}:\n${promoted.output()}`,
              );
            }
            try {
              const response = await post(bUrl, "/api/v1/auth/login", {
                username: USERNAME,
                password: PASSWORD,
              });
              if (response.status !== 200) return undefined;
              return ((await response.json()) as { token: string }).token;
            } catch {
              return undefined;
            }
          },
          90_000,
        );
      } catch (error) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}\n${promoted.output()}`,
          { cause: error },
        );
      }
      assertMasterKeyPresent(bHome);

      const bIdentity = await readController(bUrl, bUser);
      expect(bIdentity.id).toBe(identity.id);
      expect(bIdentity.publicKey).toBe(identity.publicKey);

      const attachmentRead = await get(bUrl, `/api/v1/attachments/${attachment.id}/content`, bUser);
      expect(attachmentRead.status, await attachmentRead.clone().text()).toBe(200);
      expect(new Uint8Array(await attachmentRead.arrayBuffer())).toEqual(PNG);

      const secrets = await get(bUrl, "/api/v1/secrets?ownerKind=runner", bUser);
      expect(secrets.status, await secrets.clone().text()).toBe(200);
      expect(await secrets.json()).toMatchObject({
        items: [{ ownerKind: "runner", ownerId: SECRET_OWNER, name: "api-token" }],
      });

      enterStep("A's local runner to come online on B");
      await waitForRunnerOnline(bUrl, bUser, localRunnerId);
      expect(readPinnedUrl(aHome)).toBe(bUrl);
      expect(readPinnedUrl(runnerHome)).toBe(a.url);

      enterStep("A to answer sealed with a forwarding pointer");
      await expectSealedWithPointer(a.url, user, bUrl, identity.publicKey, remotePin.credential);

      enterStep("`hercule runner set-controller` to B");
      const setController = await runCli(["runner", "set-controller", bUrl], { home: runnerHome });
      expect(setController.code, `${setController.stdout}\n${setController.stderr}`).toBe(0);
      expect(readPinnedUrl(runnerHome)).toBe(bUrl);
      enterStep("the remote runner to come online on B");
      startRemoteRunner(runnerHome);
      await waitForRunnerOnline(bUrl, bUser, remotePin.runnerId);

      const aPort = a.port;
      enterStep("A to stop");
      expect(await a.stop()).toBe(0);
      const aAt = controllers.indexOf(a);
      if (aAt >= 0) controllers.splice(aAt, 1);

      enterStep("A to restart sealed");
      const aAgain = await holdController(aHome, aPort);
      await expectSealedWithPointer(
        aAgain.url,
        user,
        bUrl,
        identity.publicKey,
        remotePin.credential,
      );

      enterStep("the sealed A to stop");
      expect(await aAgain.stop()).toBe(0);
      const aAgainAt = controllers.indexOf(aAgain);
      if (aAgainAt >= 0) controllers.splice(aAgainAt, 1);
      enterStep("A to restart with --force-unseal");
      const restored = await holdController(aHome, aPort, ["--force-unseal"]);
      const restoredUser = await login(restored.url);
      const restoredIdentity = await readController(restored.url, restoredUser);
      expect(restoredIdentity.id).toBe(identity.id);
    },
    TEST_TIMEOUT_MS,
  );

  it("leaves A serving when the confirm is declined before the transfer", async () => {
    const aHome = createHome();
    const bHome = createHome();
    const a = await holdController(aHome);
    await finishSetup(aHome, a.url);
    const user = await login(a.url);
    const before = await readController(a.url, user);

    const token = await createPromotionToken(a.url, user);

    const portB = await findFreePort();
    writeHomeConfig(bHome, portB);
    const declined = await Effect.runPromise(
      Effect.flip(
        promote({
          from: a.url,
          token,
          address: `http://127.0.0.1:${String(portB)}`,
          paths: buildHomePaths(bHome, "data"),
          bindHost: "127.0.0.1",
          bindPort: portB,
          backend: "file",
          confirm: Effect.succeed(false),
          service: undefined,
          out: () => undefined,
        }),
      ),
    );
    expect(declined.message).toContain("still serves, and the token is unused");

    expect(existsSync(join(bHome, "data", "hercule.db"))).toBe(false);
    expect(existsSync(join(bHome, "master.key"))).toBe(false);
    const after = await readController(a.url, user);
    expect(after.id).toBe(before.id);
  }, 90_000);
});
