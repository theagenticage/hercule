/**
 * `hercule antigravity-pre-tool-hook`: the pre-tool hook of an `agy` session
 * (spec 06 section 8.1). The hooks file in the Harness Home runs it before
 * every `run_command`, `edit_file`, `write_file` and `search_web`, and the
 * tool waits for it. `agy` writes the call as one JSON document on stdin; the
 * hook prints a denial as JSON, or nothing to let the call run. It always
 * exits 0.
 *
 * It does two things, in this order:
 * 1. It writes the edit-watch mark of the call (spec 19 section 4.1) into the
 *    session's marks directory, for the three tools that start work. The mark
 *    is best effort and never blocks a call.
 * 2. It collects facts from the environment and the filesystem and passes
 *    them to `decidePreToolHook`, which decides.
 *
 * This runs at every tool call, so startup time counts. The compiled binary
 * starts this file without the dispatcher, so keep its imports to Node
 * built-ins, `effect/Schema` and the small modules below. `pnpm dep-lint`
 * checks this.
 *
 * The input is decoded from its top-level fields only (`cwd`, `toolCall.id`,
 * `toolCall.name`, `toolCall.args`). The text of a command or a file is never
 * searched, so a model cannot plant a field in it.
 */
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readlinkSync,
  readSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import * as Schema from "effect/Schema";
import { SESSION_MARKS_DIR_VARIABLE, formatStartMark } from "../../edit-marks/mark-format";
import {
  CONFIG_FOLDER_NAMES,
  DENY_WEB_SEARCH_VARIABLE,
  EDIT_TOOL_NAMES,
  GUARDED_CONFIG_FILES,
  GUARD_VARIABLE,
  PLUGINS_FOLDER_NAME,
  SHELL_TOOL_NAME,
  READ_ONLY_FOLDERS_VARIABLE,
  decideAfterHookFailure,
  decidePreToolHook,
} from "./pre-tool-hook-policy";
import type {
  DecodedToolCall,
  EditTarget,
  GuardedPlace,
  GuardedPlacesFailure,
  HookDenial,
} from "./pre-tool-hook-policy";

/** The most input the hook reads. A call larger than this counts as unreadable. */
const MAX_INPUT_BYTES = 1024 * 1024;

/** The most folders the hook walks up from the session's folder looking for the git root. A longer walk makes it deny edits. */
const MAX_WALK_DEPTH = 64;

/** The most links the hook follows while it resolves one path, so a loop of links ends. */
const MAX_LINKS = 40;

/** The largest `plugins.json` the hook reads. A larger file makes it deny edits. */
const MAX_PLUGINS_FILE_BYTES = 64 * 1024;

/** The tools whose calls get an edit-watch mark. */
const MARKED_TOOL_NAMES: ReadonlyArray<string> = [SHELL_TOOL_NAME, ...EDIT_TOOL_NAMES];

/** An id that is safe to use as a file name. Any other id gets no mark. */
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

const HookInput = Schema.Struct({
  cwd: Schema.String,
  toolCall: Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    args: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  }),
});

const decodeHookInput = Schema.decodeUnknownOption(HookInput);

const PluginsFile = Schema.Struct({ entries: Schema.optionalKey(Schema.Array(Schema.Unknown)) });
const decodePluginsFile = Schema.decodeUnknownOption(PluginsFile);
const decodePluginsEntry = Schema.decodeUnknownOption(Schema.Struct({ path: Schema.String }));

/** The call as the hook decoded it, with the fields the mark and the guard need. */
interface HookCall extends DecodedToolCall {
  readonly cwd: string;
  readonly id: string;
}

/** Returns the decoded call, or undefined when `input` is missing, is not JSON, or lacks a top-level field. */
const decodeCall = (input: string | undefined): HookCall | undefined => {
  if (input === undefined) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(input);
  } catch {
    return undefined;
  }
  const decoded = decodeHookInput(json);
  if (decoded._tag === "None") return undefined;
  const { cwd, toolCall } = decoded.value;
  return { cwd, id: toolCall.id, name: toolCall.name, args: toolCall.args ?? {} };
};

/**
 * Writes the mark of the call into `marksDir`: the call's id as the file name,
 * and for a shell command its text. Never overwrites a mark. Does nothing for
 * an id that is not safe in a file name, and ignores any failure, because the
 * edit watch is best effort.
 */
const writeMark = (marksDir: string, call: HookCall): void => {
  if (!SAFE_ID.test(call.id)) return;
  const command = call.args["CommandLine"];
  const content =
    call.name === SHELL_TOOL_NAME && typeof command === "string" && command !== ""
      ? formatStartMark(call.id, command)
      : formatStartMark(call.id);
  try {
    writeFileSync(join(marksDir, call.id), content, { flag: "wx" });
  } catch {
    // Best effort: the call runs without a mark.
  }
};

