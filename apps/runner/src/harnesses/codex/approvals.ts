/**
 * The requests the app-server sends to this client during a turn, mapped to
 * Hercule's requests: what the user is shown, and what each of the four
 * decisions, or the answers to a question, send back to Codex. The mapping is
 * one table because getting it right is the whole job here: a reply in a shape
 * Codex does not accept leaves the turn hanging forever, with no error
 * anywhere.
 *
 * Three mappings are approximate, because Codex cannot express everything
 * Hercule offers:
 *
 * - A permissions request has no decision enum, so a deny is an empty grant.
 * - An MCP elicitation has no "accept for this session", so `allow_always` is
 *   not offered.
 * - A question's reply has no way to decline, so the cancel an interrupt
 *   sends is a JSON-RPC error reply.
 */
import {
  MCP_GATEWAY_ENTRY_NAME,
  type ApprovalDecision,
  type ApprovalRequest,
  type OpenRequest,
  type QuestionAnswers,
} from "@hercule/protocol";
import { ensureId } from "../events";
import { buildQuestionRequest, keyAnswersForVendor } from "../questions";
import { truncateFact, truncateMessage } from "../text";
import type { RpcReply } from "./rpc";
import type {
  CommandExecutionRequestApprovalParams,
  CommandExecutionRequestApprovalResponse,
  FileChangeApprovalDecision,
  FileChangeRequestApprovalParams,
  FileChangeRequestApprovalResponse,
  GrantedPermissionProfile,
  McpServerElicitationRequestParams,
  McpServerElicitationRequestResponse,
  PermissionsRequestApprovalParams,
  PermissionsRequestApprovalResponse,
  RequestPermissionProfile,
  ToolRequestUserInputParams,
  ToolRequestUserInputResponse,
} from "./types";

/** An MCP tool call item that Codex has started and not yet completed. */
export interface RunningMcpCall {
  readonly itemId: string;
  readonly turnId: string;
  /** The MCP server's name, as in Codex's `mcpToolCall` item. */
  readonly server: string;
  readonly tool: string;
}

/** What the adapter knows about an arriving request that is not in the request's params. */
export interface Arrival {
  readonly requestId: string;
  /** The thread the request arrived on. Some requests have no other id to be filed under. */
  readonly threadId: string;
  /** Returns the paths of a file change item. A file change request does not include them. */
  readonly paths: (itemId: string) => ReadonlyArray<string>;
  /** Returns the MCP tool call items of the thread that are running in this turn. */
  readonly listRunningMcpCalls: (turnId: string) => ReadonlyArray<RunningMcpCall>;
}

export interface Asked {
  /** Builds the request that surfaces show to the user. */
  readonly opens: (params: unknown, arrival: Arrival) => OpenRequest;
  /**
   * Builds the reply sent to Codex for a decision. Only a decision the row
   * offers is passed here, with one exception: an interrupt cancels a request
   * even when its row offers no cancel, and the permissions row replies to
   * that cancel as it does to a deny.
   */
  readonly replies: (decision: ApprovalDecision, params: unknown) => RpcReply;
  /**
   * Builds the reply sent to Codex for the user's answers to a question. Only
   * the row whose requests can be questions has it.
   */
  readonly answers?: (answers: QuestionAnswers, params: unknown) => RpcReply;
  /** The decisions Codex's reply cannot express, so the adapter interrupts the turn instead. */
  readonly endsTurn: ReadonlyArray<ApprovalDecision>;
  /** Checks whether the request asks about an item that already runs. Absent when it never can. */
  readonly asksAboutRunningItem?: (params: unknown) => boolean;
}

/**
 * Builds one row of the table, typed against its own params type. The codec
 * hands over params as `unknown`; the cast narrows them here, once, rather
 * than in each of the five rows.
 */
const buildAsked = <P>(row: {
  readonly opens: (params: P, arrival: Arrival) => OpenRequest;
  readonly replies: (decision: ApprovalDecision, params: P) => RpcReply;
  readonly answers?: (answers: QuestionAnswers, params: P) => RpcReply;
  readonly endsTurn?: ReadonlyArray<ApprovalDecision>;
  readonly asksAboutRunningItem?: (params: P) => boolean;
}): Asked => ({ endsTurn: [], ...row }) as Asked;

