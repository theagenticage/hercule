/**
 * Maps one Antigravity tool call, as ACP reports it, to the item Hercule shows
 * for it: the item kind and its `detail`. Pure: it reads the call and nothing
 * else. Spec 06 section 6.3 owns the mapping, and section 6.5 the approval
 * Request that follows from the item's kind.
 *
 * Only `normalize.ts` imports this module.
 *
 * A tool is mapped by its name, never by the call's ACP `kind`, because
 * `kind: "other"` covers MCP tools, `ask_question` and `invoke_subagent`
 * alike. Paths come from `rawInput.Path` and never from `locations`, which
 * flips between `/tmp/...` and `/private/tmp/...` within one call.
 */
import type { ToolCall } from "@hercule/acp";
import { MAX_FACT_LENGTH, type ApprovalRequest, type ItemKind } from "@hercule/protocol";
import type * as Schema from "effect/Schema";
import { buildEditedPathFields } from "../edited-paths";
import { splitGatewayToolName } from "../gateway-tool-name";
import { truncateFact, truncateMessage, truncateWithMarker } from "../text";

/**
 * Returns the search query with ` site:<domain>` after it, at most
 * `MAX_FACT_LENGTH` long. The query is cut first, so a long query never loses
 * its domain.
 */
const buildSearchQuery = (query: string, domain: string | undefined): string => {
  if (domain === undefined) return truncateFact(query);
  const suffix = truncateWithMarker(` site:${domain}`, MAX_FACT_LENGTH - 2);
  return `${truncateWithMarker(query, MAX_FACT_LENGTH - suffix.length)}${suffix}`;
};

/**
 * The fields of a tool call known so far. A call arrives in pieces, and a field
 * a piece leaves out keeps its last value, so a field here may be unknown.
 */
export type ToolCallFields = {
  readonly [Field in keyof ToolCall]?: ToolCall[Field] | undefined;
} & {
  readonly toolCallId: string;
};

/** The kind and detail of the item an Antigravity tool call is shown as. */
interface ToolItem {
  readonly kind: ItemKind;
  readonly detail: Schema.Json;
}

/**
 * The kind and detail of the approval Request for a tool call, a union with one
 * member per request kind so that a `kind` always comes with its own `detail`.
 */
export type ApprovalDescription = ApprovalRequest extends infer Request
  ? Request extends ApprovalRequest
    ? { readonly kind: Request["kind"]; readonly detail: Request["detail"] }
    : never
  : never;

/** The prefix Antigravity puts before the name of every tool of the MCP Gateway. */
const MCP_GATEWAY_TOOL_PREFIX = "mcp_tools_";

/**
 * The item kinds of Antigravity's own tools, by tool name. A name not listed
 * here is an MCP tool or a `tool_call` of kind `native`. Only the table's own
 * keys count, so a tool named like an object method, such as `constructor`, is
 * still a `tool_call`.
 */
const TOOL_KINDS: Readonly<Record<string, ItemKind>> = {
  run_command: "command_execution",
  edit_file: "file_change",
  write_file: "file_change",
  read_file: "file_read",
  search_web: "web_search",
  invoke_subagent: "subagent",
};

/**
 * Antigravity writes this above every command's output, so a reader cannot
 * tell where the command's own output begins. The pattern matches the lines
 * from `Created At` to `Command output:`, or to `No output from the command.`
 * when the command printed nothing. The `Created At` and `Completed At` pair
 * is repeated in a transcript step, so the pattern accepts one or more pairs. It applies at the start of the text, or
 * after the notice that Antigravity cut a long output, which comes first and
 * ends with `output truncated:`.
 */
const COMMAND_OUTPUT_HEADER =
  /(^|output truncated:\n)(?:Created At: [^\n]*\nCompleted At: [^\n]*\n)+(?:Command exited with code [^\n]*\n)?\n?(?:Command output:\n|No output from the command\.)/;

const readRecord = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

/** Returns the string field `key` of `record`, or `undefined` when it is missing, not a string, or empty. */
const readText = (record: Readonly<Record<string, unknown>>, key: string): string | undefined => {
  const value = record[key];
  return typeof value === "string" && value !== "" ? value : undefined;
};

/** Returns the tool's name, or an empty string when the call has none. */
const readToolName = (call: ToolCallFields): string => call.name ?? "";

/**
 * Returns the command's output and exit code from a command's `rawOutput`.
 *
 * The output is Antigravity's text without its header, and with `\n` for the
 * command's own `\r\n` line ends. It is `undefined` when the command printed
 * nothing, or when the call has no output yet. Text that does not have the
 * header is kept whole, because dropping unknown text would lose output. The
 * exit code is absent for a command that was stopped.
 */
const readCommandResult = (
  rawOutput: unknown,
): { readonly output?: string; readonly exitCode?: number } => {
  const record = readRecord(rawOutput);
  const text = readText(record, "output");
  const output =
    text === undefined
      ? undefined
      : text.replace(COMMAND_OUTPUT_HEADER, "$1").replaceAll("\r\n", "\n");
  const exitCode = record["exit_code"];
  return {
    ...(output === undefined || output === "" ? {} : { output }),
    ...(typeof exitCode === "number" && Number.isInteger(exitCode) ? { exitCode } : {}),
  };
};

/**
 * Splits `mcp_tools_<server>__<tool>` into the MCP Server and the tool, as the
 * gateway rule of spec 06 section 6.3 asks. Returns `undefined` for any other
 * name, and for a gateway name with no server part or no tool part.
 */
