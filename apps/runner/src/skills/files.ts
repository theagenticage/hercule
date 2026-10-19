/**
 * Small checks on file system paths and errors that the repository skills
 * listing and the skill folder check share.
 */
import { isAbsolute, relative, sep } from "node:path";
import { describeError } from "../report";

/** Returns true when `path` is `folder` or lies below it. Both paths are absolute and have no links. */
export const isInside = (folder: string, path: string): boolean => {
  const fromFolder = relative(folder, path);
  return fromFolder !== ".." && !fromFolder.startsWith(`..${sep}`) && !isAbsolute(fromFolder);
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
