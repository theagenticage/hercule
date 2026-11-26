/**
 * `hercule antigravity-pre-tool-hook`: the pre-tool hook of an `agy` session
 * (spec 06 section 8.1). The hooks file in the Harness Home runs it before
 * every `run_command`, `edit_file`, `write_file`, `search_web`,
 * `invoke_subagent` and chrome-devtools call, and the tool waits for it. `agy` writes the call as one JSON document on stdin; the
 * hook prints a denial as JSON, or nothing to let the call run. It always
 * exits 0.
 *
 * The adapter and the hook share this file. The adapter writes the hooks file
 * (`buildHooksFile`) and the session's rules (`encodeHookRules`); the hook
 * reads the rules from `HOOK_RULES_VARIABLE` and decides what each Access
 * Mode denies:
 * - Full access: nothing.
 * - Approval required: web search, the browser agent, and every change to a
 *   guarded place.
 * - Auto-accept edits: the browser agent, and every change to a guarded place.
 * A rules value that is missing or does not decode is Hercule's own setup
 * being wrong, so the hook denies every edit, every web search and every
 * browser call, and says so.
 *
 * One call goes through one straight line: read the rules, decode the call,
 * take the edit-watch mark (spec 19 section 4.1), then decide. The mark is
 * best effort and its errors never reach the decision.
 *
 * This runs at every tool call, so startup time counts. The compiled binary
 * starts this file without the dispatcher, so keep its imports to Node
 * built-ins and the mark format, and not `effect`. `pnpm dep-lint` checks this.
 *
 * The input is decoded from its top-level fields only (`cwd`, `toolCall.id`,
 * `toolCall.name`, `toolCall.args`). The text of a command or a file is never
 * searched, so a model cannot plant a field in it.
 *
 * Known limits, recorded in spec 06 section 8.1:
 * - The check and `agy`'s write are two steps. A path swapped between them
 *   (a link put in place by a concurrent process of the same user) is not
 *   prevented.
 * - The tool and folder names below are the ones measured on `agy` 1.5.15. A
 *   tool or a folder name a later `agy` adds is not covered until they are
 *   measured again.
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
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SESSION_MARKS_DIR_VARIABLE, formatStartMark } from "../../edit-marks/mark-format";

/** The verb of the `hercule` binary that runs this hook. */
export const PRE_TOOL_HOOK_VERB = "antigravity-pre-tool-hook";

/** Holds the session's rules (`HookRules`) as JSON, on the `agy` process of every session and probe. */
export const HOOK_RULES_VARIABLE = "HERCULE_AGY_HOOK_RULES";

/** How much the session may do without asking: the Access Modes `agy` has a setting for. */
const ACCESS_MODES = ["approval-required", "auto-accept-edits", "full-access"] as const;

/**
 * What the hook needs to know about one session. The adapter writes it into
 * `HOOK_RULES_VARIABLE` (`encodeHookRules`), and the hook reads it back
 * (`decodeHookRules`).
 */
export interface HookRules {
  /** How much the session may do without asking. Decides what the hook denies. */
  readonly accessMode: (typeof ACCESS_MODES)[number];
  /** Absolute paths of the folders Hercule gives the agent to read and never to change. */
  readonly readOnlyFolders: ReadonlyArray<string>;
  /** Absolute paths of the files and folders Hercule owns in the Harness Home. */
  readonly harnessHomePaths: ReadonlyArray<string>;
}

/** Returns whether `value` is an object that is not an array, so its fields can be read. */
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Returns whether `value` is an array of text. */
const isStringArray = (value: unknown): value is ReadonlyArray<string> =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

/** Returns the value for `HOOK_RULES_VARIABLE`: `rules` as JSON. */
export const encodeHookRules = (rules: HookRules): string => JSON.stringify(rules);

/**
 * Returns the rules in `text`, or undefined when `text` is not JSON of the
 * shape of `HookRules`. This file reads its input with plain checks instead
 * of `effect/Schema`, which costs about 8 ms of start time at every tool call.
 */
