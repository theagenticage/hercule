/**
 * `hydra runner set-controller <url>`, through the runner role's `run(argv)`.
 *
 * The verb re-points an already enrolled machine at a moved controller, so what
 * is proved here is what it leaves in `runner.json` and what it says - and that
 * it reaches no controller to do it.
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
import { run } from "./index";

const ORIGINAL_URL = "http://127.0.0.1:4937";
const NEW_URL = "https://controller.example:8443";

const homes: Array<string> = [];
const logged: Array<string> = [];
const errored: Array<string> = [];
let fetches = 0;

const collect =
  (into: Array<string>) =>
  (...args: ReadonlyArray<unknown>) => {
    into.push(args.map((arg) => String(arg)).join(" "));
  };

beforeEach(() => {
  process.exitCode = 0;
  logged.length = 0;
  errored.length = 0;
  fetches = 0;
  vi.spyOn(console, "log").mockImplementation(collect(logged));
  vi.spyOn(console, "error").mockImplementation(collect(errored));
  // The verb makes no network call, which is only a claim until something
  // watches the one function that could make one.
  vi.spyOn(globalThis, "fetch").mockImplementation(() => {
    fetches += 1;
    throw new Error("set-controller reached the network");
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = 0;
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const temporaryHome = (): string => {
  const home = mkdtempSync(pathJoin(tmpdir(), "hydra-set-controller-"));
  homes.push(home);
  return home;
};

const runnerFile = (home: string): string => pathJoin(home, "runner", "runner.json");

/** A home a machine has already joined from, at the mode the join leaves. */
const enrolled = (
  controllerUrl: string = ORIGINAL_URL,
): {
  home: string;
  path: string;
  before: string;
} => {
  const home = temporaryHome();
  mkdirSync(pathJoin(home, "runner"), { recursive: true, mode: 0o700 });
  const path = runnerFile(home);
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

describe("hydra runner set-controller", () => {
  it("repairs a file whose controller URL no longer reads as one", async () => {
    const { home, path } = enrolled("127.0.0.1:4937");

    await run(["--home", home, "set-controller", NEW_URL]);

    expect(process.exitCode).toBe(0);
    expect(errored).toEqual([]);
    expect(readFileSync(path, "utf8")).toContain(NEW_URL);
  });

  it("rewrites only controllerUrl, keeps the file the runner's alone, prints the new URL", async () => {
    const { home, path, before } = enrolled();

    await run(["--home", home, "set-controller", NEW_URL]);

    expect(process.exitCode).toBe(0);
    expect(errored).toEqual([]);
    expect(logged.join("\n")).toContain(NEW_URL);

    // Byte for byte the file it was, with the one address swapped: the
    // credential and the identity it was issued against survive a re-point, and
    // so does the storage directory naming a previous life's folders.
    const after = readFileSync(path, "utf8");
    expect(after).toContain(NEW_URL);
    expect(after.replace(NEW_URL, ORIGINAL_URL)).toBe(before);

    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(fetches).toBe(0);
  });

  it("refuses a malformed URL, writes nothing and exits non-zero", async () => {
    const { home, path, before } = enrolled();

    await run(["--home", home, "set-controller", "not a url"]);

    expect(process.exitCode).not.toBe(0);
    expect(errored.join("\n")).toContain("not a url");
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(fetches).toBe(0);
  });

  it("refuses a home that has never joined, naming the file, and exits non-zero", async () => {
    const home = temporaryHome();

    await run(["--home", home, "set-controller", NEW_URL]);

    expect(process.exitCode).not.toBe(0);
    expect(errored.join("\n")).toContain(runnerFile(home));
    expect(existsSync(runnerFile(home))).toBe(false);
    expect(fetches).toBe(0);
  });
});
