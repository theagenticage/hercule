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
const restore: Array<() => void> = [];
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
  const log = vi.spyOn(console, "log").mockImplementation(collect(logged));
  const error = vi.spyOn(console, "error").mockImplementation(collect(errored));
  // The verb makes no network call, which is only a claim until something
  // watches the one function that could make one.
  const fetched = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
    fetches += 1;
    throw new Error("set-controller reached the network");
  });
  restore.push(
    () => {
      log.mockRestore();
    },
    () => {
      error.mockRestore();
    },
    () => {
      fetched.mockRestore();
    },
  );
});

afterEach(() => {
  for (const undo of restore.splice(0)) undo();
  process.exitCode = 0;
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const temporaryHome = (): string => {
  const home = mkdtempSync(pathJoin(tmpdir(), "hydra-set-controller-"));
  homes.push(home);
  return home;
};

const runnerFile = (home: string): string => pathJoin(home, "runner", "runner.json");

/** A home a machine has already joined from. */
const enrolled = (): { home: string; path: string; before: string } => {
  const home = temporaryHome();
  mkdirSync(pathJoin(home, "runner"), { recursive: true, mode: 0o700 });
  const path = runnerFile(home);
  const contents = {
    runnerId: "0199e0e7-2222-7000-8000-000000000000",
    credential: "credential-for-thalia",
    controllerUrl: ORIGINAL_URL,
    controllerIdentityId: "0199e0e7-1111-7000-8000-000000000000",
    controllerPublicKey: "IH5nqcbHvGUYs1n9y0sBnPGSNVYA3ZfCpZKDvXH7pqA=",
    storageDirectory: "a1b2c3d4a1b2c3d4",
  };
  // At the mode the join leaves it at.
  writeFileSync(path, `${JSON.stringify(contents, null, 2)}\n`, { mode: 0o600 });
  return { home, path, before: readFileSync(path, "utf8") };
};

describe("hydra runner set-controller", () => {
  it("rewrites only controllerUrl, keeps the file the runner's alone, prints the new URL", async () => {
    const { home, path, before } = enrolled();

    await run(["--home", home, "set-controller", NEW_URL]);

    expect(process.exitCode).toBe(0);
    expect(errored).toEqual([]);
    expect(logged.join("\n")).toContain(NEW_URL);

    const written = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(written["controllerUrl"]).toBe(NEW_URL);

    // The credential and the identity it was issued against survive a re-point;
    // so does the storage directory, whose name is a previous life's folders.
    const strip = (raw: string): Record<string, unknown> => {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      delete parsed["controllerUrl"];
      return parsed;
    };
    expect(strip(readFileSync(path, "utf8"))).toEqual(strip(before));
    expect(Object.keys(written)).toEqual(Object.keys(JSON.parse(before) as object));

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