/** Returns the device and inode of `path` as one text, following links, or undefined when it does not exist. */
const readIdentity = (path: string): string | undefined => {
  try {
    const stats = statSync(path, { bigint: true });
    return `${stats.dev}:${stats.ino}`;
  } catch {
    return undefined;
  }
};

/**
 * Returns the absolute path `path` as the operating system resolves it: the
 * longest part that exists is resolved with `realpath`, and the rest is
 * appended as written. `path` may hold `..`, which the operating system
 * applies after it has followed the links before it, so a path that was
 * already cleaned of `..` as text gives another answer. A link that points nowhere is followed to its target,
 * because a write through it creates the target.
 */
const resolveLikeOperatingSystem = (path: string): string => {
  let head = path;
  let rest: ReadonlyArray<string> = [];
  let links = 0;
  for (;;) {
    try {
      return join(realpathSync.native(head), ...rest);
    } catch {
      // head does not resolve: it is missing, a loop, or a link to nowhere.
    }
    let target: string | undefined;
    try {
      if (links < MAX_LINKS && lstatSync(head).isSymbolicLink()) {
        links += 1;
        target = readlinkSync(head);
      }
    } catch {
      // Not a link, or gone since the check: handled as missing below.
    }
    if (target !== undefined) {
      head = resolve(dirname(head), target);
      continue;
    }
    const parent = dirname(head);
    if (parent === head) return join(head, ...rest);
    rest = [basename(head), ...rest];
    head = parent;
  }
};

/** Thrown while listing the guarded places, when the cause is one the model can be told about. */
class GuardedPlacesError extends Error {
  readonly failure: GuardedPlacesFailure;

  constructor(failure: GuardedPlacesFailure) {
    super(failure.kind === "manifest" ? failure.file : "walk");
    this.failure = failure;
  }
}

/** Reads where an edit tool writes, with the identities of the existing part of the path and every folder above it. */
const buildEditTarget = (cwd: string, path: string): EditTarget => {
  const lexicalPath = resolve(cwd, path);
  // Not `join`: it would clean `..` as text first.
  const resolvedPath = resolveLikeOperatingSystem(isAbsolute(path) ? path : `${cwd}/${path}`);
  const existingIdentities: Array<string> = [];
  for (let at = resolvedPath; ; at = dirname(at)) {
    const identity = readIdentity(at);
    if (identity !== undefined) existingIdentities.push(identity);
    if (dirname(at) === at) break;
  }
  return { lexicalPath, resolvedPath, existingIdentities };
};

/** Builds the guarded place at `path`, an absolute path. */
const buildPlace = (path: string, isFolder: boolean): GuardedPlace => {
  const lexicalPath = resolve(path);
  return {
    isFolder,
    lexicalPath,
    resolvedPath: resolveLikeOperatingSystem(lexicalPath),
    identity: readIdentity(lexicalPath),
  };
};

/**
 * Returns the folders `agy` reads configuration from for a session in `cwd`:
 * the folder itself and every folder above it up to the nearest one holding
 * `.git`. Without a git root, only the session's folder. Throws when the walk
 * reaches `MAX_WALK_DEPTH` folders before it finds a git root or the top,
 * because `agy` walks without a limit, so the guard cannot say which folders
 * it reads. The error is a `GuardedPlacesError`.
 */
const listConfigRoots = (cwd: string): ReadonlyArray<string> => {
  const start = resolveLikeOperatingSystem(resolve(cwd));
  const roots: Array<string> = [];
  for (let at = start; ; at = dirname(at)) {
    roots.push(at);
    if (existsSync(join(at, ".git"))) return roots;
    if (dirname(at) === at) return [start];
    if (roots.length >= MAX_WALK_DEPTH) {
      throw new GuardedPlacesError({ kind: "walk", limit: MAX_WALK_DEPTH });
    }
  }
};

/**
 * Returns the folders listed in the `plugins.json` at `file`, as absolute
 * paths (a relative one is relative to `root`, the folder that holds the
 * configuration folder). A file that does not exist lists none. Throws when
 * the file exists and cannot be checked (not a regular file, too large,
 * unreadable, not JSON of the expected shape), because `agy` may read it and
 * load the folders it lists. The file is opened without blocking, so a named
 * pipe in its place cannot hang the hook.
 */
const readPluginFolders = (file: string, root: string): ReadonlyArray<string> => {
  let descriptor: number;
  try {
    descriptor = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw error;
  }
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isFile() || stats.size > MAX_PLUGINS_FILE_BYTES) {
      throw new Error(
        `${file} is not a regular file of at most ${String(MAX_PLUGINS_FILE_BYTES)} bytes.`,
      );
    }
    const buffer = Buffer.alloc(stats.size);
    readSync(descriptor, buffer, 0, buffer.length, 0);
    const decoded = decodePluginsFile(JSON.parse(buffer.toString("utf8")));
    if (decoded._tag === "None") throw new Error(`${file} does not list entries.`);
    return (decoded.value.entries ?? []).flatMap((entry) => {
      const path = decodePluginsEntry(entry);
      return path._tag === "Some" ? [resolve(root, path.value.path)] : [];
    });
  } finally {
    closeSync(descriptor);
  }
};