export const decodeHookRules = (text: string): HookRules | undefined => {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (
    !isRecord(json) ||
    !ACCESS_MODES.some((mode) => mode === json["accessMode"]) ||
    !isStringArray(json["readOnlyFolders"]) ||
    !isStringArray(json["harnessHomePaths"])
  ) {
    return undefined;
  }
  return json as unknown as HookRules;
};

/**
 * What the hook does with each tool it runs for. The one table the hooks
 * file's matcher, the marks and the decision all read.
 * - `shell`: runs a command. Marked, and never denied: `agy` asks about it.
 * - `edit`: changes the file at `Path`. Marked, and denied in a guarded place.
 * - `search`: searches the web. Not marked.
 * - `subagent`: starts a subagent. Not marked. Denied only for the browser
 *   agent (`TypeName` "browser"); every other subagent runs.
 * - `browser`: a chrome-devtools call, matched by `BROWSER_TOOL_PREFIX`. Not
 *   marked, and denied outside Full access.
 */
type ToolKind = "shell" | "edit" | "search" | "subagent" | "browser";

const TOOLS: ReadonlyMap<string, ToolKind> = new Map([
  ["run_command", "shell"],
  ["edit_file", "edit"],
  ["write_file", "edit"],
  ["search_web", "search"],
  ["invoke_subagent", "subagent"],
]);

/**
 * The start of the name of every tool of the chrome-devtools MCP server, which
 * the browser agent drives. Measured on `agy` 1.5.15: `mcp_chrome_devtools_list_pages`.
 */
const BROWSER_TOOL_PREFIX = "mcp_chrome_devtools_";

/** Returns the kind of the tool `name`, or undefined for a tool the hook does not know. */
const classifyTool = (name: string): ToolKind | undefined =>
  name.startsWith(BROWSER_TOOL_PREFIX) ? "browser" : TOOLS.get(name);

/** The tools the hooks file runs the hook for, as the regular expression `agy` matches tool names against. */
const HOOK_MATCHER = [...TOOLS.keys(), `${BROWSER_TOOL_PREFIX}.*`].join("|");

/**
 * Returns the hooks file of the Harness Home: one `PreToolUse` hook, for the
 * tools in the table above, that runs the hook with the verb after `launcher`.
 * `launcher` is the shell command that starts the `hercule` binary (each of
 * its words already quoted), because `agy` runs the hook through a shell.
 */
export const buildHooksFile = (launcher: string): string =>
  JSON.stringify({
    hercule: {
      PreToolUse: [
        {
          matcher: HOOK_MATCHER,
          hooks: [{ type: "command", command: `${launcher} ${PRE_TOOL_HOOK_VERB}` }],
        },
      ],
    },
  });

/**
 * The names of the folders `agy` reads configuration from, in the session's
 * folder and every folder above it. Measured on `agy` 1.5.15: all four load a
 * `hooks.json` (which can auto-approve a command) and start the servers of an
 * `mcp_config.json`. Only those two files were measured under the names other
 * than `.agents`. Guarding the other files and the plugins folder under every
 * name is the safe superset.
 */
const CONFIG_FOLDER_NAMES: ReadonlyArray<string> = [".agents", ".agent", "_agents", "_agent"];

/**
 * The files in a configuration folder that `agy` loads approval rules or
 * programs from. `agents.json` and `rules.json` come from `agy`'s docs and
 * were never measured.
 */
const GUARDED_CONFIG_FILES: ReadonlyArray<string> = [
  "hooks.json",
  "plugins.json",
  "mcp_config.json",
  "agents.json",
  "rules.json",
];

/** The folder in a configuration folder that holds plugins. Everything below it is guarded. */
const PLUGINS_FOLDER_NAME = "plugins";

/** The most input the hook reads. A call larger than this cannot be checked. */
const MAX_INPUT_BYTES = 1024 * 1024;

