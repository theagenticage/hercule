/**
 * What the pre-tool hook of an `agy` session decides (spec 06 section 8.1),
 * apart from how it reads its input. This file has no imports, so the hook
 * process that starts for every tool call and the adapter that writes the
 * hooks file can both link it for nothing.
 *
 * The policy is a pure function over facts the hook has already collected
 * (`decidePreToolHook`). Reading the input, the environment and the
 * filesystem is the hook's job (`pre-tool-hook.ts`).
 *
 * Known limits, recorded in spec 06 section 8.1:
 * - The check and `agy`'s write are two steps. A path swapped between them
 *   (a link put in place by a concurrent process of the same user) is not
 *   prevented.
 * - The tool and folder names below are the ones measured on `agy` 1.5.15. A
 *   tool or a folder name a later `agy` adds is not covered until they are
 *   measured again.
 */

/** The verb of the `hercule` binary that runs the pre-tool hook (`pre-tool-hook.ts`). */
export const PRE_TOOL_HOOK_VERB = "antigravity-pre-tool-hook";

/** Set on the `agy` process of every session that is not in full access. Without it the hook guards no file. */
export const GUARD_VARIABLE = "HERCULE_AGY_GUARD";

/** Set only on the `agy` process of a session in Approval required. The hook then denies web search, because a search runs without a card. */
export const DENY_WEB_SEARCH_VARIABLE = "HERCULE_AGY_DENY_WEB_SEARCH";

/** Holds the session's additional skills directory, when it has one. The hook denies every change inside it. */
export const SKILLS_DIRECTORY_VARIABLE = "HERCULE_AGY_SKILLS_DIR";

/** The name of the tool that runs a shell command. */
export const SHELL_TOOL_NAME = "run_command";

/** The names of the tools that change a file, each with a `Path` argument. */
export const EDIT_TOOL_NAMES: ReadonlyArray<string> = ["edit_file", "write_file"];

/** The name of the tool that searches the web. */
export const WEB_SEARCH_TOOL_NAME = "search_web";

/** The names of the folders `agy` reads its configuration from, in the session's folder and every folder above it. */
export const CONFIG_FOLDER_NAMES: ReadonlyArray<string> = [".agents"];

/** The files in a configuration folder that `agy` loads approval rules or programs from. */
export const GUARDED_CONFIG_FILES: ReadonlyArray<string> = [
  "hooks.json",
  "plugins.json",
  "mcp_config.json",
];

/** The folder in a configuration folder that holds plugins. Everything below it is guarded. */
export const PLUGINS_FOLDER_NAME = "plugins";

/** The tools the hooks file runs the hook for, as the regular expression `agy` matches tool names against. */
export const HOOK_MATCHER = [SHELL_TOOL_NAME, ...EDIT_TOOL_NAMES, WEB_SEARCH_TOOL_NAME].join("|");

/** What the hook prints to deny a tool call. A call it allows gets no output. */
export interface HookDenial {
  readonly decision: "deny";
  readonly reason: string;
}

/** A tool call whose fields the hook decoded. `args` holds what `agy` passed to the tool. */
export interface DecodedToolCall {
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
}

/**
 * A place the agent may not change: a file, or a folder with everything
 * below it. It is read the way the text spells it (`lexicalPath`) and the way
 * the operating system resolves it (`resolvedPath`). `identity` is the file
 * identity (device and inode) of the place when it exists, which stays equal
 * when a filesystem folds case or Unicode and a spelling differs.
 */
export interface GuardedPlace {
  readonly isFolder: boolean;
  readonly lexicalPath: string;
  readonly resolvedPath: string;
  readonly identity: string | undefined;
}

/**
 * Where an edit tool writes, read both ways, plus the file identities of the
 * longest part of the path that exists and of every folder above it. A new
 * file under an existing guarded folder, reached through another spelling,
 * has that folder's identity among them.
 */
export interface EditTarget {
  readonly lexicalPath: string;
  readonly resolvedPath: string;
  readonly existingIdentities: ReadonlyArray<string>;
}

/** What `decidePreToolHook` decides from. */
export interface PreToolFacts {
  readonly guardIsOn: boolean;
  readonly deniesWebSearch: boolean;
  /** The decoded call, or undefined when the input could not be decoded. */
  readonly call: DecodedToolCall | undefined;
  /** Present when the call is an edit tool with a text `Path` and the guard is on. */
  readonly editTarget: EditTarget | undefined;
  readonly guardedPlaces: ReadonlyArray<GuardedPlace>;
}

const WEB_SEARCH_REASON =
  "Web search is off in Approval required, because a search runs without a card. Ask the user, or switch the thread to another access mode.";

const UNREADABLE_REASON =
  "Hercule could not read this tool call, so it cannot check it. Ask the user, or switch the thread to Full access.";

/** Returns whether `path` is `folder` or a path below it. Both are absolute and normalized. */
const isInsideFolder = (path: string, folder: string): boolean =>
  path === folder || path.startsWith(folder.endsWith("/") ? folder : `${folder}/`);

/**
 * Returns whether the edit target is the guarded place or inside it. Any
 * reading of the target against any reading of the place counts, and so does
 * a shared file identity.
 */
const isTargetInPlace = (target: EditTarget, place: GuardedPlace): boolean => {
  const matches = (targetPath: string, placePath: string): boolean =>
    place.isFolder ? isInsideFolder(targetPath, placePath) : targetPath === placePath;
  for (const targetPath of [target.lexicalPath, target.resolvedPath]) {
    for (const placePath of [place.lexicalPath, place.resolvedPath]) {
      if (matches(targetPath, placePath)) return true;
    }
  }
  return place.identity !== undefined && target.existingIdentities.includes(place.identity);
};

/**
 * Decides what the hook answers for one tool call: a denial, or undefined to
 * let the call run. It fails closed. When the guard or the web search denial
 * is on and the call could not be decoded, or an edit tool has no text
 * `Path`, the call is denied, because the hook cannot tell what it would
 * change.
 */
export const decidePreToolHook = (facts: PreToolFacts): HookDenial | undefined => {
  const { call } = facts;
  if (call === undefined) {
    return facts.guardIsOn || facts.deniesWebSearch
      ? { decision: "deny", reason: UNREADABLE_REASON }
      : undefined;
  }
  if (call.name === WEB_SEARCH_TOOL_NAME) {
    return facts.deniesWebSearch ? { decision: "deny", reason: WEB_SEARCH_REASON } : undefined;
  }
  if (!EDIT_TOOL_NAMES.includes(call.name) || !facts.guardIsOn) return undefined;
  const path = call.args["Path"];
  if (typeof path !== "string" || facts.editTarget === undefined) {
    return { decision: "deny", reason: UNREADABLE_REASON };
  }
  const { editTarget } = facts;
  return facts.guardedPlaces.some((place) => isTargetInPlace(editTarget, place))
    ? {
        decision: "deny",
        reason: `Hercule does not let the agent change ${path}: it decides what the agent may do without asking. Ask the user to change it.`,
      }
    : undefined;
};
