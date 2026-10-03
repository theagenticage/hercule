/**
 * Test helpers every adapter needs but no adapter owns:
 *
 * - a scratch home per test;
 * - a stream of lines a test pushes into;
 * - waiting for an adapter that reports on its event stream rather than
 *   through the return value of the call;
 * - the User Material of a Thread that has no paths to pass.
 *
 * They live here rather than in one adapter's folder so that copies cannot
 * drift apart, for example a wait with a different timeout, or a home one copy
 * forgets to remove.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import type { ProviderEvent } from "@hercule/protocol";
import type { UserMaterial } from "./index";

const homes: Array<string> = [];

/** Deletes every scratch home the tests created. Each test file calls it once. */
export const cleanupHomes = (): void => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
};

/**
 * Creates a scratch home for one test, with `label` (the harness) in its name, and returns its
 * path.
 */
export const createScratchHome = (label: string): string => {
  const home = mkdtempSync(join(tmpdir(), `hercule-${label}-`));
  homes.push(home);
  return home;
};

/** The native session id a test resumes. `CWD` is the directory that session ran in. */
export const PRIOR = "0199e0e7-0000-7000-8000-0000000000fa";

export const CWD = "/tmp/work";

/** Creates a stream of lines that a test pushes into and the code under test reads once. */
export const createLines = (): {
  readonly push: (line: string) => void;
  readonly end: () => void;
  readonly iterable: AsyncIterable<string>;
} => {
  const queued: Array<string> = [];
  let wake: (() => void) | undefined;
  let ended = false;
  const wakeReader = (): void => {
    const pending = wake;
    wake = undefined;
    pending?.();
  };
  return {
    push: (line) => {
      queued.push(line);
      wakeReader();
    },
    end: () => {
      ended = true;
      wakeReader();
    },
    iterable: {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          while (queued.length > 0) yield queued.shift()!;
          if (ended) return;
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      },
    },
  };
};

export const WAIT_MS = 2_000;

/**
 * Waits until `ready` returns true. Fails the test with a message built from
 * `what` when `budgetMs` runs out. A test that drives a real harness over a
 * network passes a longer budget.
 */
export const waitUntil = async (
  what: string,
  ready: () => boolean,
  budgetMs: number = WAIT_MS,
): Promise<void> => {
  const deadline = Date.now() + budgetMs;
  while (!ready() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 1));
  expect(ready(), `the adapter never ${what}`).toBe(true);
};

/**
 * Waits long enough for anything already in flight to arrive, so a test that then sees nothing can
 * trust it.
 */
export const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

export const filterByTag = <Tag extends ProviderEvent["_tag"]>(
  seen: ReadonlyArray<ProviderEvent>,
  tag: Tag,
): ReadonlyArray<Extract<ProviderEvent, { _tag: Tag }>> =>
  seen.filter((event): event is Extract<ProviderEvent, { _tag: Tag }> => event._tag === tag);

/**
 * User Material with no paths: what a Thread gets when its user has none of
 * the material, and what a Claude Code Thread always gets, because Claude
 * reads the user's material through links in its instance home.
 */
export const NO_USER_MATERIAL_PATHS: UserMaterial = {
  skillDirs: [],
  promptTemplateDirs: [],
  instructionsFile: undefined,
};