/** The most folders the hook walks up from the session's folder looking for the git root. A longer walk makes it deny edits. */
const MAX_WALK_DEPTH = 64;

/** The most links the hook follows while it resolves one path, so a loop of links ends. */
const MAX_LINKS = 40;

/** The largest `plugins.json` the hook reads. A larger file makes it deny edits. */
const MAX_PLUGINS_FILE_BYTES = 64 * 1024;

/** An id that is safe to use as a file name. Any other id gets no mark. */
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

/** A `plugins.json` as the hook reads it. An entry of another shape makes the file unreadable. */
const isPluginsFile = (
  value: unknown,
): value is { readonly entries?: ReadonlyArray<{ readonly path: string }> } =>
  isRecord(value) &&
  (value["entries"] === undefined ||
    (Array.isArray(value["entries"]) &&
      value["entries"].every((entry) => isRecord(entry) && typeof entry["path"] === "string")));

/** What the hook prints to deny a tool call. A call it allows gets no output. */
interface HookDenial {
  readonly decision: "deny";
  readonly reason: string;
}

const deny = (reason: string): HookDenial => ({ decision: "deny", reason });

/** The call as the hook decoded it. `args` holds what `agy` passed to the tool. */
interface DecodedCall {
  readonly cwd: string;
  readonly id: string;
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
}

/** Stands for an input of more than `MAX_INPUT_BYTES`. */
export const INPUT_TOO_LARGE: unique symbol = Symbol("input too large");

/** What `agy` wrote on stdin: its text, undefined when it could not be read, or `INPUT_TOO_LARGE`. */
type RawInput = string | undefined | typeof INPUT_TOO_LARGE;

const UNREADABLE_REASON =
  "Hercule could not read this tool call, so it cannot check it. Ask the user, or switch the thread to Full access.";

const TOO_LARGE_REASON =
  "This tool call is too large for Hercule to check, so it cannot allow it. Ask the user, or switch the thread to Full access.";

const BAD_RULES_REASON =
  "Hercule's own setup for this session is wrong (its rules for the hook are missing or unreadable), so it cannot check this tool call. Ask the user, or switch the thread to Full access.";

const CHECK_FAILED_REASON =
  "Hercule's check of this tool call failed, so it cannot allow it. Ask the user, or switch the thread to Full access.";

/** Returns the reason for a browser call denied in `mode`, spelled as the app spells it. */
const buildBrowserReason = (mode: "approval-required" | "auto-accept-edits"): string =>
  `The browser agent is off in ${mode === "approval-required" ? "Approval required" : "Auto-accept edits"}: it acts in your own Chrome, with your logins, and Hercule cannot ask you first. Switch the thread to Full access to use it.`;

const WEB_SEARCH_REASON =
  "Web search is off in Approval required, because a search runs without a card. Ask the user, or switch the thread to another access mode.";

/** Returns the reason for an edit denied because the guarded places could not be listed. */
const buildPlacesFailureReason = (failure: GuardedPlacesFailure): string =>
  failure.kind === "manifest"
    ? `Hercule could not check ${failure.file}, which lists plugin folders, so it cannot tell which files the agent may not change. Repair or remove the file, or ask the user, or switch the thread to Full access.`
    : `This folder is more than ${String(failure.limit)} folders below the top of the file system and no git root is above it, so Hercule cannot tell which configuration folders the agent reads and cannot check the change. Work in a less deep folder, or ask the user, or switch the thread to Full access.`;

/** Returns the reason for a change to `path`, which is in `place`. */
const buildGuardReason = (path: string, place: GuardedPlace): string => {
  if (place.isReadOnlyFolder) {
    return `Hercule gives the agent this folder to read, not to change: ${path}. Ask the user to change it.`;
  }
  if (place.listedIn !== undefined) {
    return `Hercule does not let the agent change ${path}: ${place.listedIn} lists a plugin folder that holds it, and plugins can approve what the agent does without asking. Ask the user to change it.`;
  }
  return `Hercule does not let the agent change ${path}: it decides what the agent may do without asking. Ask the user to change it.`;
};

