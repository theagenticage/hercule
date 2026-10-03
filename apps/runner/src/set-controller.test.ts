/**
 * Tests `hercule runner set-controller <url>` through the runner role's
 * `run(argv)`.
 *
 * The command points a machine that has already joined at a controller that
 * has moved. These tests check what it writes to `runner.json`, what it
 * prints, and that it makes no network call.
 */
import {
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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveHomePath } from "@hercule/home";
import { run } from "./index";

/**
 * The directory `os.homedir()` returns to every module this file loads: a
 * temporary directory per test. A command that names no Home falls back to
 * `<homedir>/.hercule`, which on a developer's machine is their live Home.
 * Bun reads `HOME` once, at startup, so setting `process.env.HOME` here would
 * not move it.
 */
const fakeOs = vi.hoisted(() => ({ homedir: "" }));

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: () => fakeOs.homedir,
}));

const ORIGINAL_URL = "http://127.0.0.1:4937";
const NEW_URL = "https://controller.example:8443";

const homes: Array<string> = [];
const logged: Array<string> = [];
const errored: Array<string> = [];
let fetches = 0;

const collectInto =
  (into: Array<string>) =>
  (...args: ReadonlyArray<unknown>) => {
    into.push(args.map((arg) => String(arg)).join(" "));
  };

beforeEach(() => {
  fakeOs.homedir = createTemporaryHome();
  process.exitCode = 0;
  logged.length = 0;
  errored.length = 0;
  fetches = 0;
  vi.spyOn(console, "log").mockImplementation(collectInto(logged));
  vi.spyOn(console, "error").mockImplementation(collectInto(errored));
  // Spy on `fetch`, the only function that could make a network call, to
  // prove the command makes none.
  vi.spyOn(globalThis, "fetch").mockImplementation(() => {
    fetches += 1;
    throw new Error("set-controller reached the network");
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = 0;
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const createTemporaryHome = (): string => {
  const home = mkdtempSync(pathJoin(tmpdir(), "hercule-set-controller-"));
  homes.push(home);
  return home;
};

const buildRunnerFilePath = (home: string): string => pathJoin(home, "runner", "runner.json");

/** Creates a Hercule Home that has already joined, with `runner.json` at the mode a join sets. */
const createEnrolledHome = (
  controllerUrl: string = ORIGINAL_URL,
): {
  home: string;
  path: string;
  before: string;
} => {
  const home = createTemporaryHome();
  mkdirSync(pathJoin(home, "runner"), { recursive: true, mode: 0o700 });
  const path = buildRunnerFilePath(home);
  const contents = {
    runnerId: "0199e0e7-2222-7000-8000-000000000000",
    credential: "credential-for-thalia",
    controllerUrl,
    controllerIdentityId: "0199e0e7-1111-7000-8000-000000000000",
    controllerPublicKey: "IH5nqcbHvGUYs1n9y0sBnPGSNVYA3ZfCpZKDvXH7pqA=",
    storageDirectory: "a1b2c3d4a1b2c3d4",
  };
  writeFileSync(path, `${JSON.stringify(contents, null, 2)}\n`, { mode: 0o600 });
  return { home, path, before: readFileSync(path, "utf8") };
};

describe("hercule runner set-controller", () => {
  it("repairs a file whose controller URL does not parse", async () => {
    const { home, path } = createEnrolledHome("127.0.0.1:4937");

    await run(["--home", home, "set-controller", NEW_URL]);

    expect(process.exitCode).toBe(0);
    expect(errored).toEqual([]);
    expect(readFileSync(path, "utf8")).toContain(NEW_URL);
  });

  it("rewrites only controllerUrl, keeps the file private, and prints the new URL", async () => {
    const { home, path, before } = createEnrolledHome();

    await run(["--home", home, "set-controller", NEW_URL]);

    expect(process.exitCode).toBe(0);
    expect(errored).toEqual([]);
    expect(logged.join("\n")).toContain(NEW_URL);

    // The file is byte for byte the same apart from the URL. The credential,
    // the controller identity and the storage directory name all stay.
    const after = readFileSync(path, "utf8");
    expect(after).toContain(NEW_URL);
    expect(after.replace(NEW_URL, ORIGINAL_URL)).toBe(before);

    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(fetches).toBe(0);
  });

  it("refuses inside a session when no Home is named, and writes nothing", async () => {
    // Checked first: if the fake home directory had not reached the home
    // functions, a broken refusal would write into the developer's live Home.
    const defaultHome = pathJoin(fakeOs.homedir, ".hercule");
    expect(resolveHomePath(undefined, {})).toBe(defaultHome);
    vi.stubEnv("HERCULE_SESSION", "1");
    vi.stubEnv("HERCULE_HOME", undefined);

    await run(["set-controller", NEW_URL]);

    expect(process.exitCode).toBe(2);
    expect(errored).toEqual([
      `hercule: --home: this command runs inside a Hercule session, where the default Home (${defaultHome}) may be the user's live one. Name a scratch Home with --home <dir> or HERCULE_HOME.`,
    ]);
    expect(existsSync(defaultHome)).toBe(false);
    expect(fetches).toBe(0);
  });

  it("rejects a malformed URL, writes nothing and exits non-zero", async () => {
    const { home, path, before } = createEnrolledHome();

    await run(["--home", home, "set-controller", "not a url"]);

    expect(process.exitCode).not.toBe(0);
    expect(errored.join("\n")).toContain("not a url");
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(fetches).toBe(0);
  });

  it("fails for a home that has never joined, prints the file path, and exits non-zero", async () => {
    const home = createTemporaryHome();

    await run(["--home", home, "set-controller", NEW_URL]);

    expect(process.exitCode).not.toBe(0);
    expect(errored.join("\n")).toContain(buildRunnerFilePath(home));
    expect(existsSync(buildRunnerFilePath(home))).toBe(false);
    expect(fetches).toBe(0);
  });
});
