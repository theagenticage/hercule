/**
 * Reads skill folders from the local disk: finds the skills in a folder the
 * user picked, and builds the tar archive of one skill for `skill.import`.
 *
 * The CLI's `hercule skill import` and the desktop app's main process both
 * call it, so the two read a folder the same way (spec 11 §6.3, spec 17
 * §The IPC contract). It reads only files and checks no content rule: the
 * controller checks every skill when it is imported.
 *
 * It uses `node:fs`, so it is reached only as `@hercule/client-core/skill-folder`
 * and never from the package's index, which the desktop renderer links.
 */
import { constants, type Dirent, type Stats } from "node:fs";
import { open, readdir, realpath, stat, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  buildSkillArchive,
  computeSkillArchiveByteLength,
  convertToSkillFileMode,
  MAX_SKILL_BYTES,
  MAX_SKILL_FILES,
  SkillImportInput,
  type SkillFile,
} from "@hercule/contract";
import { Effect, Schema } from "effect";
import { formatBytes } from "./format-bytes";
import type { LockedSkillSource } from "./skills";

/**
 * A folder, or a file or link inside it, cannot be read, or the skill in it
 * cannot be put in an archive.
 */
export class SkillFolderUnreadable extends Schema.TaggedError<SkillFolderUnreadable>()(
  "SkillFolderUnreadable",
  {
    /** One plain sentence or two, naming the path or link and what to do. */
    reason: Schema.String,
  },
) {}

/** The skill's archive is over `MAX_SKILL_BYTES`, so the controller would refuse it. */
export class SkillTooLarge extends Schema.TaggedError<SkillTooLarge>()("SkillTooLarge", {
  name: Schema.String,
}) {}

/** A skill folder found in the folder the user picked. */
export interface FoundSkill {
  /** The skill folder's name, as given: a link's own name, not its target's. */
  readonly name: string;
  /** The path to pass to `buildSkillFolderArchive`. */
  readonly folder: string;
  /** The GitHub source the lock file gives the skill, or null for an `upload` source. */
  readonly source: LockedSkillSource | null;
}

/** The skills in a folder the user picked. */
export interface SkillFolders {
  /** The picked folder's real path, with any symbolic link resolved. */
  readonly folder: string;
  /** The picked folder as given, with the home folder written `~`, for showing. */
  readonly displayPath: string;
  /** One line about a lock file that could not be read, or null. */
  readonly lockFileProblem: string | null;
  /** The skill folders, sorted by name. Empty when the folder holds none. */
  readonly skills: ReadonlyArray<FoundSkill>;
}

const SKILL_FILE = "SKILL.md";
const SKILL_LOCK_FILE = ".skill-lock.json";

/** Entries the reader leaves out of every archive, at any depth. */
const SKIPPED_NAMES: ReadonlySet<string> = new Set([".DS_Store", "Thumbs.db", ".git"]);

/** The largest lock file the reader reads. The `skills` tool writes a few kilobytes. */
const MAX_SKILL_LOCK_BYTES = 1024 * 1024;

/**
 * How the reader opens a file. `O_NOFOLLOW` refuses a path that became a
 * symbolic link after it was resolved, and `O_NONBLOCK` keeps a named pipe
 * from blocking the open until something writes to it.
 */
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/**
 * Finds the skills in `folder`. The folder itself is one skill when it holds
 * a `SKILL.md`; otherwise every subfolder that holds one is a skill.
 *
 * The folder may be a symbolic link, which is resolved first. A subfolder may
 * be a link too, as the `skills` tool makes them; its target may be anywhere.
 * Each skill's GitHub source comes from the nearest `.skill-lock.json`. A lock
 * file that cannot be read is reported in `lockFileProblem` and never fails.
 *
 * Fails with `SkillFolderUnreadable` when the folder does not exist, is not a
 * folder, or cannot be listed.
 */
