/**
 * What the app-server asks this client between turns, in the one vocabulary
 * every surface renders: which question the user sees, and what each of the
 * four answers writes back. One table, because the mapping is the whole
 * subject - a request answered in a shape Codex does not take is a turn that
 * never ends, with nothing said anywhere.
 *
 * Three answers are stretches, because the harness cannot express what Hercule
 * offers. A permissions request has no decision enum, so a refusal is an empty
 * grant; an elicitation has no for-session accept, so `allow_always` is not
 * offered; and a question has no refusal shape at all, so a refusal is a
 * JSON-RPC error reply.
 */
import type { ApprovalDecision, OpenRequest } from "@hercule/protocol";
import { idOf } from "../events";
import { questionRequest } from "../questions";
import { fact, text } from "../text";
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
} from "./types";

/** What the adapter knows when a request arrives and the request itself does not. */
export interface Arrival {
  readonly requestId: string;
  /** The thread it arrived on, which is the only id some requests can be filed under. */
  readonly threadId: string;
  /** The paths of the item a file change is about; they are not in its params. */
  readonly paths: (itemId: string) => ReadonlyArray<string>;
}

export interface Asked {
  /** The question as a surface reads it. */
  readonly opens: (params: unknown, arrival: Arrival) => OpenRequest;
  /**
   * What Codex is told. Only a decision the row offers arrives here, with one
   * exception: an interrupt cancels a park whose row offers no cancel, and the
   * permissions row answers that with its deny.
   */
  readonly replies: (decision: ApprovalDecision, params: unknown) => RpcReply;
  /** The answers Codex cannot express, so the turn is ended for it. */
  readonly endsTurn: ReadonlyArray<ApprovalDecision>;
}

/**
 * One row, written against its own params type. The cast is the codec's
 * `unknown` narrowed at the one point the method is known, and it is here
 * rather than in five row bodies.
 */
const asked = <P>(row: {
  readonly opens: (params: P, arrival: Arrival) => OpenRequest;
  readonly replies: (decision: ApprovalDecision, params: P) => RpcReply;
  readonly endsTurn?: ReadonlyArray<ApprovalDecision>;
}): Asked => ({ endsTurn: [], ...row }) as Asked;

type Decisions = OpenRequest["decisions"];

const EVERY_ANSWER: Decisions = ["allow", "allow_always", "deny", "cancel"];

/**
 * Both approval enums name the same four answers; the command one additionally
 * has policy-amendment arms Hercule never sends, so the narrower type covers both.
 */
const APPROVED: Readonly<Record<ApprovalDecision, FileChangeApprovalDecision>> = {
  allow: "accept",
  allow_always: "acceptForSession",
  deny: "decline",
  cancel: "cancel",
};

/** JSON-RPC's own: this client will not do what was asked. */
const INTERNAL_ERROR = -32603;

const DECLINED: RpcReply = { error: { code: INTERNAL_ERROR, message: "declined by the user" } };

/**
 * The profile the agent asked for, as a grant. A half the request left null is
 * a half nothing was asked for, which is the same grant as leaving it out.
 */
const granting = ({ network, fileSystem }: RequestPermissionProfile): GrantedPermissionProfile => ({
  ...(network === null ? {} : { network }),
  ...(fileSystem === null ? {} : { fileSystem }),
});

/** Named, because an elicitation that did not name its server is named after it. */
const ELICITATION = "mcpServer/elicitation/request";

/** What the ask is called where nothing decodable was asked through it. */
const USER_INPUT_TOOL = "requestUserInput";

/**
 * Every server-to-client request this build maps, by method. A method not in
 * here is answered `-32601` by the adapter, which is an answer: an unanswered
 * request is the one failure nobody upstream can see.
 */
export const ASKED: Readonly<Record<string, Asked>> = {
  "item/commandExecution/requestApproval": asked<CommandExecutionRequestApprovalParams>({
    opens: (params, { requestId }) => ({
      requestId,
      itemId: idOf(params.itemId),
      kind: "command_approval",
      decisions: EVERY_ANSWER,
      // A command the harness did not name leaves the card with nothing to
      // read, which is still the honest report of what it asked.
      detail: { command: text(params.command ?? "") },
    }),
    replies: (decision) => ({
      result: { decision: APPROVED[decision] } satisfies CommandExecutionRequestApprovalResponse,
    }),
  }),

  "item/fileChange/requestApproval": asked<FileChangeRequestApprovalParams>({
    opens: (params, { requestId, paths }) => ({
      requestId,
      itemId: idOf(params.itemId),
      kind: "file_change_approval",
      decisions: EVERY_ANSWER,
      detail: { paths: paths(params.itemId) },
    }),
    replies: (decision) => ({
      result: { decision: APPROVED[decision] } satisfies FileChangeRequestApprovalResponse,
    }),
  }),

  "item/permissions/requestApproval": asked<PermissionsRequestApprovalParams>({
    opens: (params, { requestId }) => ({
      requestId,
      itemId: idOf(params.itemId),
      kind: "tool_approval",
      // The answer is a grant, not a decision, so there is no cancel in it: a
      // button for one would be a stop this adapter would have to invent.
      decisions: ["allow", "allow_always", "deny"],
      detail: { toolName: "permissions" },
    }),
    // A refusal is the empty grant and nothing else. Codex ends the turn itself
    // after one, so a `turn/interrupt` from here would be a second, racing stop.
    replies: (decision, params) => ({
      result: {
        permissions:
          decision === "allow" || decision === "allow_always" ? granting(params.permissions) : {},
        scope: decision === "allow_always" ? "session" : "turn",
      } satisfies PermissionsRequestApprovalResponse,
    }),
  }),

  [ELICITATION]: asked<McpServerElicitationRequestParams>({
    opens: (params, { requestId, threadId }) => ({
      requestId,
      // An elicitation is about no item, so it is filed under the turn it
      // interrupted, and under the thread where the server could not name one.
      itemId: idOf(params.turnId ?? threadId),
      kind: "tool_approval",
      // The answer has no for-session accept, so offering one would be offering
      // an answer this adapter would have to substitute for.
      decisions: ["allow", "deny", "cancel"],
      // A server that did not name itself is named by what it asked through.
      detail: { toolName: params.serverName === "" ? ELICITATION : fact(params.serverName) },
    }),
    replies: (decision) => ({
      result: {
        // Only the three answers the row offers ever arrive here.
        action: decision === "allow" ? "accept" : decision === "deny" ? "decline" : "cancel",
        // Answering a server's form is not built, so an accept carries the
        // user's assent and nothing they filled in.
        content: null,
        _meta: null,
      } satisfies McpServerElicitationRequestResponse,
    }),
  }),

  "item/tool/requestUserInput": asked<ToolRequestUserInputParams>({
    opens: (params, { requestId }) =>
      questionRequest(
        { requestId, itemId: idOf(params.itemId) },
        USER_INPUT_TOOL,
        params.questions,
      ),
    // Answering with content is not built, and the answer shape has no refusal
    // in it, so the only thing this client can say is that it will not answer.
    replies: () => DECLINED,
    endsTurn: ["cancel"],
  }),
};
