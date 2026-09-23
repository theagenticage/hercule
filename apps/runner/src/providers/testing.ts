/**
 * What every adapter's tests need and no adapter owns: a scratch home per
 * test, a stream of lines a script pushes into, and the waiting a test does on
 * an adapter that answers on its own stream rather than from its call.
 *
 * It lives here rather than in one adapter's folder because two folders
 * holding the same helper is two of them drifting: a wait that gives up after
 * a different interval, or a home one of them forgets to remove.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import type { ProviderEvent } from "@hercule/protocol";

const homes: Array<string> = [];

/** Every scratch home a test made, thrown away. Each test file runs it once. */
export const cleanupHomes = (): void => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
};

/** A home of this test's own, named for the harness it stands in for. */
export const createScratchHome = (label: string): string => {
  const home = mkdtempSync(join(tmpdir(), `hercule-${label}-`));
  homes.push(home);
  return home;
};

/** The native session a test carries on from, and the directory it ran in. */
export const PRIOR = "0199e0e7-0000-7000-8000-0000000000fa";

export const CWD = "/tmp/work";

/** A stream of lines a test pushes into, read once by the code under test. */
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
 * Waits for something the adapter has done, or gives up and says what it was.
 * A case driving a real harness over a network gives itself longer.
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

/** Long enough for anything already in flight to have arrived, so "nothing" means it. */
export const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

export const filterByTag = <Tag extends ProviderEvent["_tag"]>(
  seen: ReadonlyArray<ProviderEvent>,
  tag: Tag,
): ReadonlyArray<Extract<ProviderEvent, { _tag: Tag }>> =>
  seen.filter((event): event is Extract<ProviderEvent, { _tag: Tag }> => event._tag === tag);
