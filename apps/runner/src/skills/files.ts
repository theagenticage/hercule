/**
 * Small checks on file system paths and errors, the text cutting, and the
 * budget that the repository skills listing and the skill folder check share.
 */
import { lstat, readlink } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
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

/** Returns true when `path` is `folder` or lies below it. Both paths are absolute and have no links. */
export const isInside = (folder: string, path: string): boolean => {
  const fromFolder = relative(folder, path);
  return fromFolder !== ".." && !fromFolder.startsWith(`..${sep}`) && !isAbsolute(fromFolder);
};

/**
 * Reads the target of the link at `linkPath` as text, without touching the
 * target, and returns what is wrong with it as a clause such as "leads
 * outside its checkout". Returns undefined when the target is a relative path
 * that lands inside `checkoutPath`. Throws a file system error when
 * `linkPath` cannot be read as a link.
 *
 * A repository can link to a stale network mount, and merely looking at it
 * can hang the runner. So a link is judged by its text first, and followed
 * only when this returns undefined. A link whose target is an absolute path is
 * refused even when it points into the checkout, because that path is only
 * right on the machine that wrote it. `linkPath` is absolute and its folder
 * has no links in it.
 */
export const findLinkTargetProblem = async (
  linkPath: string,
  checkoutPath: string,
): Promise<string | undefined> => {
  const target = await readlink(linkPath);
  if (isAbsolute(target)) return "has an absolute target; use a relative link";
  return isInside(checkoutPath, resolve(dirname(linkPath), target))
    ? undefined
    : "leads outside its checkout";
};

/**
 * Looks at each folder on the way from `checkoutPath` down `relativePath`,
 * such as `.claude` and then `.claude/skills`, and returns the problem of the
 * first one that is a link with a problem (see `findLinkTargetProblem`).
 * Returns undefined when there is none. Stops quietly at the first folder that
 * is missing, because what follows cannot exist.
 */
export const findLinkProblemOnPath = async (
  checkoutPath: string,
  relativePath: string,
): Promise<string | undefined> => {
  let path = checkoutPath;
  for (const part of relativePath.split("/")) {
    path = resolve(path, part);
    try {
      if (!(await lstat(path)).isSymbolicLink()) continue;
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    const problem = await findLinkTargetProblem(path, checkoutPath);
    if (problem !== undefined) return problem;
  }
  return undefined;
};

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
