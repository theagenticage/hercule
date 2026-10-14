/**
 * Turns the paths an adapter wrote on a `file_change` item into the
 * `editedFiles` the controller records (spec 19 section 4.1). Adapters write
 * paths as the harness gave them: absolute, or relative to the session's
 * working directory. The controller must never see a path on the runner's
 * disk, so this file maps each path to the checkout that holds it.
 */
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join as joinPath, relative, resolve, sep } from "node:path";
import { MAX_EDITED_FILE_PATH_LENGTH, type EditedFile } from "@hercule/protocol";

/** A checkout of the session's workspace, with its real path computed once at placement. */
export interface SessionCheckout {
  readonly resourceId: string;
  /** The checkout's absolute directory, as the registry records it. */
  readonly path: string;
  /** The checkout's directory with every symbolic link resolved. Equals `path` when none could be resolved. */
  readonly realPath: string;
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

/**
 * Returns `path` with every symbolic link resolved, or undefined when the path
 * does not exist or cannot be read.
 */
const tryRealpath = (path: string): string | undefined => {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
};

/**
 * Returns the checkouts of a workspace with their real paths. A checkout whose
 * real path cannot be resolved keeps its own path, so it still matches.
 */
export const buildSessionCheckouts = (
  checkouts: ReadonlyArray<{ readonly resourceId: string; readonly path: string }>,
): ReadonlyArray<SessionCheckout> =>
  checkouts.map((checkout) => ({
    resourceId: checkout.resourceId,
    path: checkout.path,
    realPath: tryRealpath(checkout.path) ?? checkout.path,
  }));

/**
 * Returns the real path of an absolute path. A deleted file has no real path,
 * so its parent directory is resolved and the file's name is added back.
 * Returns undefined when neither exists.
 */
const resolveRealPathOfEdit = (absolutePath: string): string | undefined => {
  const whole = tryRealpath(absolutePath);
  if (whole !== undefined) return whole;
  const parent = tryRealpath(dirname(absolutePath));
  return parent === undefined ? undefined : joinPath(parent, basename(absolutePath));
};

/**
 * Returns `path` relative to `directory` when it lies strictly below it, or
 * undefined when it is the directory itself or outside it.
 */
const relativeBelow = (directory: string, path: string): string | undefined => {
  const inside = relative(directory, path);
  if (inside === "" || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    return undefined;
  }
  return inside;
};

/**
 * Finds the checkout that holds one absolute path and returns the file's
 * location in it, or undefined when no checkout holds it. A checkout holds
 * the path when the path is under the checkout's directory or under that
 * directory's real path, either as written or after its own real path is
 * resolved. When checkouts nest, the one with the longest directory wins.
 */
const locateInCheckout = (
  checkouts: ReadonlyArray<SessionCheckout>,
  absolutePath: string,
): EditedFile | undefined => {
  const realPath = resolveRealPathOfEdit(absolutePath);
  const candidates = realPath === undefined ? [absolutePath] : [absolutePath, realPath];
  let best: { readonly directoryLength: number; readonly file: EditedFile | undefined } | undefined;
  for (const checkout of checkouts) {
    for (const directory of new Set([checkout.path, checkout.realPath])) {
      for (const candidate of candidates) {
        const inside = relativeBelow(directory, candidate);
        // The checkout's own root has an empty relative path: not a file.
        // It still wins over an outer checkout, so it hides the outer match.
        const atRoot = candidate === directory;
        if (inside === undefined && !atRoot) continue;
        if (best !== undefined && best.directoryLength >= directory.length) continue;
        best = {
          directoryLength: directory.length,
          file:
            inside === undefined
              ? undefined
              : { resourceId: checkout.resourceId, path: inside.split(sep).join("/") },
        };
      }
    }
  }
  return best?.file;
};

/**
 * Returns the edited files for raw paths of a `file_change` item, in order and
 * without duplicates. Each path is resolved against `cwd`, then mapped to the
 * checkout that holds it. A path is dropped when no checkout holds it, when it
 * is a checkout's root, or when its path inside the checkout is longer than
 * `MAX_EDITED_FILE_PATH_LENGTH` or has a control character.
 *
 * Reads the disk once per path to resolve symbolic links, so call it only for
 * the items that report an edit.
 */
export const convertEditedFiles = (
  cwd: string,
  checkouts: ReadonlyArray<SessionCheckout>,
  rawPaths: ReadonlyArray<string>,
): ReadonlyArray<EditedFile> => {
  if (checkouts.length === 0) return [];
  const files = new Map<string, EditedFile>();
  for (const rawPath of rawPaths) {
    if (rawPath === "") continue;
    const file = locateInCheckout(checkouts, resolve(cwd, rawPath));
    if (
      file === undefined ||
      file.path.length > MAX_EDITED_FILE_PATH_LENGTH ||
      CONTROL_CHARACTER.test(file.path)
    ) {
      continue;
    }
    files.set(JSON.stringify([file.resourceId, file.path]), file);
  }
  return [...files.values()];
};

/**
 * Returns the paths an adapter wrote in the `detail` of a `file_change` item:
 * `detail.path` when it is a string, and every string in `detail.paths`.
 * Anything else is ignored, because a harness can report a shape the adapter
 * did not expect.
 */
export const readEditedPaths = (detail: unknown): ReadonlyArray<string> => {
  if (typeof detail !== "object" || detail === null) return [];
  const { path, paths } = detail as { readonly path?: unknown; readonly paths?: unknown };
  return [
    ...(typeof path === "string" ? [path] : []),
    ...(Array.isArray(paths)
      ? paths.filter((item): item is string => typeof item === "string")
      : []),
  ];
};
