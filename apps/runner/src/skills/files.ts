/**
 * What the skill listings and the skill folder check share: the budget, the
 * walk through links that stays inside a checkout, the reading of a folder,
 * running a listing so that it can be interrupted, file system errors, and the
 * text cutting.
 */
import type { BigIntStats, Dirent } from "node:fs";
import { lstat, opendir, readlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import * as Effect from "effect/Effect";
import { describeError } from "../report";

/**
 * The most files and folders one listing looks at, in all its checkouts and
 * skill folders together. A repository can hold any number of folders and
 * links, and a link can lead many skills to the same large folder, so without
 * one limit for the whole listing its cost has no bound.
 */
export const MAX_LISTING_ENTRIES = 10_000;

/**
 * What one listing may still spend: files and folders to look at, and time.
 * The time is over when `signal` aborts. A listing makes one budget and passes
 * it to every walk, so all of them draw on the same count.
 */
export interface ListingBudget {
  entriesLeft: number;
  /** Set when a walk asked for an entry after the last one was spent. */
  isSpent: boolean;
  readonly signal: AbortSignal;
}

/** Returns a new budget of `MAX_LISTING_ENTRIES` entries that ends when `signal` aborts. */
export const buildListingBudget = (signal: AbortSignal): ListingBudget => ({
  entriesLeft: MAX_LISTING_ENTRIES,
  isSpent: false,
  signal,
});

/**
 * Spends one entry of the budget. Returns false, and marks the budget spent,
 * when none is left; the caller must then stop looking. Throws the abort
 * reason when the time is over.
 */
export const spendEntry = (budget: ListingBudget): boolean => {
  budget.signal.throwIfAborted();
  if (budget.entriesLeft === 0) {
    budget.isSpent = true;
    return false;
  }
  budget.entriesLeft -= 1;
  return true;
};

/** Orders two names by their code units, the same way everywhere in the listing. */
export const compareNames = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The most characters of a name from the repository that a problem quotes. */
const MAX_QUOTED_NAME_LENGTH = 64;

/** The most links one path may go through, like the limit behind the `ELOOP` error. */
export const MAX_LINK_HOPS = 40;

/**
 * A folder or file that `resolveWithinCheckout` reached: its physical path,
 * whether it is a folder, and its `identity`. The identity names it in the
 * file system itself (its device and inode numbers). Every spelling of a path
 * that reaches the same thing has the same identity, which a path does not: on
 * a file system that ignores letter case, `demo` and `DEMO` are different
 * paths to one folder.
 */
export interface ReachedPath {
  readonly path: string;
  readonly isFolder: boolean;
  readonly identity: string;
}

/**
 * The outcome of `resolveWithinCheckout`: the folder or file the path leads
 * to, what is wrong with the path, or the news that the budget ran out first.
 * A problem is a clause that follows the path in a sentence, such as "leads
 * outside its checkout".
 */
export type ResolvedPath =
  | ReachedPath
  | { readonly problem: string }
  | { readonly budgetSpent: true };

/** Returns the identity of the file or folder `stats` describes (see `ResolvedPath`). */
const buildIdentity = (stats: BigIntStats): string => `${String(stats.dev)}:${String(stats.ino)}`;

/**
 * Follows `relativePath` from `folder` one component at a time, through any
 * links, and returns the physical path it leads to, whether that is a folder,
 * and its identity. `folder` is `checkoutPath` or a folder inside it, and has
 * no links in it. Returns a problem when a link has an absolute target (it is
 * only right on the machine that wrote it), when the path goes through more
 * than `MAX_LINK_HOPS` links, when it leaves `checkoutPath`, or when it
 * continues past a file (`file/..`, `file/x` and `file/` all fail on a real
 * file system, so the path is refused instead of being shortened). Returns
 * `budgetSpent` when `budget` has no entry left for the next component. Throws
 * a file system error when a component is missing or cannot be read, and the
 * abort reason of `budget.signal` when the time is over.
 *
 * A repository can link to a stale network mount, and merely looking at it
 * can hang the runner. So a component is only looked at when the folder
 * before it is already physical and inside the checkout. A link is read as
 * text and its target is joined to that folder, so a place outside the
 * checkout is refused before anything touches it. A target that climbs above
 * the checkout is refused even when the climb would come back into the
 * checkout, for example through another spelling of its name on a file system
 * that ignores letter case. Each component looked at is spent from `budget`.
 *
 * Callers pass the path of a folder entry they read from a listing to this
 * function too, instead of trusting the entry: the entry may have been
 * replaced by a link since it was read, and this function looks at it again.
 * It cannot close the gap between its own look and a later open; nothing in
 * Node can.
 */
export const resolveWithinCheckout = async (
  checkoutPath: string,
  folder: string,
  relativePath: string,
  budget: ListingBudget,
): Promise<ResolvedPath> => {
  let resolved = folder;
  let isFolder = true;
  // What the last look found at `resolved`, or undefined when it has not been looked at yet.
  let stats: BigIntStats | undefined;
  // The components still to walk, the next one last. A link's target goes on top of what follows it.
  const pending = relativePath.split("/").reverse();
  let hops = 0;
  for (let part = pending.pop(); part !== undefined; part = pending.pop()) {
    budget.signal.throwIfAborted();
    if (!isFolder) {
      return {
        problem: `goes through \`${shortenText(basename(resolved), MAX_QUOTED_NAME_LENGTH)}\`, which is not a folder`,
      };
    }
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (resolved === checkoutPath) return { problem: "leads outside its checkout" };
      resolved = dirname(resolved);
      stats = undefined;
      continue;
    }
    if (!spendEntry(budget)) return { budgetSpent: true };
    const next = join(resolved, part);
    const nextStats = await lstat(next, { bigint: true });
    budget.signal.throwIfAborted();
    if (!nextStats.isSymbolicLink()) {
      resolved = next;
      stats = nextStats;
      isFolder = nextStats.isDirectory();
      continue;
    }
    hops += 1;
    if (hops > MAX_LINK_HOPS) {
      return { problem: `goes through more than ${String(MAX_LINK_HOPS)} links` };
    }
    const target = await readlink(next);
    if (isAbsolute(target)) {
      return { problem: "goes through a link with an absolute target; use a relative link" };
    }
    pending.push(...target.split("/").reverse());
  }
  stats ??= await lstat(resolved, { bigint: true });
  budget.signal.throwIfAborted();
  return { path: resolved, isFolder, identity: buildIdentity(stats) };
};

