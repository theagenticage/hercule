/**
 * Builds the approval notification the core raises when a session's harness
 * waits for an approval: a `core.approval` decision notification whose
 * answers are the decisions the request accepts, each bound to
 * `session.respond`.
 *
 * The session service finds the notification again by the request subject
 * and the answer ids built here. When the user answers in the session view,
 * the service resolves the notification with the answer whose id matches the
 * decision sent.
 *
 * A `question` request raises no notification: `session.respond` sends a
 * decision, not answers to questions, so no answer could be bound to it.
 */
import {
  APPROVAL_ANSWER_LABELS,
  describeApprovalAnswer,
  type NotificationSubject,
} from "@hercule/contract";
import type { ApprovalDecision, OpenRequest } from "@hercule/protocol";
import type { CoreAction, CoreNotification } from "../notifications";
import type { RequestEvent } from "./stream";

/**
 * The id of the approval notification's answer that sends each decision. Ids
 * are kebab-case, so `allow_always` becomes `allow-always`.
 */
export const APPROVAL_ANSWER_IDS: Readonly<Record<ApprovalDecision, string>> = {
  allow: "allow",
  allow_always: "allow-always",
  deny: "deny",
  cancel: "cancel",
};

/** The longest command or path a title shows. The body holds the whole text. */
const MAX_TITLE_TEXT_LENGTH = 80;

/**
 * The most paths the body lists. The rest are counted in a last line.
 *
 * The limit keeps the body under the 64 KB notification body limit, so the
 * body is never cut in the middle of a path. A path is at most 512
 * characters and each of its two fences at most 513, so a line is at most
 * about 1.5 KB, and twenty lines stay far below 64 KB. A command needs no
 * such limit: it is at most 4096 characters, so its code block stays far
 * below 64 KB even with fences as long as the command.
 */
const MAX_LISTED_PATHS = 20;

/** Why a notification is withdrawn when its session ends while the request waits. */
export const WITHDRAW_REASON_SESSION_ENDED = "The session ended before the request was answered.";

/** Why a notification is withdrawn when the user interrupts the turn that asked. */
const WITHDRAW_REASON_TURN_INTERRUPTED =
  "The turn was interrupted before the request was answered.";

/** Why a notification is withdrawn when the user stops the session that asked. */
const WITHDRAW_REASON_SESSION_STOPPED = "The session was stopped before the request was answered.";

/**
 * How the user ended a session's wait on a request some other way than
 * answering it: by interrupting the turn, or by stopping the session.
 */
export type WaitEndedBy = "interrupted" | "stopped";

/**
 * Returns the subject that names one request of one session. The approval
 * notification is about this subject, so it can be resolved or withdrawn
 * without touching any other notification about the session.
 */
export const buildRequestSubject = (sessionId: string, requestId: string): NotificationSubject => ({
  kind: "request",
  sessionId,
  requestId,
});

/**
 * Shortens text to its first line and at most `MAX_TITLE_TEXT_LENGTH`
 * characters, ending it with an ellipsis when anything was left out, so a
 * title stays one short line.
 */
const shortenForTitle = (text: string): string => {
  const [first = ""] = text.split("\n");
  const cut = first.length > MAX_TITLE_TEXT_LENGTH || first.length < text.length;
  return cut ? `${first.slice(0, MAX_TITLE_TEXT_LENGTH - 1)}…` : first;
};

/**
 * Returns a run of backticks one longer than the longest run in `text`, and
 * at least `minimum` long. Used as a code fence, it cannot be closed early by
 * backticks inside the text.
 */
