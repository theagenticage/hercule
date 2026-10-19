/**
 * Tests that a listing whose file system call never returns is answered at
 * nine seconds, keeps its place until the call returns, and starts nothing
 * after that. Apart from `inspection.test.ts` because it replaces
 * `node:fs/promises`.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import type { Workspaces } from "../workspaces";
import { inspectRepositorySkills } from "./inspection";

/**
 * The file system as the tests see it: while `hangs` is true, opening a folder
 * does not return until `release` is called, and every file system call is
 * recorded in `calls`.
 */
const fs = vi.hoisted(() => ({
  hangs: false,
  /** When true, the next `realpath` call does not return until `release` is called. */
  holdsNextRealpath: false,
  /** How many openings of a folder are waiting for `release`. */
  waiting: 0,
  resumers: [] as Array<() => void>,
  calls: [] as Array<string>,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  const record =
    <Args extends [path: string, ...rest: Array<never>], Result>(
      name: string,
      call: (...args: Args) => Promise<Result>,
    ) =>
    (...args: Args): Promise<Result> => {
      fs.calls.push(`${name} ${String(args[0])}`);
      return call(...args);
    };
  return {
    ...original,
    lstat: record("lstat", original.lstat),
    stat: record("stat", original.stat),
    readlink: record("readlink", original.readlink),
    realpath: record("realpath", async (path: string) => {
      if (fs.holdsNextRealpath) {
        fs.holdsNextRealpath = false;
        fs.waiting += 1;
        await new Promise<void>((resume) => {
          fs.resumers.push(() => {
            fs.waiting -= 1;
            resume();
          });
        });
      }
      return original.realpath(path);
    }),
    open: record("open", original.open),
    opendir: record("opendir", async (path: string) => {
      if (fs.hangs) {
        fs.waiting += 1;
        await new Promise<void>((resume) => {
          fs.resumers.push(() => {
            fs.waiting -= 1;
            resume();
          });
        });
      }
      return original.opendir(path);
    }),
  };
});

const roots: Array<string> = [];

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Makes a folder holding one skill, `release`, and returns its path. */
const makeRepo = (): string => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hercule-inspection-hang-")));
  roots.push(root);
  mkdirSync(join(root, ".agents/skills/release"), { recursive: true });
  writeFileSync(
    join(root, ".agents/skills/release/SKILL.md"),
    "---\ndescription: Cuts a release\n---\n",
  );
  return root;
};

const SLOW = {
  status: "failed",
  message: "listing the workspace's repository skills took longer than 9 seconds",
};

const BUSY = {
  status: "failed",
  message:
    "the runner is still busy listing repository skills for earlier requests; try again in a moment",
};

describe("a listing whose file system call never returns", () => {
  let startedListings = 0;
  let workspaces: Pick<Workspaces, "resolve">;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fs.hangs = true;
    fs.holdsNextRealpath = false;
    fs.waiting = 0;
    fs.resumers = [];
    fs.calls = [];
    startedListings = 0;
    const path = makeRepo();
    workspaces = {
      resolve: () =>
        Effect.sync(() => {
          startedListings += 1;
          return {
            kind: "primary" as const,
            root: path,
            cwd: path,
            checkouts: [
              {
                checkoutId: "checkout-1",
                resourceId: "resource-1",
                remote: "github.com/acme/app",
                path,
              },
            ],
          };
        }),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.hangs = false;
    for (const resume of fs.resumers.splice(0)) resume();
  });

  const inspect = () => Effect.runPromise(inspectRepositorySkills(workspaces, "one"));

  /** Waits for `milliseconds` of real time, because the fake timers hold back `setTimeout`. */
  const waitRealTime = async (milliseconds: number): Promise<void> => {
    for (const end = Date.now() + milliseconds; Date.now() < end;) {
      await new Promise((resume) => setImmediate(resume));
    }
  };

  /** Waits until `count` folder openings hang. */
  const waitForHangs = async (count: number): Promise<void> => {
    const giveUp = Date.now() + 10_000;
    while (fs.waiting < count) {
      if (Date.now() > giveUp) throw new Error(`only ${String(fs.waiting)} openings hang`);
      await waitRealTime(1);
    }
  };

  /** Lets the hanging openings return, and gives the listings behind them time to end. */
  const releaseHangs = async (): Promise<void> => {
    fs.hangs = false;
    for (const resume of fs.resumers.splice(0)) resume();
    await waitRealTime(200);
  };

  it("answers failed at nine seconds, makes a fifth request wait without reading, and keeps four places taken", async () => {
    const four = Array.from({ length: 4 }, inspect);
    await waitForHangs(4);
    const fifth = inspect();

    await vi.advanceTimersByTimeAsync(9000);

    for (const answer of await Promise.all(four)) expect(answer).toEqual(SLOW);
    await expect(fifth).resolves.toEqual(BUSY);
    expect(startedListings).toBe(4);
    // A second batch finds no place free, and the first four calls are still the only ones open.
    const second = Array.from({ length: 4 }, inspect);
    await vi.advanceTimersByTimeAsync(9000);
    for (const answer of await Promise.all(second)) expect(answer).toEqual(BUSY);
    expect(startedListings).toBe(4);
    expect(fs.waiting).toBe(4);
  });

  it("starts no file system call after the hanging ones return, and then has its places back", async () => {
    const four = Array.from({ length: 4 }, inspect);
    await waitForHangs(4);
    await vi.advanceTimersByTimeAsync(9000);
    await Promise.all(four);
    const callsBefore = fs.calls.length;

    await releaseHangs();

    expect(fs.calls.slice(callsBefore)).toEqual([]);
    await expect(inspect()).resolves.toMatchObject({ status: "listed" });
  });

  it("starts no file system call for the checkouts when the workspace folder returns after the timeout", async () => {
    fs.hangs = false;
    fs.holdsNextRealpath = true;
    const answer = inspect();
    await waitForHangs(1);
    await vi.advanceTimersByTimeAsync(9000);
    await expect(answer).resolves.toEqual(SLOW);
    const callsBefore = fs.calls.length;

    await releaseHangs();

    expect(fs.calls.slice(callsBefore)).toEqual([]);
    await expect(inspect()).resolves.toMatchObject({ status: "listed" });
  });
});
