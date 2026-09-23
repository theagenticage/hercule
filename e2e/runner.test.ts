/**
 * Enlisting a machine out of the release binary.
 *
 * The join is the one command an operator runs on a machine that holds nothing
 * yet, so the only honest test of it is the shipped binary against a shipped
 * controller: the token is minted by the ops CLI, the command goes through
 * argv, and what it leaves behind is a real file in a real home.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PASSWORD,
  ROOT,
  USERNAME,
  readApiKey,
  runCli,
  completeSetup,
  startController,
  createTemporaryHome,
  type Controller,
  type Ran,
} from "./harness";

const state = createTemporaryHome();
const binary = join(ROOT, "hercule");

let controller: Controller;
let url: string;
/** The key `hercule login` wrote, which is what reads the fleet back. */
let apiKey: string;

/** Mints a single-use join token, the way an operator on the controller does. */
const mintToken = async (): Promise<string> => {
  const ran = await runCli(["runner", "join-token", "create", "--json"], {
    home: state.home,
    binary,
  });
  expect(ran.code, `${ran.stdout}\n${ran.stderr}`).toBe(0);
  return (JSON.parse(ran.stdout) as { token: string }).token;
};

/** One machine as the fleet lists it, with what it probed about itself. */
interface Listed {
  readonly id: string;
  readonly name: string;
  readonly connectivity: string;
  readonly reserved: boolean;
  readonly lifecycle: string;
  readonly facts: {
    readonly os: string;
    readonly arch: string;
    readonly identityPort: number;
  } | null;
}

/** The runners the controller has enlisted. */
const listRunners = async (): Promise<ReadonlyArray<Listed>> => {
  const response = await fetch(`${url}/api/v1/runners`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  const body = await response.text();
  expect(response.status, body).toBe(200);
  return (JSON.parse(body) as { items: ReadonlyArray<Listed> }).items;
};

beforeAll(async () => {
  if (!existsSync(binary)) {
    throw new Error(
      `no binary at ${binary}: run \`pnpm build:binary\` before \`pnpm test:binary\`.`,
    );
  }
  controller = await startController({ home: state.home, binary });
  url = controller.url;

  const completed = await completeSetup({ home: state.home, url, binary });
  expect(completed.code, `${completed.stdout}\n${completed.stderr}`).toBe(0);

  const login = await runCli(
    ["login", url, "--username", USERNAME, "--password-stdin", "--name", "e2e-runner"],
    { home: state.home, binary, stdin: PASSWORD },
  );
  expect(login.code, `${login.stdout}\n${login.stderr}`).toBe(0);

  apiKey = readApiKey(state.home);
}, 90_000);

afterAll(async () => {
  await controller?.stop().catch(() => -1);
  state.remove();
});

describe("hercule runner join through the binary", () => {
  it("enlists the machine, prints the name it was given and writes runner.json", async () => {
    const machine = createTemporaryHome();
    try {
      const before = new Set((await listRunners()).map((one) => one.id));
      const token = await mintToken();

      const ran = await runCli(["runner", "join", url, "--token", token], {
        home: machine.home,
        binary,
      });
      expect(ran.code, `${ran.stdout}\n${ran.stderr}`).toBe(0);

      const enlisted = (await listRunners()).filter((one) => !before.has(one.id));
      expect(enlisted).toHaveLength(1);
      expect(ran.stdout, "the command prints the name the controller assigned").toContain(
        enlisted[0]!.name,
      );

      const file = join(machine.home, "runner", "runner.json");
      expect(existsSync(file)).toBe(true);
      expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ runnerId: enlisted[0]!.id });
    } finally {
      machine.remove();
    }
  }, 60_000);

  it("fails on a token nobody minted, saying so and leaving the home empty", async () => {
    const machine = createTemporaryHome();
    try {
      const before = (await listRunners()).length;

      const ran = await runCli(["runner", "join", url, "--token", "a-token-nobody-minted"], {
        home: machine.home,
        binary,
      });
      expect(ran.code).not.toBe(0);
      // What it printed has to be about the token the controller refused, so a
      // command that never reached the controller cannot pass this.
      expect(`${ran.stdout}${ran.stderr}`).toMatch(/token|unauthenticated|unauthori[sz]ed|401/i);
      expect(existsSync(join(machine.home, "runner", "runner.json"))).toBe(false);
      expect((await listRunners()).length).toBe(before);
    } finally {
      machine.remove();
    }
  }, 60_000);

  it("fails with usage when no token is given", async () => {
    const machine = createTemporaryHome();
    try {
      const ran = await runCli(["runner", "join", url], { home: machine.home, binary });
      expect(ran.code).not.toBe(0);
      expect(`${ran.stdout}${ran.stderr}`).toMatch(/usage/i);
      expect(existsSync(join(machine.home, "runner", "runner.json"))).toBe(false);
    } finally {
      machine.remove();
    }
  }, 60_000);
});