const splitMcpToolName = (
  name: string,
): { readonly server: string; readonly tool: string } | undefined =>
  name.startsWith(MCP_GATEWAY_TOOL_PREFIX)
    ? splitGatewayToolName(name.slice(MCP_GATEWAY_TOOL_PREFIX.length))
    : undefined;

/**
 * Returns the item kind and detail for `call`, built from the fields the call
 * has so far. Called again with the merged fields when the call completes, so
 * its detail then holds the output.
 *
 * - `run_command`: `command` (`CommandLine`), `description` (`toolSummary`),
 *   and, once the command has completed, `content` (the output) and `exitCode`.
 * - `edit_file` and `write_file`: `path`, whole, or the tool's name when the
 *   call has no usable path.
 * - `read_file`: `path`.
 * - `search_web`: `query`, followed by ` site:<domain>` when the call has a
 *   `domain`. The item's detail has no field for a domain, and the search
 *   operator says what the call did.
 * - `invoke_subagent`: `description` (the call's `Role`) and an empty
 *   `subagentIds`, because Antigravity gives a subagent no id.
 * - `mcp_tools_<server>__<tool>`: `{ server, name, kind: "mcp" }`. The call's
 *   arguments are not read: they belong to an outside server.
 * - Any other tool: `{ name, kind: "native" }`.
 */
export const buildToolItem = (call: ToolCallFields): ToolItem => {
  const name = readToolName(call);
  const input = readRecord(call.rawInput);
  const kind = Object.hasOwn(TOOL_KINDS, name) ? TOOL_KINDS[name]! : undefined;

  switch (kind) {
    case "command_execution": {
      const command = readText(input, "CommandLine");
      const summary = readText(input, "toolSummary");
      const { output, exitCode } = readCommandResult(call.rawOutput);
      return {
        kind,
        detail: {
          ...(command === undefined ? {} : { command: truncateMessage(command) }),
          ...(summary === undefined ? {} : { description: truncateMessage(summary) }),
          ...(output === undefined ? {} : { content: truncateMessage(output) }),
          ...(exitCode === undefined ? {} : { exitCode }),
        },
      };
    }
    case "file_change": {
      const path = readText(input, "Path");
      const fields = path === undefined ? undefined : buildEditedPathFields([path]);
      return {
        kind,
        detail: fields ?? (name === "" ? {} : { name: truncateFact(name) }),
      };
    }
    case "file_read": {
      const path = readText(input, "Path");
      return { kind, detail: path === undefined ? {} : { path: truncateFact(path) } };
    }
    case "web_search": {
      const query = readText(input, "query");
      const domain = readText(input, "domain");
      if (query === undefined) return { kind, detail: {} };
      return {
        kind,
        detail: { query: buildSearchQuery(query, domain) },
      };
    }
    case "subagent": {
      const role = readText(input, "Role");
      return {
        kind,
        detail: {
          ...(role === undefined ? {} : { description: truncateMessage(role) }),
          subagentIds: [],
        },
      };
    }
    default: {
      const mcp = splitMcpToolName(name);
      if (mcp !== undefined) {
        return {
          kind: "tool_call",
          detail: { server: truncateFact(mcp.server), name: truncateFact(mcp.tool), kind: "mcp" },
        };
      }
      return {
        kind: "tool_call",
        detail: { ...(name === "" ? {} : { name: truncateFact(name) }), kind: "native" },
      };
    }
  }
};

/**
 * Returns the item kind and detail for a call that failed. It is
 * `buildToolItem(call)` plus `detail.content`, the reason the call failed:
 * Antigravity sends it as the `rawOutput` text, repeated in the first text
 * entry of `content`, for example "tool call denied by pre-tool hook: <reason>".
 * Without it the user would see a failed item and no cause. Claude Code puts a
 * failed tool's result text in `detail.content` the same way. An output the
 * call already has (a command's own output) is kept, and the reason is left out.
 * A call with no text gets the same item as `buildToolItem`.
 */
export const buildFailedToolItem = (call: ToolCallFields): ToolItem => {
  const item = buildToolItem(call);
  const firstText = call.content?.find((entry) => entry.content?.type === "text")?.content;
  const reason = typeof call.rawOutput === "string" ? call.rawOutput : firstText?.text;
  if (reason == null || reason === "") return item;
  return {
    kind: item.kind,
    detail: { content: truncateMessage(reason), ...readRecord(item.detail) },
  };
};

/**
 * Returns the kind and detail of the approval Request for `call`. The Request's
 * kind follows the item's kind, so the transcript and the approval card never
 * disagree: a command asks `command_approval`, a file write
 * `file_change_approval`, a file read `file_read_approval`, and any other tool
 * `tool_approval`. The command, paths and tool name are cut to the bounds of
 * the protocol.
 */
export const buildApprovalDescription = (call: ToolCallFields): ApprovalDescription => {
  const { kind } = buildToolItem(call);
  const input = readRecord(call.rawInput);
  const path = readText(input, "Path");
  switch (kind) {
    case "command_execution":
      return {
        kind: "command_approval",
        detail: { command: truncateMessage(readText(input, "CommandLine") ?? "") },
      };
    case "file_change":
      return {
        kind: "file_change_approval",
        detail: { paths: path === undefined ? [] : [truncateFact(path)] },
      };
    case "file_read":
      return {
        kind: "file_read_approval",
        detail: { paths: path === undefined ? [] : [truncateFact(path)] },
      };
    default:
      return {
        kind: "tool_approval",
        detail: { toolName: truncateFact(readToolName(call) || call.title || "unknown tool") },
      };
  }
};