/** Returns the decoded call, or undefined when `input` is missing, is not JSON, or lacks a top-level field. */
const decodeCall = (input: RawInput): DecodedCall | undefined => {
  if (input === undefined || input === INPUT_TOO_LARGE) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(input);
  } catch {
    return undefined;
  }
  if (!isRecord(json) || typeof json["cwd"] !== "string" || !isRecord(json["toolCall"])) {
    return undefined;
  }
  const { id, name, args } = json["toolCall"];
  if (typeof id !== "string" || typeof name !== "string") return undefined;
  if (args !== undefined && !isRecord(args)) return undefined;
  return { cwd: json["cwd"], id, name, args: args ?? {} };
};

/**
 * Writes the edit-watch mark of the call into the directory named by
 * `SESSION_MARKS_DIR_VARIABLE`, for the tools that start work. The file name
 * is the call's id, and for a shell command the file holds its text. Never
 * overwrites a mark. Does nothing without the variable or for an id that is
 * not safe in a file name, and ignores every failure, because the edit watch
 * is best effort.
 *
 * It runs for every call, before the decision, including a call the hook then
 * denies. A failed item can still have an attribution window (spec 19 section
 * 4.1 forgets only the windows of declined items), and a mark taken early
 * bounds that window. Without a mark the observer would not know where the
 * window starts.
 */
