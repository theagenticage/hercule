/**
 * The names the MCP Gateway gives the tools of a session's servers (spec 21
 * section 3.4). A tool is named `<server name>__<tool name>`. Allocation is
 * pure. The `NameLedger` is the one place that remembers, per Session Token,
 * which names were sent and what each stands for.
 */
import { createHash } from "node:crypto";
import { MCP_GATEWAY_ENTRY_NAME } from "@hercule/protocol";

/** What a harness puts in front of the gateway's tool names: `mcp__tools__`. */
const HARNESS_PREFIX_LENGTH = `mcp__${MCP_GATEWAY_ENTRY_NAME}__`.length;

/** The longest tool name a harness accepts (pi's limit), prefix included. */
const MAX_HARNESS_NAME_LENGTH = 64;

/** The longest name the gateway sends: what is left of the limit after the harness's prefix. */
const MAX_NAME_LENGTH = MAX_HARNESS_NAME_LENGTH - HARNESS_PREFIX_LENGTH;

/** Length of the hash suffix: `_` plus six hex characters. */
const SUFFIX_LENGTH = 7;

/** One tool as a session's server lists it: the server's name and the tool's original name. */
export interface ToolKey {
  readonly serverName: string;
  readonly tool: string;
}

/**
 * What a name the gateway sent stands for: the tool, and the id of the server
 * the list held then. A call is dispatched to the server the list holds by
 * name when the call arrives. The id only lets a refusal name the server a
 * call meant after the list dropped it.
 */
export interface ReservedTool extends ToolKey {
  readonly serverId: string;
}

/** A server's tools, to be named. */
export interface ServerTools {
  readonly serverName: string;
  readonly tools: ReadonlyArray<string>;
}

/** The names allocated for one list: each tool with its name, and the tools left out. */
export interface AllocatedNames {
  /** In the order they were named: by server name, then by original tool name. */
  readonly named: ReadonlyArray<ToolKey & { readonly name: string }>;
  /** Tools that could get no unique name. The caller logs them. */
  readonly leftOut: ReadonlyArray<ToolKey>;
}

/** Returns the first six hex characters of the SHA-256 of `text`. */
const hashSuffix = (text: string): string =>
  createHash("sha256").update(text).digest("hex").slice(0, 6);

/** Returns `tool` with every character outside `[A-Za-z0-9_]` replaced by `_`. */
const normalizeToolName = (tool: string): string => tool.replace(/[^A-Za-z0-9_]/g, "_");

/**
 * Returns the name a tool gets when nothing clashes: `<server>__<tool>`, with
 * the tool normalized. When the harness would see more than 64 characters,
 * the tool part is cut and ends in `_` plus six hex characters of a hash of
 * the original name, so two long names that start alike stay apart.
 */
const buildPrimaryName = ({ serverName, tool }: ToolKey): string => {
  const normalized = normalizeToolName(tool);
  const full = `${serverName}__${normalized}`;
  if (full.length <= MAX_NAME_LENGTH) return full;
  const room = MAX_NAME_LENGTH - serverName.length - 2;
  return `${serverName}__${normalized.slice(0, room - SUFFIX_LENGTH)}_${hashSuffix(tool)}`;
};

/**
 * Returns the name a tool gets when its primary name is taken: the primary
 * name with `_` and six hex characters of a hash of the server's name and the
 * tool's original name, cut at the front when that passes 64 characters.
 */
const buildClashName = (key: ToolKey): string => {
  const primary = buildPrimaryName(key);
  const suffix = `_${hashSuffix(`${key.serverName}\0${key.tool}`)}`;
  return `${primary.slice(0, MAX_NAME_LENGTH - SUFFIX_LENGTH)}${suffix}`;
};

const isSame = (one: ToolKey, other: ToolKey): boolean =>
  one.serverName === other.serverName && one.tool === other.tool;

const compareText = (one: string, other: string): number =>
  one < other ? -1 : one > other ? 1 : 0;

/**
 * Gives every tool of the list a name that is unique within it and that keeps
 * its meaning for the Session Token holding `reservations`.
 *
 * Tools are named in a fixed order, by server name and then by original tool
 * name, so the same list always gets the same names. For each tool the first
 * of these applies:
 *
 * 1. A name the token already holds for this very tool is used again, so a
 *    later change to the list never moves a name.
 * 2. Its primary name, when no other tool holds it.
 * 3. Its clash name, when no other tool holds that.
 * 4. Otherwise the tool is left out and returned in `leftOut`.
 *
 * "Holds" means reserved for another tool in `reservations`, or given to an
 * earlier tool of this list.
 */
export const allocateToolNames = (
  servers: ReadonlyArray<ServerTools>,
  reservations: ReadonlyMap<string, ToolKey>,
): AllocatedNames => {
  const ordered = servers
    .toSorted((one, other) => compareText(one.serverName, other.serverName))
    .flatMap((server) =>
      server.tools
        .toSorted(compareText)
        .map((tool): ToolKey => ({ serverName: server.serverName, tool })),
    );
  const taken = new Set<string>();
  const named: Array<ToolKey & { readonly name: string }> = [];
  const leftOut: Array<ToolKey> = [];
  for (const key of ordered) {
    const candidates = [buildPrimaryName(key), buildClashName(key)];
    const reservedForThis = candidates.find((name) => {
      const holder = reservations.get(name);
      return holder !== undefined && isSame(holder, key) && !taken.has(name);
    });
    const name =
      reservedForThis ?? candidates.find((one) => !reservations.has(one) && !taken.has(one));
    if (name === undefined) {
      leftOut.push(key);
      continue;
    }
    taken.add(name);
    named.push({ ...key, name });
  }
  return { named, leftOut };
};

/**
 * The meaning of every name the gateway has sent to one Session Token since
 * the controller started. A call is accepted only under one of these names,
 * and a name keeps its meaning after its tool leaves the list.
 */
export interface NameLedger {
  /** Returns what `name` stands for, or `undefined` when no list sent this token that name. */
  readonly find: (name: string) => ReservedTool | undefined;
  /** Names the tools of `servers` so that every name this token holds keeps its meaning. Records nothing. */
  readonly allocate: (servers: ReadonlyArray<ServerTools>) => AllocatedNames;
  /** Records `sent` as the names of a `tools/list` response, once the response is being answered. */
  readonly record: (sent: ReadonlyArray<ReservedTool & { readonly name: string }>) => void;
}

/** Builds the ledger of a new Session Token: nothing was sent yet. */
export const makeNameLedger = (): NameLedger => {
  const reservations = new Map<string, ReservedTool>();
  return {
    find: (name) => reservations.get(name),
    allocate: (servers) => allocateToolNames(servers, reservations),
    record: (sent) => {
      for (const { name, serverName, tool, serverId } of sent) {
        reservations.set(name, { serverName, tool, serverId });
      }
    },
  };
};
