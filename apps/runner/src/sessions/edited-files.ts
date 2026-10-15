/**
 * Turns the paths an adapter wrote on a `file_change` item into the
 * `editedFiles` the controller records (spec 19 section 4.1). Adapters write
 * paths as the harness gave them: absolute, or relative to the session's
 * working directory. The controller must never see a path on the runner's
 * disk, so this file maps each path to the checkout that holds it.
 *
 * Every comparison happens in one canonical namespace: the path with every
 * symbolic link resolved, in the case the disk stores it (`realpath.native`).
 * Two spellings of one file then give one key, and checkouts that nest are
 * compared by directories of one namespace.
 */
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join as joinPath, relative, resolve, sep } from "node:path";
import { EditedFile, MAX_EDITED_FILES } from "@hercule/protocol";
import { Schema } from "effect";

/** A checkout of the session's workspace. */
export interface SessionCheckout {
  readonly resourceId: string;
  /**
   * The checkout's directory in the canonical namespace, computed once at
   * placement. It is the directory as registered when the disk cannot resolve it.
   */
  readonly path: string;
}

/** The result of converting the raw paths of one edit. */
export interface ConvertedEdit {
  /** The edited files, in order, without duplicates, at most `MAX_EDITED_FILES`. */
  readonly files: ReadonlyArray<EditedFile>;
  /** How many raw paths were not looked at, because `files` was full or the examination budget ran out. */
  readonly unchecked: number;
}

const isEditedFile = Schema.is(EditedFile);

/**
 * The most distinct paths one edit may have examined, found or dropped. A
 * dropped path (outside every checkout, or not a valid `EditedFile` path)
 * costs disk reads as well, and a harness can report thousands of them, so
 * stopping only at `MAX_EDITED_FILES` found files would not bound the work.
 * The factor leaves room for a few dropped paths per recorded file.
 */
const MAX_EXAMINED_PATHS = MAX_EDITED_FILES * 4;

/**
 * Returns `path` with every symbolic link resolved and its case as stored on
 * disk, or undefined when the path does not exist or cannot be read.
 */
const tryRealpath = (path: string): string | undefined => {
  try {
    return realpathSync.native(path);
  } catch {
    return undefined;
  }
};

/**
 * Returns the canonical form of an absolute path. A path that does not exist
 * (a deleted file, or a file in a directory the edit removed) has no real
 * path, so its nearest existing ancestor is resolved and the missing names are
 * added back. Returns the path as written when no ancestor can be resolved.
 *
 * Known limit: the added names keep the case the harness wrote. A deleted file
 * has no stored case to read, so on a case-insensitive filesystem a deleted
 * `Foo.ts` and `foo.ts` give two different keys.
 */
const resolveCanonicalPath = (absolutePath: string): string => {
  const whole = tryRealpath(absolutePath);
  if (whole !== undefined) return whole;
  const parent = dirname(absolutePath);
  if (parent === absolutePath) return absolutePath;
  return joinPath(resolveCanonicalPath(parent), basename(absolutePath));
};

/**
 * Returns the checkouts of a workspace with their directories in the
 * canonical namespace. A checkout the disk cannot resolve keeps its own path.
 */
export const buildSessionCheckouts = (
  checkouts: ReadonlyArray<{ readonly resourceId: string; readonly path: string }>,
): ReadonlyArray<SessionCheckout> =>
  checkouts.map((checkout) => ({
    resourceId: checkout.resourceId,
    path: tryRealpath(checkout.path) ?? resolve(checkout.path),
  }));

/**
 * Returns `path` relative to `directory` when it lies strictly below it, or
 * undefined when it is the directory itself or outside it.
 */
const findPathBelow = (directory: string, path: string): string | undefined => {
  const inside = relative(directory, path);
  if (inside === "" || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    return undefined;
  }
  return inside;
};

/**
 * Finds the checkout that holds one absolute path and returns the file's
 * location in it, or undefined when no checkout holds it. The path is made
 * canonical first. When checkouts nest, the one with the longest directory
 * wins, and a checkout's own root hides an outer checkout's match.
 */
const locateInCheckout = (
  checkouts: ReadonlyArray<SessionCheckout>,
  absolutePath: string,
): { readonly resourceId: string; readonly path: string } | undefined => {
  const canonical = resolveCanonicalPath(absolutePath);
  let best:
    | {
        readonly directoryLength: number;
        readonly file: { resourceId: string; path: string } | undefined;
      }
    | undefined;
  for (const checkout of checkouts) {
    const inside = findPathBelow(checkout.path, canonical);
    const atRoot = canonical === checkout.path;
    if (inside === undefined && !atRoot) continue;
    if (best !== undefined && best.directoryLength >= checkout.path.length) continue;
    best = {
      directoryLength: checkout.path.length,
      file:
        inside === undefined
          ? undefined
          : { resourceId: checkout.resourceId, path: inside.split(sep).join("/") },
    };
  }
  return best?.file;
};

/**
 * Returns the edited files for raw paths of a `file_change` item, in order and
 * without duplicates, and how many raw paths it did not look at. Each path is
 * resolved against `cwd`, then mapped to the checkout that holds it. A path is
 * dropped when no checkout holds it, when it is a checkout's root, or when its
 * path inside the checkout is not a valid `EditedFile` path.
 *
 * It reads the disk once per distinct path, and stops at the first of two
 * limits: `MAX_EDITED_FILES` files found, or `MAX_EXAMINED_PATHS` distinct
 * paths examined, whether kept or dropped. A harness can report thousands of
 * paths, and this runs while the runner holds its sequencing lock.
 */
export const convertEditedFiles = (
  cwd: string,
  checkouts: ReadonlyArray<SessionCheckout>,
  rawPaths: ReadonlyArray<string>,
): ConvertedEdit => {
  if (checkouts.length === 0) return { files: [], unchecked: 0 };
  const distinct = [...new Set(rawPaths)].filter((path) => path !== "");
  const files = new Map<string, EditedFile>();
  for (const [index, rawPath] of distinct.entries()) {
    if (files.size >= MAX_EDITED_FILES || index >= MAX_EXAMINED_PATHS) {
      return { files: [...files.values()], unchecked: distinct.length - index };
    }
    const located = locateInCheckout(checkouts, resolve(cwd, rawPath));
    if (located === undefined || !isEditedFile(located)) continue;
    files.set(JSON.stringify([located.resourceId, located.path]), located);
  }
  return { files: [...files.values()], unchecked: 0 };
};

/**
 * Returns the paths an adapter wrote in the `detail` of a `file_change` item:
 * `detail.path` when it is a string, and every string in `detail.paths`.
 * Anything else is ignored, because a harness can report a shape the adapter
 * did not expect.
 */
export const readDetailPaths = (detail: unknown): ReadonlyArray<string> => {
  if (typeof detail !== "object" || detail === null) return [];
  const { path, paths } = detail as { readonly path?: unknown; readonly paths?: unknown };
  return [
    ...(typeof path === "string" ? [path] : []),
    ...(Array.isArray(paths)
      ? paths.filter((item): item is string => typeof item === "string")
      : []),
  ];
};