const takeMark = (call: DecodedCall, env: Readonly<Record<string, string | undefined>>): void => {
  try {
    const marksDir = env[SESSION_MARKS_DIR_VARIABLE];
    const kind = classifyTool(call.name);
    if (!marksDir || (kind !== "shell" && kind !== "edit") || !SAFE_ID.test(call.id)) {
      return;
    }
    const command = call.args["CommandLine"];
    const content =
      kind === "shell" && typeof command === "string" && command !== ""
        ? formatStartMark(call.id, command)
        : formatStartMark(call.id);
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
 * already cleaned of `..` as text gives another answer. A link that points
 * nowhere is followed to its target, because a write through it creates the
 * target.
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

/**
 * Why the hook could not list the places it guards for a call it did read:
 * - `manifest`: a `plugins.json` exists at `file` and could not be checked.
 * - `walk`: the folders above the session's folder reached `limit` before a
 *   git root or the top of the file system.
 */
type GuardedPlacesFailure =
  | { readonly kind: "manifest"; readonly file: string }
  | { readonly kind: "walk"; readonly limit: number };

/** Thrown while listing the guarded places, when the cause is one the model can be told about. */
class GuardedPlacesError extends Error {
  readonly failure: GuardedPlacesFailure;

  constructor(failure: GuardedPlacesFailure) {
    super(failure.kind === "manifest" ? failure.file : "walk");
    this.failure = failure;
  }
}

/**
 * Where an edit tool writes. `paths` holds every reading of the path: the
 * text reading (relative to the session's folder, `..` collapsed) and the
 * operating system's reading (links resolved), for each spelling the path may
 * have (as written, with `~` expanded, as a `file://` URL). `identities` holds
 * the file identities (device and inode) of the longest existing part of each
 * resolved path and of every folder above it.
 */
interface EditTarget {
  readonly paths: ReadonlyArray<string>;
  readonly identities: ReadonlyArray<string>;
}

/**
 * A place the agent may not change: a file, or a folder with everything below
 * it. `paths` holds the text reading and the operating system's reading.
 * `identity` is its file identity when it exists, which stays equal when a
 * filesystem spells it differently. `isReadOnlyFolder` is true for a folder
 * Hercule gives the agent to read, which has its own reason for a denial.
 * `listedIn` is the `plugins.json` that lists the folder, for a folder that
 * is guarded only because a `plugins.json` lists it; it has its own reason
 * too, because the folder may be the session's own (an entry `.`).
 */
interface GuardedPlace {
  readonly isFolder: boolean;
  readonly isReadOnlyFolder: boolean;
  readonly listedIn: string | undefined;
  readonly paths: ReadonlyArray<string>;
  readonly identity: string | undefined;
}

/**
 * Returns the other spellings of `path` that `agy` may read as a path: with a
 * leading `~` replaced by the home folder, and a `file:` URL as the path it
 * names (the scheme in any case, with or without `//`). Whether `agy` expands
 * either is not measured, so both are guarded.
 */
const listOtherSpellings = (path: string, home: string): ReadonlyArray<string> => {
  const spellings: Array<string> = [];
  if (path === "~" || path.startsWith("~/")) spellings.push(join(home, path.slice(1)));
  if (/^file:/i.test(path)) {
    try {
      spellings.push(fileURLToPath(path));
    } catch {
      // A URL that names no path on this machine is only guarded as written.
    }
  }
  return spellings;
};

/**
 * The whitespace at the start or end of a text that Go's `strings.TrimSpace`
 * removes (`agy` is written in Go): `\t`, `\n`, `\v`, `\f`, `\r`, space,
 * U+0085, U+00A0 and the Unicode White_Space characters. JavaScript's `trim`
 * differs: it keeps U+0085.
 */
const GO_SPACE_AT_ENDS =
  /^[\t\n\v\f\r \u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+|[\t\n\v\f\r \u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+$/g;

/** Reads where an edit tool writes, with the identities of the existing part of the path and every folder above it. */
const buildEditTarget = (cwd: string, path: string, home: string): EditTarget => {
  const paths: Array<string> = [];
  const identities: Array<string> = [];
  // `agy` may trim the `Path` before it writes (not measured), so the trimmed
  // reading is compared too. Over-denying a path that ends in whitespace is harmless.
  const trimmed = path.replace(GO_SPACE_AT_ENDS, "");
  const readings = trimmed === path ? [path] : [path, trimmed];
  for (const spelling of readings.flatMap((reading) => [
    reading,
    ...listOtherSpellings(reading, home),
  ])) {
    paths.push(resolve(cwd, spelling));
    // Not `join`: it would clean `..` as text first.
    const resolved = resolveLikeOperatingSystem(
      isAbsolute(spelling) ? spelling : `${cwd}/${spelling}`,
    );
    paths.push(resolved);
    for (let at = resolved; ; at = dirname(at)) {
      const identity = readIdentity(at);
      if (identity !== undefined) identities.push(identity);
      if (dirname(at) === at) break;
    }
  }
  return { paths, identities };
};

/** Builds the guarded place at `path`, an absolute path. */
const buildPlace = (
  path: string,
  isFolder: boolean,
  { isReadOnlyFolder = false, listedIn }: { isReadOnlyFolder?: boolean; listedIn?: string } = {},
): GuardedPlace => {
  const lexicalPath = resolve(path);
  return {
    isFolder,
    isReadOnlyFolder,
    listedIn,
    paths: [lexicalPath, resolveLikeOperatingSystem(lexicalPath)],
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
 * unreadable, not JSON of the expected shape, an entry without a text
 * `path`), because `agy` may read it and load the folders it lists. The file
 * is opened without blocking, so a named pipe in its place cannot hang the
 * hook.
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
    const manifest: unknown = JSON.parse(buffer.toString("utf8"));
    if (!isPluginsFile(manifest)) throw new Error(`${file} does not list entries.`);
    return (manifest.entries ?? []).map((entry) => resolve(root, entry.path));
  } finally {
    closeSync(descriptor);
  }
};

/** Returns every place the agent may not change in a session in `cwd` (spec 06 section 8.1). */
const buildGuardedPlaces = (cwd: string, rules: HookRules): ReadonlyArray<GuardedPlace> => {
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
      for (const plugins of listed) places.push(buildPlace(plugins, true, { listedIn: manifest }));
    }
  }
  for (const path of rules.harnessHomePaths) places.push(buildPlace(path, true));
  for (const folder of rules.readOnlyFolders)
    places.push(buildPlace(folder, true, { isReadOnlyFolder: true }));
  return places;
};

/**
 * The characters an HFS+ volume ignores when it compares names, so
 * `hooks\u200C.json` opens `hooks.json` there: U+200C to U+200F, U+202A to
 * U+202E, U+206A to U+206F and U+FEFF. They are the ignorable code points of
 * HFS+ case-insensitive name comparison. Apple's TN1150 (HFS Plus Volume
 * Format) says such characters are skipped in that comparison, but does not
 * print the table. It points to Apple's comparison code, a separate download,
 * which holds the list.
 */
const HFS_IGNORED_CHARACTERS = /[\u200C-\u200F\u202A-\u202E\u206A-\u206F\uFEFF]/g;

/**
 * Returns `path` in a form that is equal for every spelling a filesystem may
 * treat as the same name: Unicode case-insensitive (upper then lower case, so
 * `ß` and `ı` fold too), in one normalization form, and without the
 * characters an HFS+ volume ignores. A file that does not exist has no file
 * identity to compare, so a case-insensitive filesystem (macOS) could
 * otherwise take `.agents/Hooks.json` as another name. The fold runs on every
 * platform: guarding more on Linux does no harm.
 */
const foldSpelling = (path: string): string =>
  path
    .replace(HFS_IGNORED_CHARACTERS, "")
    .normalize("NFD")
    .toUpperCase()
    .toLowerCase()
    .normalize("NFD");

/** Returns whether `path` is `folder` or a path below it, as folded text. */
const isInsideFolder = (path: string, folder: string): boolean => {
  const base = foldSpelling(folder);
  const target = foldSpelling(path);
  return target === base || target.startsWith(base.endsWith("/") ? base : `${base}/`);
};

/**
 * Returns whether the edit target is the guarded place or inside it. Any
 * reading of the target against any reading of the place counts, and so does
 * a shared file identity.
 */
const isTargetInPlace = (target: EditTarget, place: GuardedPlace): boolean => {
  for (const targetPath of target.paths) {
    for (const placePath of place.paths) {
      if (
        place.isFolder
          ? isInsideFolder(targetPath, placePath)
          : foldSpelling(targetPath) === foldSpelling(placePath)
      ) {
        return true;
      }
    }
  }
  return place.identity !== undefined && target.identities.includes(place.identity);
};

/**
 * Returns whether the call starts or drives the browser agent: a
 * chrome-devtools call, or `invoke_subagent` with `TypeName` "browser". The
 * `TypeName` is compared without the whitespace Go trims and without case, as
 * `agy` may do either (not measured). `Role` is free text the model writes, so
 * it is never read.
 */
const isBrowserCall = (call: DecodedCall): boolean => {
  const kind = classifyTool(call.name);
  if (kind === "browser") return true;
  const typeName = call.args["TypeName"];
  return (
    kind === "subagent" &&
    typeof typeName === "string" &&
    foldSpelling(typeName.replace(GO_SPACE_AT_ENDS, "")) === "browser"
  );
};

/**
 * Decides what the hook answers for an edit tool call in a guarded session: a
 * denial, or undefined to let it run. Denies when the call has no text `Path`
 * and when the guarded places cannot be listed. Throws on any other failure.
 */
const decideEdit = (
  call: DecodedCall,
  rules: HookRules,
  env: Readonly<Record<string, string | undefined>>,
): HookDenial | undefined => {
  const path = call.args["Path"];
  if (typeof path !== "string") return deny(UNREADABLE_REASON);
  let places: ReadonlyArray<GuardedPlace>;
  try {
    places = buildGuardedPlaces(call.cwd, rules);
  } catch (error) {
    if (error instanceof GuardedPlacesError) {
      return deny(buildPlacesFailureReason(error.failure));
    }
    throw error;
  }
  const target = buildEditTarget(call.cwd, path, env["HOME"] ?? homedir());
  const place = places.find((candidate) => isTargetInPlace(target, candidate));
  return place === undefined ? undefined : deny(buildGuardReason(path, place));
};

/**
 * Decides what the hook answers for one call: a denial, or undefined to let
 * it run. It fails closed. Unless the rules say Full access, a call that could
 * not be decoded is denied, because the hook cannot tell what it would change.
 * Rules that are missing or do not decode (`rules` undefined) deny every edit
 * tool call (guarded place or not), every web search and every call that could
 * not be decoded, with a reason that says the setup is wrong. A shell command
 * runs, because `agy` asks about it. In Approval required and Auto-accept
 * edits the browser agent is denied, whatever the rules say.
 */
const decide = (
  call: DecodedCall | undefined,
  input: RawInput,
  rules: HookRules | undefined,
  env: Readonly<Record<string, string | undefined>>,
): HookDenial | undefined => {
  if (rules?.accessMode === "full-access") return undefined;
  const kind = call === undefined ? undefined : classifyTool(call.name);
  if (rules === undefined) {
    return call === undefined || kind === "edit" || kind === "search" || isBrowserCall(call)
      ? deny(BAD_RULES_REASON)
      : undefined;
  }
  if (call === undefined) {
    return deny(input === INPUT_TOO_LARGE ? TOO_LARGE_REASON : UNREADABLE_REASON);
  }
  if (isBrowserCall(call)) return deny(buildBrowserReason(rules.accessMode));
  if (kind === "search") {
    return rules.accessMode === "approval-required" ? deny(WEB_SEARCH_REASON) : undefined;
  }
  return kind === "edit" ? decideEdit(call, rules, env) : undefined;
};

/**
 * Returns the text the hook prints for the tool call in `input`: one line of
 * JSON for a denial, or an empty string to let the call run. Writes the
 * edit-watch mark as a side effect. `input` is undefined when stdin could not
 * be read, and `INPUT_TOO_LARGE` when it held more than the hook reads.
 *
 * `agy` stops the tool when the hook fails, so any unexpected error still ends
 * in a valid answer: a denial that says the check failed, unless the rules
 * say Full access.
 */
export const answerPreToolCall = (
  input: RawInput,
  env: Readonly<Record<string, string | undefined>>,
): string => {
  let rules: HookRules | undefined;
  try {
    const encoded = env[HOOK_RULES_VARIABLE];
    rules = encoded ? decodeHookRules(encoded) : undefined;
    const call = decodeCall(input);
    if (call !== undefined) takeMark(call, env);
    return formatAnswer(decide(call, input, rules, env));
  } catch {
    return formatAnswer(
      rules?.accessMode === "full-access" ? undefined : deny(CHECK_FAILED_REASON),
    );
  }
};

/** Returns the text the hook prints for `denial`: one line of JSON, or nothing to let the call run. */
const formatAnswer = (denial: HookDenial | undefined): string =>
  denial === undefined ? "" : `${JSON.stringify(denial)}\n`;

/**
 * Reads stdin to its end and returns its text, or `INPUT_TOO_LARGE` when it
 * holds more than `MAX_INPUT_BYTES`. Always reads to the end, also past the
 * bound (the excess is discarded, not kept): `agy` writes the call and waits
 * for the answer, and a hook that closes stdin early makes that write fail
 * with a broken pipe, which `agy` may count as a failing hook and stop the
 * tool for, in every mode.
 */
const readBoundedStdin = async (): Promise<string | typeof INPUT_TOO_LARGE> => {
  const chunks: Array<Buffer> = [];
  let size = 0;
  for await (const chunk of process.stdin as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size <= MAX_INPUT_BYTES) chunks.push(chunk);
  }
  return size > MAX_INPUT_BYTES ? INPUT_TOO_LARGE : Buffer.concat(chunks).toString("utf8");
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