export const findSkillFolders = (
  folder: string,
): Effect.Effect<SkillFolders, SkillFolderUnreadable> =>
  Effect.gen(function* () {
    const given = path.resolve(folder);
    const displayPath = writeHomeAsTilde(given);
    const resolved = yield* openFolder(given, displayPath);
    const lock = yield* readNearestSkillLock(given);
    const findLockedSkillSource = (name: string) => lock.sources.get(name) ?? null;

    if (yield* holdsSkillFile(resolved)) {
      const name = path.basename(given);
      return {
        folder: resolved,
        displayPath,
        lockFileProblem: lock.problem,
        // The path as given, not the link's target, so `buildSkillFolderArchive` names
        // the skill and its files by the name the user knows.
        skills: [{ name, folder: given, source: findLockedSkillSource(name) }],
      };
    }

    const entries = yield* tryFileCall(
      () => readdir(resolved, { withFileTypes: true }),
      `\`${displayPath}\``,
    );
    const candidates = entries.filter((entry) => entry.isDirectory() || entry.isSymbolicLink());
    const found = yield* Effect.filter(
      candidates,
      (entry) => holdsSkillFile(path.join(resolved, entry.name)),
      { concurrency: 16 },
    );
    const skills = found
      .map((entry) => ({
        name: entry.name,
        folder: path.join(resolved, entry.name),
        source: findLockedSkillSource(entry.name),
      }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return { folder: resolved, displayPath, lockFileProblem: lock.problem, skills };
  });

/**
 * Reads one skill folder and returns its tar archive, built with
 * `buildSkillArchive`.
 *
 * - The folder may be a symbolic link; its target counts as the folder.
 * - A link inside is followed only when its target is inside that folder. The
 *   archive then holds the target's content under the link's path.
 * - `.DS_Store`, `Thumbs.db` and `.git` are skipped at any depth, and an empty
 *   folder is left out, because the archive holds no folder entries.
 * - A file with the owner's execute bit gets mode `755`, any other `644`.
 *
 * Fails with `SkillFolderUnreadable` naming the path when a file cannot be
 * read or changes while it is read, a link points outside the folder or
 * forms a cycle, an entry is a socket, pipe or device, a path is too long for
 * a tar archive, or the skill holds more than `MAX_SKILL_FILES` files. Fails with `SkillTooLarge` when the
 * archive is over `MAX_SKILL_BYTES`. The walk stops as soon as either limit
 * is passed, so a huge folder is never read whole.
 */
export const buildSkillFolderArchive = (
  skillFolder: string,
): Effect.Effect<Uint8Array, SkillFolderUnreadable | SkillTooLarge> =>
  Effect.gen(function* () {
    const given = path.resolve(skillFolder);
    const name = path.basename(given);
    const root = yield* openFolder(given, writeHomeAsTilde(given));

    // The size of every file read from disk. Each lands in the archive at
    // least once, so their archive is a lower bound of the real one, and the
    // walk stops before it reads a file that would pass the limit.
    const readSizes: Array<number> = [];
    // The files under every real folder walked, with paths relative to that
    // folder, or null while its walk runs. A folder that several links reach
    // is read once and its files reused, so links between folders cannot
    // make the walk grow without limit; a link to a folder whose walk runs
    // is a cycle.
    const walkedFolders = new Map<string, ReadonlyArray<SkillFile> | null>();

    /** Fails when `files`, which all go into the archive, pass the file count or the size limit. */
    const checkLimits = (files: ReadonlyArray<SkillFile>) => {
      if (files.length > MAX_SKILL_FILES) {
        const most = MAX_SKILL_FILES.toLocaleString("en-US");
        return refuse(
          `\`${name}\` has more than ${most} files. A skill holds at most ${most}; remove the files it does not need.`,
        );
      }
      const sizes = files.map((file) => file.content.byteLength);
      return computeSkillArchiveByteLength(sizes) > MAX_SKILL_BYTES
        ? Effect.fail(new SkillTooLarge({ name }))
        : Effect.void;
    };

    /**
     * Reads the file at the real path `realPath` through one handle, and
     * returns it as `path`. Reading through the handle means the file checked
     * is the file read: the path cannot be swapped for a link to a file
     * outside the skill in between.
     */
    const readSkillFile = (realPath: string, filePath: string, shown: string) =>
      Effect.acquireUseRelease(
        tryFileCall(() => open(realPath, READ_FLAGS), shown),
        (handle) =>
          Effect.gen(function* () {
            const info = yield* tryFileCall(() => handle.stat(), shown);
            if (!info.isFile()) return yield* refuseSpecialFile(shown, info);
            if (computeSkillArchiveByteLength([...readSizes, info.size]) > MAX_SKILL_BYTES)
              return yield* new SkillTooLarge({ name });
            const content = yield* tryFileCall(() => readFileContent(handle, info.size), shown);
            if (content === null) {
              return yield* refuse(
                `${shown} grew while it was read. Try again once it is written.`,
              );
            }
            readSizes.push(content.byteLength);
            const file: SkillFile = {
              path: filePath,
              mode: convertToSkillFileMode(info.mode),
              content,
            };
            return file;
          }),
        closeFile,
      );

    /**
     * Returns every file under the real folder `realFolder`, with paths
     * relative to it. `archiveFolder` is the folder's path in the archive
     * ("" for the skill folder itself), which the reasons name.
     */
    const walk = (
      realFolder: string,
      archiveFolder: string,
    ): Effect.Effect<ReadonlyArray<SkillFile>, SkillFolderUnreadable | SkillTooLarge> =>
      Effect.gen(function* () {
        walkedFolders.set(realFolder, null);
        const shownFolder = archiveFolder === "" ? name : `${name}/${archiveFolder}`;
        const entries = yield* tryFileCall(
          () => readdir(realFolder, { withFileTypes: true }),
          `\`${shownFolder}\``,
        );
        const files: Array<SkillFile> = [];
        for (const entry of entries) {
          if (SKIPPED_NAMES.has(entry.name)) continue;
          const archivePath = archiveFolder === "" ? entry.name : `${archiveFolder}/${entry.name}`;
          const shown = `\`${name}/${archivePath}\``;
          const entryPath = path.join(realFolder, entry.name);
          if (!entry.isDirectory() && !entry.isFile() && !entry.isSymbolicLink()) {
            return yield* refuseSpecialFile(shown, entry);
          }

          // Every entry is resolved and checked, not only the links: a file
          // or folder can be swapped for a link after the folder was listed.
          // A parent folder swapped for a link between this check and the
          // open is still followed; closing that gap needs `openat`, which
          // Node does not offer.
          const realPath = entry.isSymbolicLink()
            ? yield* resolveLink(entryPath, shown)
            : yield* tryFileCall(() => realpath(entryPath), shown);
          if (!isInsideFolder(root, realPath)) {
            return yield* refuse(
              `${shown} points outside the skill's folder. A skill holds only its own files; copy what it needs into its folder.`,
            );
          }
          const info = yield* tryFileCall(() => stat(realPath), shown);
          if (!info.isDirectory()) {
            files.push(yield* readSkillFile(realPath, entry.name, shown));
          } else {
            const walked = walkedFolders.get(realPath);
            if (walked === null) {
              return yield* refuse(
                `${shown} points to a folder that contains it, which makes a cycle of links. Remove the link from the skill's folder.`,
              );
            }
            const inner = walked ?? (yield* walk(realPath, archivePath));
            for (const file of inner) files.push({ ...file, path: `${entry.name}/${file.path}` });
          }
          yield* checkLimits(files);
        }
        walkedFolders.set(realFolder, files);
        return files;
      });

    const files = yield* walk(root, "");

    return yield* buildSkillArchive(files).pipe(
      Effect.mapError(
        // The reason names the path from the skill's folder, as every other
        // reason here does, where the builder names it inside the skill.
        (error) =>
          new SkillFolderUnreadable({
            reason: `\`${name}/${error.path}\` is too long for a tar archive. Shorten its folder names or its file name.`,
          }),
      ),
    );
  });

/**
 * Reads the content of the open file `handle`, which `fstat` gave `size`
 * bytes, from its start. Returns null when the file holds more than `size`
 * bytes, because it grew after `fstat`: reading on would pass the limit
 * checked against `size`. A file that shrank gives what it still holds.
 */
const readFileContent = async (handle: FileHandle, size: number): Promise<Uint8Array | null> => {
  // One byte more than `size`, so a file that grew fills it.
  const content = new Uint8Array(size + 1);
  let filled = 0;
  while (filled < content.length) {
    const { bytesRead } = await handle.read(content, filled, content.length - filled, filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return filled > size ? null : content.subarray(0, filled);
};

/** Closes `handle`. A failed close is ignored: the file was only read. */
const closeFile = (handle: FileHandle) => Effect.promise(() => handle.close().catch(() => {}));

/** Returns `absolutePath` with the user's home folder written `~`. */
const writeHomeAsTilde = (absolutePath: string): string => {
  const home = homedir();
  if (absolutePath === home) return "~";
  return absolutePath.startsWith(home + path.sep)
    ? `~${absolutePath.slice(home.length)}`
    : absolutePath;
};

/** Checks whether the real path `target` is `folder` itself or inside it. */
const isInsideFolder = (folder: string, target: string): boolean => {
  const relative = path.relative(folder, target);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
};

/**
 * Resolves the folder `given` to its real path, following a symbolic link.
 * Fails with `SkillFolderUnreadable`, naming the folder as `shown`, when it
 * does not exist or is not a folder.
 */
const openFolder = (given: string, shown: string) =>
  Effect.gen(function* () {
    const resolved = yield* tryFileCall(() => realpath(given), `\`${shown}\``);
    const info = yield* tryFileCall(() => stat(resolved), `\`${shown}\``);
    if (!info.isDirectory()) return yield* refuse(`\`${shown}\` is not a folder.`);
    return resolved;
  });

/** Checks whether `folder` holds a `SKILL.md` file. Any error reads as no. */
const holdsSkillFile = (folder: string): Effect.Effect<boolean> =>
  Effect.promise(() =>
    stat(path.join(folder, SKILL_FILE)).then(
      (info) => info.isFile(),
      () => false,
    ),
  );

/**
 * Resolves the symbolic link at `linkPath` to its real target. Fails with
 * `SkillFolderUnreadable`, naming the link as `shown`, when the target does
 * not exist or the link is part of a loop of links.
 */
const resolveLink = (linkPath: string, shown: string) =>
  Effect.tryPromise({
    try: () => realpath(linkPath),
    catch: (error) => {
      switch (readErrorCode(error)) {
        case "ELOOP":
          return new SkillFolderUnreadable({
            reason: `${shown} is part of a cycle of symbolic links. Remove the link from the skill's folder.`,
          });
        case "ENOENT":
          return new SkillFolderUnreadable({
            reason: `${shown} is a symbolic link to a file that does not exist. Remove the link, or copy the file it should point to into the skill's folder.`,
          });
        default:
          return describeReadFailure(shown, error);
      }
    },
  });

/** Fails with `SkillFolderUnreadable` for `shown`, a socket, a named pipe or a device. */
const refuseSpecialFile = (shown: string, entry: Dirent | Stats) =>
  refuse(
    `${shown} is ${describeFileKind(entry)}, not a file. A skill holds only files and folders; remove it from the skill's folder.`,
  );

/** Returns what `entry`, which is not a regular file, is: "a named pipe", "a folder" and so on. */
const describeFileKind = (entry: Dirent | Stats): string =>
  entry.isDirectory()
    ? "a folder"
    : entry.isSocket()
      ? "a socket"
      : entry.isFIFO()
        ? "a named pipe"
        : "a device or another special file";

/** Fails with `SkillFolderUnreadable` carrying `reason`. */
const refuse = (reason: string) => Effect.fail(new SkillFolderUnreadable({ reason }));

/**
 * Runs the file system call `call`. Fails with `SkillFolderUnreadable` naming
 * `shown` (already quoted) when the call rejects.
 */
const tryFileCall = <A>(call: () => Promise<A>, shown: string) =>
  Effect.tryPromise({ try: call, catch: (error) => describeReadFailure(shown, error) });

/** Builds the `SkillFolderUnreadable` for a failed read of `shown`. */
const describeReadFailure = (shown: string, error: unknown) =>
  new SkillFolderUnreadable({ reason: `${shown} cannot be read: ${describeFileError(error)}.` });

/** Returns a plain clause for a file system error, such as "it does not exist". */
const describeFileError = (error: unknown): string => {
  switch (readErrorCode(error)) {
    case "ENOENT":
      return "it does not exist";
    case "ENOTDIR":
      return "it is not a folder";
    case "EACCES":
    case "EPERM":
      return "permission was denied";
    default:
      return error instanceof Error ? error.message : String(error);
  }
};

/** Returns the `code` of a Node file system error, such as "ENOENT", or undefined. */
const readErrorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;

/** One skill's entry in the `skills` tool's lock file. Other fields are ignored. */
const SkillLockEntry = Schema.Struct({
  source: Schema.optionalKey(Schema.String),
  sourceType: Schema.optionalKey(Schema.String),
  skillPath: Schema.optionalKey(Schema.String),
});

/** The lock file the `skills` tool keeps beside its skills folder. */
const SkillLock = Schema.Struct({
  skills: Schema.Record(Schema.String, SkillLockEntry),
});

/** The GitHub sources a lock file gives, by skill name, or why it was ignored. */
interface SkillLockReading {
  readonly sources: ReadonlyMap<string, LockedSkillSource>;
  readonly problem: string | null;
}

/**
 * Reads the nearest `.skill-lock.json`: in `folder`, in its parent, or in its
 * parent's parent. Returns the GitHub source of every entry whose `sourceType`
 * is `github`. Never fails: a lock file that cannot be read or parsed gives no
 * sources and a one-line `problem` naming it. No lock file gives neither.
 */
const readNearestSkillLock = (folder: string): Effect.Effect<SkillLockReading> =>
  Effect.gen(function* () {
    const parent = path.dirname(folder);
    // A Set, because the parent of the root folder is the root folder again.
    const candidates = new Set([folder, parent, path.dirname(parent)]);
    for (const candidate of candidates) {
      const file = path.join(candidate, SKILL_LOCK_FILE);
      const ignored = (why: string): SkillLockReading => ({
        sources: new Map(),
        problem: `Ignored \`${writeHomeAsTilde(file)}\` because ${why}, so no skill gets a GitHub source from it.`,
      });

      const read = yield* Effect.promise(() => readSkillLockText(file));
      if (read === null) continue;
      if ("why" in read) return ignored(read.why);

      const json = yield* Effect.try(() => JSON.parse(read.text) as unknown).pipe(Effect.option);
      if (json._tag === "None") return ignored("it is not valid JSON");
      const lock = Schema.decodeUnknownOption(SkillLock)(json.value);
      if (lock._tag === "None")
        return ignored("it does not hold a `skills` list in the expected shape");

      const sources = new Map<string, LockedSkillSource>();
      const refused: Array<string> = [];
      for (const [name, entry] of Object.entries(lock.value.skills)) {
        if (entry.sourceType !== "github" || !entry.source || !entry.skillPath) continue;
        const skillFolder = path.posix.dirname(entry.skillPath);
        // A skill at the root of its repository has `SKILL.md` as its path.
        const source = { repo: entry.source, path: skillFolder === "." ? "" : skillFolder };
        // An entry the controller would refuse must not stop the whole import,
        // so its skill gets an upload source and the summary names it.
        if (Schema.is(SkillImportInput)({ name, sourceRepo: source.repo, sourcePath: source.path }))
          sources.set(name, source);
        else refused.push(`\`${name}\``);
      }
      return {
        sources,
        problem:
          refused.length === 0
            ? null
            : `Ignored the entries for ${refused.join(", ")} in \`${writeHomeAsTilde(file)}\` because their GitHub source is not a repository and folder Hercule accepts, so those skills get no GitHub source.`,
      };
    }
    return { sources: new Map(), problem: null };
  });

/**
 * Reads the lock file `file` as text. Returns null when there is none, and
 * otherwise its text or why it was not read: it is not a regular file, it is
 * over `MAX_SKILL_LOCK_BYTES`, or it cannot be read. Never rejects.
 *
 * The type and size come from the open handle, so a named pipe cannot make
 * the reader wait and a huge file is never read.
 */
const readSkillLockText = async (
  file: string,
): Promise<{ readonly text: string } | { readonly why: string } | null> => {
  let handle: FileHandle;
  try {
    // Unlike a skill's files, a lock file may be a link, as a dotfiles
    // manager makes them: it gives only sources, never content.
    handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    const code = readErrorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    return { why: `it cannot be read: ${describeFileError(error)}` };
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return { why: `it is ${describeFileKind(info)}, not a file` };
    if (info.size > MAX_SKILL_LOCK_BYTES) {
      return {
        why: `it is over ${formatBytes(MAX_SKILL_LOCK_BYTES)}, far larger than a lock file the \`skills\` tool writes`,
      };
    }
    const content = await readFileContent(handle, info.size);
    return content === null
      ? { why: "it grew while it was read" }
      : { text: new TextDecoder().decode(content) };
  } catch (error) {
    return { why: `it cannot be read: ${describeFileError(error)}` };
  } finally {
    await handle.close().catch(() => {});
  }
};