type Decisions = ApprovalRequest["decisions"];

const EVERY_ANSWER: Decisions = ["allow", "allow_always", "deny", "cancel"];

/**
 * Both Codex approval enums have the same four decisions. The command enum
 * also has policy-amendment variants that Hercule never sends, so the narrower
 * file change type works for both.
 */
const APPROVED: Readonly<Record<ApprovalDecision, FileChangeApprovalDecision>> = {
  allow: "accept",
  allow_always: "acceptForSession",
  deny: "decline",
  cancel: "cancel",
};

/** The standard JSON-RPC internal error code, used here to decline a request. */
const INTERNAL_ERROR = -32603;

const DECLINED: RpcReply = { error: { code: INTERNAL_ERROR, message: "declined by the user" } };

/**
 * Converts the requested permission profile into a grant of exactly that
 * profile. A part the request left `null` was not asked for, so it is left out
 * of the grant.
 */
const buildGrantedProfile = ({
  network,
  fileSystem,
}: RequestPermissionProfile): GrantedPermissionProfile => ({
  ...(network === null ? {} : { network }),
  ...(fileSystem === null ? {} : { fileSystem }),
});

/** A constant, because an elicitation whose server has no name is labelled with this method. */
const ELICITATION = "mcpServer/elicitation/request";

/**
 * Reads the `_meta` of an MCP elicitation that asks to run a tool. Returns
 * `undefined` for any other elicitation, such as a server asking for a form.
 * `toolName` is `undefined` when Codex does not name the tool: the oldest
 * Codex Hercule supports sends no `tool_name`, and names the tool only in the
 * `message` text, which is not parsed.
 */
const readToolCallMeta = (
  params: McpServerElicitationRequestParams,
): { readonly toolName: string | undefined } | undefined => {
  const meta = params._meta;
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return undefined;
  if (meta["codex_approval_kind"] !== "mcp_tool_call") return undefined;
  const tool = meta["tool_name"];
  return { toolName: typeof tool === "string" ? tool : undefined };
};

/**
 * Returns the name an MCP elicitation is shown under. A question about a tool
 * call through the MCP Gateway is shown as the tool the model sees,
 * `mcp__<server>__<tool>`, the same name Claude Code's approval shows for an
 * MCP tool. The gateway is the one server for which that joined name is
 * unambiguous: the tool's name already holds the MCP Server behind it, and a
 * repository's own server named `tools__sentry` with a tool `whoami` would
 * otherwise look the same. A call to any other server is shown as
 * `<server>/<tool>`, as its item is. Any other elicitation, and a tool call
 * whose tool Codex does not name, is shown as its server, and a server with
 * an empty name as the request method.
 */
const buildElicitationToolName = (params: McpServerElicitationRequestParams): string => {
  const toolName = readToolCallMeta(params)?.toolName;
  if (toolName !== undefined) {
    return truncateFact(
      params.serverName === MCP_GATEWAY_ENTRY_NAME
        ? `mcp__${params.serverName}__${toolName}`
        : `${params.serverName}/${toolName}`,
    );
  }
  return params.serverName === "" ? ELICITATION : truncateFact(params.serverName);
};

/**
 * Returns the id the elicitation is filed under. A question about a tool call
 * belongs to that call's item when it is the one running call of the turn that
 * matches the question: the same MCP server, and the same tool when Codex
 * names it. The client marks the item a request names as awaiting approval.
 *
 * With no match, or with several, the question is filed under its turn (or
 * the thread, when it has no turn): guessing would mark the wrong item. Any
 * other elicitation belongs to no item and is filed the same way.
 */
const findElicitationItemId = (
  params: McpServerElicitationRequestParams,
  arrival: Arrival,
): string => {
  const toolCall = readToolCallMeta(params);
  if (toolCall !== undefined && params.turnId !== null) {
    const matches = arrival
      .listRunningMcpCalls(params.turnId)
      .filter(
        (call) =>
          call.server === params.serverName &&
          (toolCall.toolName === undefined || call.tool === toolCall.toolName),
      );
    if (matches.length === 1) return ensureId(matches[0]!.itemId);
  }
  return ensureId(params.turnId ?? arrival.threadId);
};

/**
 * The tool name shown when a question request has no questions that can be
 * parsed, and is shown as a tool approval instead.
 */