const buildFence = (text: string, minimum: number): string => {
  const longestRun = (text.match(/`+/g) ?? []).reduce((most, run) => Math.max(most, run.length), 0);
  return "`".repeat(Math.max(minimum, longestRun + 1));
};

/** Wraps text in a markdown code block. */
const formatCodeBlock = (text: string): string => {
  const fence = buildFence(text, 3);
  return `${fence}\n${text}\n${fence}`;
};

/**
 * Formats paths as a markdown list, one path per line, each as inline code.
 * Lists at most `MAX_LISTED_PATHS` paths, and ends with a line that counts
 * the rest.
 *
 * The spaces inside the fence keep a path that starts or ends with a backtick
 * apart from the fence; markdown drops them when it renders the path.
 */
const formatPathList = (paths: ReadonlyArray<string>): string => {
  const lines = paths.slice(0, MAX_LISTED_PATHS).map((path) => {
    const fence = buildFence(path, 1);
    return `- ${fence} ${path} ${fence}`;
  });
  const unlisted = paths.length - lines.length;
  return unlisted === 0
    ? lines.join("\n")
    : [...lines, `- and ${String(unlisted)} more`].join("\n");
};

/**
 * Returns the title of an approval request, and the detail text that shows
 * exactly what the harness asks about. Returns `undefined` for a `question`
 * request, which raises no notification.
 */
const buildRequestTitleAndDetail = (
  request: OpenRequest,
): { readonly title: string; readonly detail: string | undefined } | undefined => {
  switch (request.kind) {
    case "command_approval":
      return {
        title: `Run \`${shortenForTitle(request.detail.command)}\`?`,
        detail: formatCodeBlock(request.detail.command),
      };
    case "file_change_approval":
    case "file_read_approval": {
      const verb = request.kind === "file_change_approval" ? "Change" : "Read";
      const { paths } = request.detail;
      const [only] = paths;
      if (paths.length === 1 && only !== undefined) {
        return { title: `${verb} ${shortenForTitle(only)}?`, detail: formatPathList(paths) };
      }
      return {
        title: paths.length === 0 ? `${verb} files?` : `${verb} ${String(paths.length)} files?`,
        detail: paths.length === 0 ? undefined : formatPathList(paths),
      };
    }
    case "tool_approval":
      return { title: `Run ${request.detail.toolName}?`, detail: undefined };
    case "question":
      return undefined;
  }
};

/**
 * Builds the approval notification for a request a session waits on, or
 * returns `undefined` for a `question` request, which raises none.
 *
 * The answers are the decisions the request accepts, in the request's order.
 * Each answer has the same label and the same sentence under it as the
 * permission card in the session view, so an answer reads the same wherever
 * it is given. A request that cannot keep a rule leaves out `allow_always`,
 * so an answer the harness would refuse is never offered. No answer is
 * primary: the permission card gives no answer more weight either.
 */
export const buildApprovalNotification = (
  session: { readonly id: string; readonly title: string },
  request: OpenRequest,
): CoreNotification | undefined => {
  const described = buildRequestTitleAndDetail(request);
  if (described === undefined) return undefined;
  const waiting =
    session.title === ""
      ? "A session is waiting for your answer."
      : `The session "${session.title}" is waiting for your answer.`;
  const actions = request.decisions.map((decision): CoreAction => ({
    id: APPROVAL_ANSWER_IDS[decision],
    label: APPROVAL_ANSWER_LABELS[decision],
    description: describeApprovalAnswer(decision, request.kind),
    operation: {
      op: "session.respond",
      input: { sessionId: session.id, requestId: request.requestId, decision },
    },
  }));
  return {
    kind: "core.approval",
    title: described.title,
    body: described.detail === undefined ? waiting : `${waiting}\n\n${described.detail}`,
    subject: [
      { kind: "session", id: session.id },
      buildRequestSubject(session.id, request.requestId),
    ],
    actions,
  };
};

/**
 * Returns why an approval notification is withdrawn when a reported event
 * closes or replaces the request it asks about.
 *
 * An answer given through the controller has already resolved the
 * notification by the time the harness reports the request as resolved. So
 * the `request.resolved` reason is used only when the harness settled the
 * request some other way.
 */
export const buildWithdrawReason = (event: RequestEvent): string => {
  switch (event._tag) {
    case "request.opened":
      return "The harness asked something else before this request was answered.";
    case "request.resolved":
      return "The harness settled the request without this answer.";
    case "turn.completed":
      return "The turn ended before the request was answered.";
    case "session.exited":
      return WITHDRAW_REASON_SESSION_ENDED;
  }
};

/** Returns why an approval notification is withdrawn when the user ended the wait. */
export const buildWaitEndedWithdrawReason = (endedBy: WaitEndedBy): string =>
  endedBy === "interrupted" ? WITHDRAW_REASON_TURN_INTERRUPTED : WITHDRAW_REASON_SESSION_STOPPED;
