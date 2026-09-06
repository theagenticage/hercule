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
  apiKeyIn,
  cli,
  completeSetup,
  startController,
  temporaryHome,
  type Controller,
} from "./harness";

const state = temporaryHome();
const binary = join(ROOT, "hydra");

let controller: Controller;
let url: string;
/** The key `hydra login` wrote, which is what reads the fleet back. */
let apiKey: string;

/** Mints a single-use join token, the way an operator on the controller does. */
const mintToken = async (): Promise<string> => {
  const ran = await cli(["runner", "createJoinToken", "--json"], {
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
  readonly facts: {
    readonly os: string;
    readonly arch: string;
    readonly identityPort: number;
  } | null;
}

/** The runners the controller has enlisted. */
const runners = async (): Promise<ReadonlyArray<Listed>> => {
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

  const login = await cli(
    ["login", url, "--username", USERNAME, "--password-stdin", "--name", "e2e-runner"],
    { home: state.home, binary, stdin: PASSWORD },
  );
  expect(login.code, `${login.stdout}\n${login.stderr}`).toBe(0);

  apiKey = apiKeyIn(state.home);
}, 90_000);

afterAll(async () => {
  await controller?.stop().catch(() => -1);
  state.remove();
});

describe("hydra runner join through the binary", () => {
  it("enlists the machine, prints the name it was given and writes runner.json", async () => {
    const machine = temporaryHome();
    try {
      const before = new Set((await runners()).map((one) => one.id));
      const token = await mintToken();

      const ran = await cli(["runner", "join", url, "--token", token], {
        home: machine.home,
        binary,
      });
      expect(ran.code, `${ran.stdout}\n${ran.stderr}`).toBe(0);

      const enlisted = (await runners()).filter((one) => !before.has(one.id));
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
    const machine = temporaryHome();
    try {
      const before = (await runners()).length;

      const ran = await cli(["runner", "join", url, "--token", "a-token-nobody-minted"], {
        home: machine.home,
        binary,
      });
      expect(ran.code).not.toBe(0);
      // What it printed has to be about the token the controller refused, so a
      // command that never reached the controller cannot pass this.
      expect(`${ran.stdout}${ran.stderr}`).toMatch(/token|unauthenticated|unauthori[sz]ed|401/i);
      expect(existsSync(join(machine.home, "runner", "runner.json"))).toBe(false);
      expect((await runners()).length).toBe(before);
    } finally {
      machine.remove();
    }
  }, 60_000);

  it("fails with usage when no token is given", async () => {
    const machine = temporaryHome();
    try {
      const ran = await cli(["runner", "join", url], { home: machine.home, binary });
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
    let online = (await runners()).filter((one) => one.connectivity === "online");
    while (online.length === 0 && Date.now() < deadline) {
      await Bun.sleep(200);
      online = (await runners()).filter((one) => one.connectivity === "online");
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