/**
 * Parses the JSON array of folder paths in `READ_ONLY_FOLDERS_VARIABLE`. An
 * unset or empty value lists none. Throws when the value is not an array of
 * strings, so that the hook denies the edit instead of guarding fewer folders.
 */
const parseReadOnlyFolders = (value: string | undefined): ReadonlyArray<string> => {
  if (!value) return [];
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
    throw new Error(`${READ_ONLY_FOLDERS_VARIABLE} is not a JSON array of paths.`);
  }
  return parsed;
};

/** Returns every place the agent may not change in a session in `cwd` (spec 06 section 8.1). */
const buildGuardedPlaces = (
  cwd: string,
  readOnlyFolders: ReadonlyArray<string>,
): ReadonlyArray<GuardedPlace> => {
  const places: Array<GuardedPlace> = [];
  for (const root of listConfigRoots(cwd)) {
    for (const name of CONFIG_FOLDER_NAMES) {
      const folder = join(root, name);
      for (const file of GUARDED_CONFIG_FILES) places.push(buildPlace(join(folder, file), false));
      places.push(buildPlace(join(folder, PLUGINS_FOLDER_NAME), true));
      const manifest = join(folder, "plugins.json");
      let listed: ReadonlyArray<string>;
      try {
        listed = readPluginFolders(manifest, root);
      } catch {
        throw new GuardedPlacesError({ kind: "manifest", file: manifest });
      }
      for (const plugins of listed) places.push(buildPlace(plugins, true));
    }
  }
  for (const folder of readOnlyFolders) places.push(buildPlace(folder, true));
  return places;
};

/**
 * Returns the text the hook prints for the tool call in `input`: one line of
 * JSON for a denial, or an empty string to let the call run. Writes the
 * edit-watch mark as a side effect. `input` is undefined when stdin could not
 * be read in full.
 */
export const answerPreToolCall = (
  input: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): string => {
  const guardIsOn = !!env[GUARD_VARIABLE];
  const deniesWebSearch = !!env[DENY_WEB_SEARCH_VARIABLE];
  try {
    const call = decodeCall(input);
    const marksDir = env[SESSION_MARKS_DIR_VARIABLE];
    if (call !== undefined && marksDir && MARKED_TOOL_NAMES.includes(call.name)) {
      writeMark(marksDir, call);
    }
    const path = call?.args["Path"];
    let editTarget: EditTarget | undefined;
    let guardedPlaces: ReadonlyArray<GuardedPlace> = [];
    let guardedPlacesFailure: GuardedPlacesFailure | undefined;
    if (call !== undefined && guardIsOn && EDIT_TOOL_NAMES.includes(call.name)) {
      try {
        if (typeof path === "string") {
          const target = buildEditTarget(call.cwd, path);
          const places = buildGuardedPlaces(
            call.cwd,
            parseReadOnlyFolders(env[READ_ONLY_FOLDERS_VARIABLE]),
          );
          editTarget = target;
          guardedPlaces = places;
        }
      } catch (error) {
        // With no target the policy denies a call it cannot place. A failure
        // it can name is passed on, so the denial says what to fix.
        if (error instanceof GuardedPlacesError) guardedPlacesFailure = error.failure;
      }
    }
    return formatAnswer(
      decidePreToolHook({
        guardIsOn,
        deniesWebSearch,
        call,
        editTarget,
        guardedPlaces,
        guardedPlacesFailure,
      }),
    );
  } catch {
    // `agy` stops the tool when the hook fails, so any unexpected error still
    // ends in a valid answer.
    return formatAnswer(decideAfterHookFailure({ guardIsOn, deniesWebSearch }));
  }
};

/** Returns the text the hook prints for `denial`: one line of JSON, or nothing to let the call run. */
const formatAnswer = (denial: HookDenial | undefined): string =>
  denial === undefined ? "" : `${JSON.stringify(denial)}\n`;

/**
 * Reads all of stdin, or returns undefined when it holds more than
 * `MAX_INPUT_BYTES`, which counts as unreadable.
 */
const readBoundedStdin = async (): Promise<string | undefined> => {
  const chunks: Array<Buffer> = [];
  let size = 0;
  for await (const chunk of process.stdin as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_INPUT_BYTES) return undefined;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
};

/**
 * Runs the hook: reads the call from stdin, prints the answer on stdout, and
 * exits 0. It never throws: a stdin that cannot be read counts as unreadable
 * input, which `answerPreToolCall` answers like any other.
 */
export const runPreToolHook = async (): Promise<void> => {
  const input = await readBoundedStdin().catch(() => undefined);
  process.stdout.write(answerPreToolCall(input, process.env));
};
