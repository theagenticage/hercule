/**
 * Tests the process logs through the release binary: a controller and the
 * runner it starts for itself each write their own file under `<home>/logs/`,
 * readable by the owner only, and neither file holds a secret.
 *
 * The run goes through every step that handles a secret an operator can see:
 * the setup token, the bearer token setup returns, the password, the API key
 * login creates, a stored secret value, and the credential the local runner
 * enrols with. The logs are read after the controller has stopped, so they
 * hold everything the run logged.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PASSWORD,
  ROOT,
  USERNAME,
  completeSetup,
  runCli,
  startController,
  type Controller,
} from "../scripts/controller-process";
import {
  createTemporaryHome,
  parseJsonOutputOrFail,
  readApiKey,
  waitForEnrolledRunner,
  type TemporaryHome,
} from "./harness";

const binary = join(ROOT, "hercule");

let state: TemporaryHome;
let controller: Controller | undefined;

/** Every secret value the run handled, by what it is, so a failure names the one that leaked. */
const secrets: Record<string, string> = {};

const logsDir = (): string => join(state.home, "logs");

beforeAll(async () => {
  if (!existsSync(binary)) {
    throw new Error(
      `no binary at ${binary}: run \`pnpm build:binary\` before \`pnpm test:binary\`.`,
    );
  }
  state = createTemporaryHome();
  controller = await startController({ home: state.home, binary });
  const url = controller.url;

  // Read before setup completes, which deletes the file.
  const setupUrl = readFileSync(join(state.home, "setup-url"), "utf8").trim();
  secrets["the setup token"] = new URL(setupUrl).searchParams.get("token")!;

  const completed = await completeSetup({ home: state.home, url, binary });
  secrets["the bearer token setup returned"] = parseJsonOutputOrFail<{ token: string }>(
    completed,
  ).token;
  secrets["the password"] = PASSWORD;

  const login = await runCli(
    ["login", url, "--username", USERNAME, "--password-stdin", "--name", "e2e-logs"],
    { home: state.home, binary, stdin: PASSWORD },
  );
  expect(login.code, `${login.stdout}\n${login.stderr}`).toBe(0);
  secrets["the API key"] = readApiKey(state.home);

  secrets["a stored secret value"] = "s3cret-value-that-no-log-may-hold";
  const stored = await runCli(["secret", "set", "plugin", "p1", "key1", "--value-stdin"], {
    home: state.home,
    binary,
    stdin: secrets["a stored secret value"],
  });
  expect(stored.code, `${stored.stdout}\n${stored.stderr}`).toBe(0);

  await waitForEnrolledRunner({ home: state.home, binary });
  const runnerFile = JSON.parse(
    readFileSync(join(state.home, "runner", "runner.json"), "utf8"),
  ) as { readonly credential: string };
  secrets["the local runner's credential"] = runnerFile.credential;

  const code = await controller.stop();
  controller = undefined;
  expect(code).toBe(0);
}, 180_000);

afterAll(async () => {
  await controller?.stop().catch(() => -1);
  state?.remove();
});

describe("the process logs", () => {
  it("are in a folder only the owner can open", () => {
    expect(statSync(logsDir()).mode & 0o777).toBe(0o700);
  });

  it.each(["controller.log", "runner.log"])("include %s, readable by the owner only", (name) => {
    const path = join(logsDir(), name);
    expect(existsSync(path), `${path} was not written`).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("hold what the controller logged while it ran", () => {
    // Without these, an empty file would pass the checks below.
    const log = readFileSync(join(logsDir(), "controller.log"), "utf8");
    expect(log).toContain("Hercule is listening on");
    expect(log).toContain("Stopping Hercule.");
  });

  it.each(["controller.log", "runner.log"])("hold no secret value in %s", (name) => {
    const log = readFileSync(join(logsDir(), name), "utf8");
    for (const [what, value] of Object.entries(secrets)) {
      expect(value, `${what} is empty, so the check would prove nothing`).not.toBe("");
      expect(log.includes(value), `${name} holds ${what}`).toBe(false);
    }
  });
});
