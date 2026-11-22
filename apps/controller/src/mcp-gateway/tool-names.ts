/**
 * The names the MCP Gateway gives the tools of a session's servers (spec 21
 * section 3.4). A tool is named `<server name>__<tool name>`. The name is a
 * pure function of the server's name and the tool's original name: no list,
 * no order and no memory decides what a name stands for, so a controller
 * restart cannot change it.
 */
import { createHash } from "node:crypto";
import { MCP_GATEWAY_HARNESS_PREFIX, MCP_GATEWAY_TOOL_SEPARATOR } from "@hercule/protocol";

/** The longest tool name a harness accepts (pi's limit), prefix included. */
const MAX_HARNESS_NAME_LENGTH = 64;

/** The longest name the gateway sends: what is left of the limit after the harness's prefix. */
const MAX_NAME_LENGTH = MAX_HARNESS_NAME_LENGTH - MCP_GATEWAY_HARNESS_PREFIX.length;

/** Length of the hash suffix: `_` plus six hex characters. */
const SUFFIX_LENGTH = 7;

/** A tool name the gateway sends as it is: only these characters. */
const KEPT_CHARACTERS = /^[A-Za-z0-9_-]+$/;

/** The end of every changed name: `_` plus six lowercase hex characters. No unchanged name ends so. */
const HASH_SUFFIX = /_[0-9a-f]{6}$/;

/** One tool as a session's server lists it: the server's name and the tool's original name. */
export interface ToolKey {
  readonly serverName: string;
  readonly tool: string;
}

/** What a gateway name was offered for: the server's id and name, and the tool's original name. */
export interface OfferedTool {
  readonly serverId: string;
  readonly serverName: string;
  readonly tool: string;
}

/** A server's tools, to be named. */
export interface ServerTools {
  readonly serverName: string;
  readonly tools: ReadonlyArray<string>;
}

/** The names built for one list: each tool with its name, and the tools left out. */
export interface NamedTools {
  /** In order by server name, then by original tool name. */
  readonly named: ReadonlyArray<ToolKey & { readonly name: string }>;
  /**
   * Tools that are not offered: their original name is not well-formed
   * Unicode, or another tool of the same server gets the same name. The
   * caller logs them.
   */
  readonly leftOut: ReadonlyArray<ToolKey>;
}

/** Matches a lone surrogate. With the `u` flag, a surrogate that belongs to a pair is part of one character and does not match. */
const LONE_SURROGATE = /\p{Surrogate}/u;

/**
 * Returns whether `text` is well-formed Unicode, which means it holds no lone
 * surrogate. This is what `String.prototype.isWellFormed` checks. The project
 * builds against the ES2023 library, which does not declare that method.
 */
const isWellFormed = (text: string): boolean => !LONE_SURROGATE.test(text);

/** Returns the first six hex characters of the SHA-256 of `text`. */
const hashSuffix = (text: string): string =>
  createHash("sha256").update(text).digest("hex").slice(0, 6);

/**
 * Returns the name the gateway gives a tool, from the tool alone.
 *
 * The original name is kept when all of these hold:
 *
 * - it has only the characters `A-Z`, `a-z`, `0-9`, `_` and `-`;
 * - it does not end in `_` plus six lowercase hex characters, because that
 *   ending belongs to changed names, so an unchanged name never equals the
 *   changed name of another tool;
 * - the whole name fits in 52 characters, which is 64 behind `mcp__tools__`.
 *
 * Otherwise the name is changed: the original with every other character
 * turned into `_`, cut so the whole fits, then `_` and six hex characters of
 * the SHA-256 of the original name. A changed name always has that ending,
 * whether or not another tool would clash with the plain one.
 */
export const buildToolName = ({ serverName, tool }: ToolKey): string => {
  const prefix = `${serverName}${MCP_GATEWAY_TOOL_SEPARATOR}`;
  if (
    KEPT_CHARACTERS.test(tool) &&
    !HASH_SUFFIX.test(tool) &&
    prefix.length + tool.length <= MAX_NAME_LENGTH
  ) {
    return `${prefix}${tool}`;
  }
  const normalized = tool.replace(/[^A-Za-z0-9_-]/g, "_");
  const room = MAX_NAME_LENGTH - prefix.length - SUFFIX_LENGTH;
  return `${prefix}${normalized.slice(0, room)}_${hashSuffix(tool)}`;
};

const compareText = (one: string, other: string): number =>
  one < other ? -1 : one > other ? 1 : 0;

/**
 * Returns the name of every tool of `servers`, in order by server name and
 * then by original tool name. Each name depends on its own tool only.
 *
 * Two kinds of tool are left out:
 *
 * - A tool whose original name is not well-formed Unicode (it holds a lone
 *   surrogate). Such a name cannot be told apart from another: the hash and
 *   the normalized text treat every lone surrogate as the same replacement
 *   character, so two different names would get one gateway name.
 * - A tool whose name another tool of the same server also gets. Both are left
 *   out, because no name may stand for two tools. This needs two different
 *   original names that share a normalized prefix and the first 24 bits of
 *   their hashes.
 */
export const buildToolNames = (servers: ReadonlyArray<ServerTools>): NamedTools => {
  const sorted = servers
    .toSorted((one, other) => compareText(one.serverName, other.serverName))
    .flatMap((server) =>
      server.tools
        .toSorted(compareText)
        .map((tool): ToolKey => ({ serverName: server.serverName, tool })),
    );
  const all = sorted
    .filter(({ tool }) => isWellFormed(tool))
    .map((key) => ({ ...key, name: buildToolName(key) }));
  const counts = new Map<string, number>();
  for (const { name } of all) counts.set(name, (counts.get(name) ?? 0) + 1);
  const named = all.filter(({ name }) => counts.get(name) === 1);
  const clashing = all
    .filter(({ name }) => counts.get(name) !== 1)
    .map(({ serverName, tool }): ToolKey => ({ serverName, tool }));
  const illFormed = sorted.filter(({ tool }) => !isWellFormed(tool));
  return { named, leftOut: [...illFormed, ...clashing] };
};

/**
 * Returns the original name of the tool of `serverName` that `name` stands
 * for, out of the tool names the server lists now. Returns `undefined` when
 * no listed tool has that name, or when more than one has it: such tools are
 * left out of every list (`buildToolNames`), so none of them may be called.
 * A tool whose original name is not well-formed Unicode never matches, for
 * the same reason.
 */
export const findOriginalToolName = (
  serverName: string,
  listedTools: ReadonlyArray<string>,
  name: string,
): string | undefined => {
  const matching = listedTools.filter(
    (tool) => isWellFormed(tool) && buildToolName({ serverName, tool }) === name,
  );
  return matching.length === 1 ? matching[0] : undefined;
};
