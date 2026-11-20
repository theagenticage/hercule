/**
 * Refused calls (spec 21 section 3.6): the words the agent and the Thread
 * get, and how often the Thread is told. Everything here is pure except the
 * map `claimWarning` records into.
 */
import type { McpServerWarningReason } from "@hercule/protocol";
import type { StoredMcpServer } from "../mcp-servers";

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

/** The longest part of a caller's tool name that a message repeats. */
const MAX_SHOWN_TOOL_NAME_LENGTH = 64;

/**
 * Returns a tool name the caller sent, made safe to repeat in a message that
 * is stored in the Thread: characters that no tool name has become `?`, and
 * the name is cut at 64 characters. The request body may be 1 MiB, so an
 * unbounded name would reach the Thread's transcript as written.
 */
const showCallerToolName = (toolName: string): string => {
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
    `No MCP tool named "${showCallerToolName(toolName)}" is offered to this session right now. ` +
    "List the tools again and call one of those. If the tool is still missing, " +
    "ask the user to check which MCP servers are in this Thread's list.",
});

/** The server the name belongs to is not in the session's list any more. */
export const buildNotInListRefusal = (
  server: { readonly id: string; readonly name: string } | undefined,
  serverName: string,
  tool: string,
): Refusal => ({
  reason: "not-in-list",
  ...(server === undefined ? {} : { server }),
  tool,
  message:
    `The MCP server "${serverName}" is not in this Thread's list any more. ` +
    "Ask the user to add it back to the Thread.",
});

/** The tool is no longer in the server's stored tool list. */
export const buildToolGoneRefusal = (
  server: Pick<StoredMcpServer, "id" | "name">,
  toolName: string,
): Refusal => ({
  reason: "unknown-tool",
  server: { id: server.id, name: server.name },
  tool: toolName,
  message: `The MCP server "${server.name}" no longer offers a tool named "${toolName}".`,
});

/**
 * Returns the refusal for a server that is in the list but may not be served:
 * it is switched off, it has no stored tool list yet, or its plugin or
 * Connection cannot be used.
 */
export const buildNotServedRefusal = (server: StoredMcpServer, tool: string): Refusal => {
  const named = { id: server.id, name: server.name };
  if (!server.enabled) {
    return {
      reason: "switched-off",
      server: named,
      tool,
      message: `The MCP server "${server.name}" is switched off. Ask the user to switch it on in Settings > MCP servers.`,
    };
  }
  if (server.checkedAt === null) {
    return {
      reason: "checking",
      server: named,
      tool,
      message: `The MCP server "${server.name}" has not listed its tools yet. Try again in a minute.`,
    };
  }
  return {
    reason: server.status === "ready" ? "error" : server.status,
    server: named,
    tool,
    message:
      `The MCP server "${server.name}" cannot be used right now` +
      (server.statusDetail === null ? "." : `: ${server.statusDetail}`) +
      " Ask the user to look at it in Settings > MCP servers.",
  };
};

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