/**
 * The files and folders read from one folder, sorted by name, and why the
 * reading stopped early. `stoppedBy` is undefined when the folder was read to
 * its end.
 */
export interface FolderEntries {
  readonly entries: ReadonlyArray<Dirent>;
  readonly stoppedBy: "budget" | "limit" | undefined;
}

/**
 * Reads the entries of `folder` one at a time and spends one entry of `budget`
 * for each one it reads, plain files included. Stops when the budget is spent
 * (`stoppedBy` is "budget") or when it reads more than `limit` entries
 * (`stoppedBy` is "limit"), so a folder of any size costs at most that much
 * to look at. The entries read are sorted by name only after the reading, and
 * the extra entry that stopped it is not among them. Throws a file system
 * error when the folder cannot be read, and the abort reason of
 * `budget.signal` when the time is over.
 */
export const readFolderEntries = async (
  folder: string,
  budget: ListingBudget,
  limit = Number.POSITIVE_INFINITY,
): Promise<FolderEntries> => {
  budget.signal.throwIfAborted();
  const dir = await opendir(folder);
  try {
    const entries: Array<Dirent> = [];
    let stoppedBy: FolderEntries["stoppedBy"];
    for (;;) {
      budget.signal.throwIfAborted();
      const entry = await dir.read();
      budget.signal.throwIfAborted();
      if (entry === null) break;
      if (!spendEntry(budget)) {
        stoppedBy = "budget";
        break;
      }
      if (entries.length === limit) {
        stoppedBy = "limit";
        break;
      }
      entries.push(entry);
    }
    return { entries: entries.sort((a, b) => compareNames(a.name, b.name)), stoppedBy };
  } finally {
    await dir.close();
  }
};

/**
 * Runs `run`, which returns the outcome of the effect, and passes it a signal
 * that aborts when the effect is interrupted. Unlike `Effect.promise`, an
 * interrupted effect does not end at once: it ends when the promise `run`
 * returned has settled, so whoever holds a permit around it keeps the permit
 * for as long as its file system calls can still run. A promise that rejects
 * is a defect.
 */
export const runUntilStopped = <A, E = never>(
  run: (signal: AbortSignal) => Promise<Effect.Effect<A, E>>,
): Effect.Effect<A, E> =>
  Effect.callback<A, E>((resume, signal) => {
    const settled = run(signal).then(resume, (error: unknown) => resume(Effect.die(error)));
    return Effect.promise(() => settled);
  });

/** Returns true when `error` is a Node error for a missing file or a path through a file. */
export const isMissing = (error: unknown): boolean =>
  error instanceof Error &&
  "code" in error &&
  (error.code === "ENOENT" || error.code === "ENOTDIR");

/**
 * Returns the message of a file system error without the absolute path Node
 * puts at its end (`ENOENT: no such file or directory, open '/home/me/x'`).
 * The message reaches clients, and a runner's paths stay on the runner.
 */
export const describeFileError = (error: unknown): string =>
  describeError(error).replace(/, \w+ '.*'$/s, "");

/**
 * Returns `text` unchanged when it has at most `limit` characters (UTF-16
 * code units, which is what the protocol's limits count). Otherwise returns
 * a cut of it that ends in `...` and has `limit` characters at most. The cut
 * never splits a surrogate pair.
 */
export const fitText = (text: string, limit: number): string =>
  text.length <= limit ? text : `${keepStart(text, limit - 3)}...`;

/**
 * Returns `text` unchanged when it has at most `keep` characters. Otherwise
 * returns its first `keep` characters followed by `...`. The cut never splits
 * a surrogate pair.
 */
export const shortenText = (text: string, keep: number): string =>
  text.length <= keep ? text : `${keepStart(text, keep)}...`;

/** Returns the first `length` characters of `text`, or one less when the cut would split a surrogate pair. */
const keepStart = (text: string, length: number): string => {
  const lastCode = text.charCodeAt(length - 1);
  const isHighSurrogate = lastCode >= 0xd800 && lastCode <= 0xdbff;
  return text.slice(0, isHighSurrogate ? length - 1 : length);
};