const USER_INPUT_TOOL = "requestUserInput";

/**
 * Every server-to-client request this build handles, by method. The adapter
 * replies `-32601` (method not found) to any other method. That is still a
 * reply: a request with no reply is the one failure nobody upstream can see.
 */
export const ASKED: Readonly<Record<string, Asked>> = {
  "item/commandExecution/requestApproval": buildAsked<CommandExecutionRequestApprovalParams>({
    opens: (params, { requestId }) => ({
      requestId,
      itemId: ensureId(params.itemId),
      kind: "command_approval",
      decisions: EVERY_ANSWER,
      // If Codex sends no command, the card shows an empty command. That is
      // still an accurate report of what Codex asked.
      detail: { command: truncateMessage(params.command ?? "") },
    }),
    replies: (decision) => ({
      result: { decision: APPROVED[decision] } satisfies CommandExecutionRequestApprovalResponse,
    }),
    // Codex gives an approval its own id only when it belongs to a command
    // that already runs: input written to it, or a subcommand it starts.
    asksAboutRunningItem: (params) => params.approvalId != null,
  }),

  "item/fileChange/requestApproval": buildAsked<FileChangeRequestApprovalParams>({
    opens: (params, { requestId, paths }) => ({
      requestId,
      itemId: ensureId(params.itemId),
      kind: "file_change_approval",
      decisions: EVERY_ANSWER,
      detail: { paths: paths(params.itemId) },
    }),
    replies: (decision) => ({
      result: { decision: APPROVED[decision] } satisfies FileChangeRequestApprovalResponse,
    }),
  }),

  "item/permissions/requestApproval": buildAsked<PermissionsRequestApprovalParams>({
    opens: (params, { requestId }) => ({
      requestId,
      itemId: ensureId(params.itemId),
      kind: "tool_approval",
      // The reply is a grant, not a decision, so it cannot express a cancel.
      // Offering a cancel button would mean inventing a way to stop.
      decisions: ["allow", "allow_always", "deny"],
      detail: { toolName: "permissions" },
    }),
    // A deny is the empty grant and nothing else. Codex ends the turn itself
    // after an empty grant, so a `turn/interrupt` from here would race it.
    replies: (decision, params) => ({
      result: {
        permissions:
          decision === "allow" || decision === "allow_always"
            ? buildGrantedProfile(params.permissions)
            : {},
        scope: decision === "allow_always" ? "session" : "turn",
      } satisfies PermissionsRequestApprovalResponse,
    }),
  }),

  [ELICITATION]: buildAsked<McpServerElicitationRequestParams>({
    opens: (params, arrival) => ({
      requestId: arrival.requestId,
      itemId: findElicitationItemId(params, arrival),
      kind: "tool_approval",
      // The reply has no "accept for this session", so `allow_always` is not
      // offered: the adapter would have to replace it with something else.
      decisions: ["allow", "deny", "cancel"],
      detail: { toolName: buildElicitationToolName(params) },
    }),
    replies: (decision) => ({
      result: {
        // Only the three decisions this row offers are passed here.
        action: decision === "allow" ? "accept" : decision === "deny" ? "decline" : "cancel",
        // Filling in a server's form is not supported yet, so an accept sends
        // the user's consent and no form content.
        content: null,
        _meta: null,
      } satisfies McpServerElicitationRequestResponse,
    }),
  }),

  "item/tool/requestUserInput": buildAsked<ToolRequestUserInputParams>({
    opens: (params, { requestId }) =>
      buildQuestionRequest(
        { requestId, itemId: ensureId(params.itemId) },
        USER_INPUT_TOOL,
        params.questions,
        "id",
      ),
    // A question takes no decision, so only two decisions reach this: the
    // cancel an interrupt sends, and a deny or cancel of the tool approval
    // shown when no question could be parsed. The reply has no way to
    // decline, so each is an error, and a cancel also interrupts the turn.
    replies: () => DECLINED,
    answers: (answers, params) => ({
      result: {
        answers: Object.fromEntries(
          [...keyAnswersForVendor(answers, params.questions, "id")].map(([id, picks]) => [
            id,
            { answers: [...picks] },
          ]),
        ),
      } satisfies ToolRequestUserInputResponse,
    }),
    endsTurn: ["cancel"],
  }),
};
