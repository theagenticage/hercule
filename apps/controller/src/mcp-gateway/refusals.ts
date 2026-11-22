/**
 * Refused calls (spec 21 section 3.6): the words the agent and the Thread
 * get, and how often the Thread is told. Everything here is pure except the
 * map `claimWarning` records into.
 */
import type { McpServerWarningReason } from "@hercule/protocol";

/** Why a call was refused: a reason the Thread can name, or a tool name no server of the session has. */
export type RefusalReason = McpServerWarningReason | "unknown-tool";

/** A call the gateway refused, with what the agent and the Thread are told. */
export interface Refusal {
  readonly reason: RefusalReason;
  /** The server the call meant, when the gateway knows it. */
  readonly server?: { readonly id: string; readonly name: string };
  /** The tool the call meant, by its original name, when the gateway knows it. */
  readonly tool?: string;
  /** The tool result the agent reads: what went wrong and what the user can do. */
  readonly message: string;
}

/** The session's profile does not hold `mcp.use`. */
export const buildMissingGrantRefusal = (): Refusal => ({
  reason: "missing-grant",
  message:
    "This session may not use MCP tools: its permission profile lacks the mcp.use grant. " +
    "Ask the user to add it to the profile.",
});

/** The longest part of a tool name that a message repeats. */
const MAX_SHOWN_TOOL_NAME_LENGTH = 64;

/**
 * Returns a tool name made safe to repeat in a message that is stored in the
 * Thread: characters that no tool name has become `?`, and the name is cut at
 * 64 characters. A name the caller sent can be as long as the 1 MiB request
 * body, and a name an upstream server listed has no limit either, so an
 * unbounded name would reach the Thread's transcript as written.
 */
const showToolName = (toolName: string): string => {
  const safe = toolName.replace(/[^A-Za-z0-9_.-]/g, "?");
  return safe.length > MAX_SHOWN_TOOL_NAME_LENGTH
    ? `${safe.slice(0, MAX_SHOWN_TOOL_NAME_LENGTH)}...`
    : safe;
};

/**
 * The tool name was not sent to this session by `tools/list` since the
 * controller started: no server of the session has it, or the harness
 * remembers it from before a restart.
 */
export const buildUnknownToolRefusal = (toolName: string): Refusal => ({
  reason: "unknown-tool",
  message:
    `No MCP tool named "${showToolName(toolName)}" is offered to this session right now. ` +
    "List the tools again and call one of those. If the tool is still missing, " +
    "ask the user to check which MCP servers are in this Thread's list.",
});

/**
 * The server the name belongs to is not in the session's list any more. The
 * name gives the server's name. `found` is the server of that name when one
 * still exists (it left the list but was not deleted), with the tool the name
 * stands for when the server still stores it. Without `found` the refusal
 * names the server by its name only.
 */
export const buildNotInListRefusal = (
  serverName: string,
  found?: { readonly id: string; readonly tool: string | undefined },
): Refusal => ({
  reason: "not-in-list",
  ...(found === undefined
    ? {}
    : {
        server: { id: found.id, name: serverName },
        ...(found.tool === undefined ? {} : { tool: found.tool }),
      }),
  message:
    `The MCP server "${serverName}" is not in this Thread's list any more. ` +
    "The user may have removed it from the Thread or deleted it. " +
    "If you still need it, ask the user to check which MCP servers this Thread has.",
});

/**
 * The session already runs the most `tools/call` requests a Session Token may
 * run at once. The refusal names no server and no tool, because the call is
 * refused before it is read.
 */
export const buildTooManyCallsRefusal = (maxRunningCalls: number): Refusal => ({
  reason: "error",
  message:
    `This session already has ${maxRunningCalls} MCP tool calls running, which is the most it may run at once. ` +
    "Wait for some of them to finish and then call again.",
});

/** Returns the line the Thread shows for a refused call. */
export const buildRefusalWarning = (refusal: Refusal): string =>
  `A tool call was refused. ${refusal.message}`;

/** When the Thread was last told about one server and reason, and in which turn. */
export interface SeenWarning {
  readonly turnId: string | undefined;
  readonly atMs: number;
}

/** How long outside a turn the Thread is not told again about the same server and reason. */
const WARNING_INTERVAL_MS = 60_000;

/**
 * Decides whether the Thread is told about a refusal, and records it when so.
 * The Thread hears of one server and reason (or of a refusal that names no
 * server) once per turn, or once a minute outside a turn. Returns `true` when
 * the caller must write the warning.
 */
export const claimWarning = (
  seen: Map<string, SeenWarning>,
  refusal: Refusal,
  turnId: string | undefined,
  nowMs: number,
): boolean => {
  const key = `${refusal.server?.id ?? ""}:${refusal.reason}`;
  const last = seen.get(key);
  const repeated =
    last !== undefined &&
    (turnId === undefined
      ? last.turnId === undefined && nowMs - last.atMs < WARNING_INTERVAL_MS
      : last.turnId === turnId);
  if (repeated) return false;
  seen.set(key, { turnId, atMs: nowMs });
  return true;
};

/**
 * The server is in the session's list, but none of the tools it lists now has
 * the called name: the tool is gone, or two tools of the server share the name
 * and are left out of every list.
 */
export const buildToolNotListedRefusal = (server: {
  readonly id: string;
  readonly name: string;
}): Refusal => ({
  reason: "error",
  server,
  message: `The MCP server "${server.name}" no longer offers this tool.`,
});