describe("the runner the controller starts for itself", () => {
  it("is online with what it probed, and answers on the loopback port it reported", async () => {
    // The controller spawned its child while it was booting, so what is waited
    // for here is the join and the first hello finishing, not the process.
    const deadline = Date.now() + 10_000;
    let online = (await listRunners()).filter((one) => one.connectivity === "online");
    while (online.length === 0 && Date.now() < deadline) {
      await Bun.sleep(200);
      online = (await listRunners()).filter((one) => one.connectivity === "online");
    }

    expect(online, `no runner came online:\n${controller.output()}`).toHaveLength(1);
    const local = online[0]!;
    expect(local.facts, "the runner reported what it probed").not.toBeNull();
    expect(local.facts!.os.length).toBeGreaterThan(0);
    expect(local.facts!.arch.length).toBeGreaterThan(0);

    // The port it reported is the one it is really listening on, and the runner
    // behind it is the row that reported it: that pairing is the whole of what
    // makes "this machine" answerable from a browser.
    const identity = await fetch(`http://127.0.0.1:${String(local.facts!.identityPort)}/identity`);
    const said = await identity.text();
    expect(identity.status, said).toBe(200);
    expect(JSON.parse(said)).toEqual({ runnerId: local.id });
  }, 30_000);
});

describe("retiring a joined runner through the binary", () => {
  it("joins reserved, retires the daemon out of the fleet, and re-enlists beside it", async () => {
    const machine = createTemporaryHome();
    /** The daemon, once started: awaited only after the retire has landed. */
    let daemon: Promise<Ran> | undefined;
    /** The runner it is hosting, so a failed run can still stop the daemon. */
    let runnerId = "";
    try {
      const before = new Set((await listRunners()).map((one) => one.id));

      const joined = await runCli(
        ["runner", "join", url, "--token", await mintToken(), "--reserved"],
        {
          home: machine.home,
          binary,
        },
      );
      expect(joined.code, `${joined.stdout}\n${joined.stderr}`).toBe(0);

      const enlisted = (await listRunners()).filter((one) => !before.has(one.id));
      expect(enlisted).toHaveLength(1);
      const runner = enlisted[0]!;
      runnerId = runner.id;
      expect(runner.reserved, "--reserved is what the fleet reads back").toBe(true);
      expect(runner.lifecycle).toBe("active");

      // The daemon is long-lived, so the promise is held rather than awaited:
      // the retire below is what is supposed to end it.
      daemon = runCli(["runner"], { home: machine.home, binary });

      const deadline = Date.now() + 30_000;
      let live = (await listRunners()).find((one) => one.id === runner.id);
      while (live?.connectivity !== "online" && Date.now() < deadline) {
        await Bun.sleep(200);
        live = (await listRunners()).find((one) => one.id === runner.id);
      }
      expect(live?.connectivity, "the daemon never came online").toBe("online");

      const retired = await runCli(["runner", "retire", runner.id, "--force", "true"], {
        home: state.home,
        binary,
      });
      expect(retired.code, `${retired.stdout}\n${retired.stderr}`).toBe(0);

      const ended = await daemon;
      daemon = undefined;
      expect(ended.code, `the daemon stayed up:\n${ended.stdout}\n${ended.stderr}`).not.toBe(0);
      expect(`${ended.stdout}${ended.stderr}`).toContain(
        "this runner was retired; run `hercule runner join` to re-enlist",
      );

      const afterRetire = (await listRunners()).find((one) => one.id === runner.id);
      expect(afterRetire, "the retired runner stays in the fleet").toBeDefined();
      expect(afterRetire!.lifecycle).toBe("retired");

      // The same machine home, a fresh token: a new runner beside the old row
      // rather than in place of it.
      const rejoined = await runCli(["runner", "join", url, "--token", await mintToken()], {
        home: machine.home,
        binary,
      });
      expect(rejoined.code, `${rejoined.stdout}\n${rejoined.stderr}`).toBe(0);

      const fleet = await listRunners();
      const fresh = fleet.filter((one) => !before.has(one.id) && one.id !== runner.id);
      expect(fresh, "the second join made a new runner").toHaveLength(1);
      expect(fresh[0]!.lifecycle).toBe("active");
      expect(fleet.map((one) => one.id)).toContain(runner.id);
    } finally {
      // A daemon still running here is one this test failed before retiring.
      // Retire it anyway, so the leftover process cannot outlive the case and
      // hold up the controller the suite stops afterwards.
      if (daemon !== undefined) {
        await runCli(["runner", "retire", runnerId, "--force", "true"], {
          home: state.home,
          binary,
        });
        await daemon.catch(() => undefined);
      }
      machine.remove();
    }
  }, 90_000);
});
