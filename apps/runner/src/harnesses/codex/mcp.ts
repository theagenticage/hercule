/**
 * How a Codex thread gets the session's MCP servers (the MCP Gateway today).
 * Codex reads them from its config, and `thread/start` takes config values as
 * dotted keys. A thread does not keep them: `thread/resume` and `thread/fork`
 * must send them again, or nothing connects and the model's call fails with no
 * message.
 */
import { SESSION_TOKEN_VARIABLE } from "../../credentials/helper";
import type { ResolvedMcpServer } from "../index";
import type { JsonValue } from "./types";

/**
 * How Codex asks about a call to a tool of an MCP server:
 *
 * - `prompt` asks about every call, whatever the tool's annotations.
 * - `approve` never asks.
 *
 * Codex also has `auto` and `writes`, which let the server's own annotations
 * decide. Those annotations come from an outside server, so they must never
 * lower what the Access Mode asks for.
 */
export type McpToolApprovalMode = "prompt" | "approve";

/**
 * The first Codex release that re-reads a server's tool list when the server
 * says it changed (`features.mcp_tool_list_changed`). Codex refuses a config
 * key it does not know, so the key is sent only to a release that has it.
 */
const TOOL_LIST_CHANGED_SINCE = [0, 164, 0] as const;

/**
 * Checks whether a Codex of this version re-reads a server's tool list when
 * the server says it changed. `version` is what `parseVersion` read from the
 * app-server's user agent, or `null`. Returns false for `null` and for a
 * version that is not three numbers: the key is then left out, which is safe
 * for every release.
 */
export const supportsToolListChanged = (version: string | null): boolean => {
  const parts = version?.split(".", 3).map((part) => Number.parseInt(part, 10));
  if (parts === undefined || parts.length !== 3 || !parts.every(Number.isInteger)) return false;
  for (const [index, part] of parts.entries()) {
    const needed = TOOL_LIST_CHANGED_SINCE[index]!;
    if (part !== needed) return part > needed;
  }
  return true;
};

/**
 * Returns the warning for a session whose Codex does not re-read its tool
 * list, so a Hercule user is not surprised when a new MCP Server does not show
 * up in a running thread.
 */
export const buildNoToolListChangedWarning = (version: string | null): string =>
  `This Codex (${version ?? "unknown version"}) does not re-read its tool list, ` +
  "so an MCP Server added while the thread runs is usable from its next start. " +
  "Upgrade Codex to 0.164.0 or newer.";

/**
 * Returns the `config` for the session's MCP servers, to send with
 * `thread/start`, `thread/resume` and `thread/fork`. Returns an empty object
 * when there are no servers, so no key reaches Codex.
 *
 * - Each server gets its URL, and the name of the variable that holds the
 *   session's token, never the token: Codex reads the variable itself when it
 *   connects and sends the token as a bearer token.
 * - Each server gets the approval mode of the session's Access Mode.
 * - Each server is also set `enabled = true` and `disabled_tools = []`. A
 *   trusted workspace's `.codex/config.toml` is merged into the same table, so
 *   a project that defines a server of this name with `enabled = false` or a
 *   list of disabled tools would silently switch the gateway off. These two
 *   keys undo that. They cannot undo a project's `enabled_tools`, or a per-tool
 *   `approval_mode` under `[mcp_servers.<name>.tools.<tool>]`: Codex has no way
 *   to clear those for tool names that are not known in advance.
 * - The tool list feature is set only when the running Codex has it.
 *
 * Exported so the real-binary test starts Codex with exactly this config.
 */
export const buildMcpServerConfig = (
  servers: ReadonlyArray<ResolvedMcpServer>,
  approvalMode: McpToolApprovalMode,
  toolListChanged: boolean,
): Record<string, JsonValue> =>
  servers.length === 0
    ? {}
    : {
        ...Object.fromEntries(
          servers.flatMap((server) => [
            [`mcp_servers.${server.name}.url`, server.url],
            [`mcp_servers.${server.name}.enabled`, true],
            [`mcp_servers.${server.name}.disabled_tools`, []],
            [`mcp_servers.${server.name}.bearer_token_env_var`, SESSION_TOKEN_VARIABLE],
            [`mcp_servers.${server.name}.default_tools_approval_mode`, approvalMode],
          ]),
        ),
        ...(toolListChanged ? { "features.mcp_tool_list_changed": true } : {}),
      };
