/**
 * Builds the decision notification the core raises when a session asks for a
 * grant: a `core.permission-request` notification whose three answers are
 * the outcomes of `permission.decide`, each bound to that operation.
 *
 * The Permission Request use case finds the notification again by the
 * request's subject. When the user decides in the session view, the use case
 * resolves the notification with the answer whose id is the outcome.
 */
import {
  PERMISSION_ANSWER_LABELS,
  PERMISSION_DECISION_OUTCOMES,
  describePermissionAnswer,
  type BoundOperation,
  type Grant,
  type NotificationSubject,
} from "@hercule/contract";
import {
  formatCodeBlock,
  formatInlineCode,
  shortenForTitle,
  type CoreAction,
  type CoreNotification,
} from "../notifications";

/** What the notification shows about the request and the session that asks. */
export interface PermissionRequestNotificationInput {
  readonly requestId: string;
  readonly sessionId: string;
  /** The session's title, or the empty string when it has none yet. */
  readonly sessionTitle: string;
  /** The name of the Agent the session was spawned from, or undefined for a Thread. */
  readonly agentName: string | undefined;
  /** The name of the session's permission profile, which the `profile` answer widens. */
  readonly profileName: string;
  readonly grant: Grant;
  readonly reason: string;
  readonly operation: BoundOperation | undefined;
}

/**
 * Returns the subject that names one Permission Request. The request's
 * notification is about this subject, so it can be decided or withdrawn
 * without touching any other notification about the session.
 */
export const buildPermissionRequestSubject = (requestId: string): NotificationSubject => ({
  kind: "permissionRequest",
  id: requestId,
});

/**
 * Builds the `core.permission-request` notification for a request.
 *
 * - The title names the session by its title, or by its Agent when it has no
 *   title yet, and the grant it asks for.
 * - The body names the session, its Agent and its profile, then shows the
 *   reason and, when the session sent one, the call it wanted to make.
 * - Every name, the reason and the call are text a user or an agent wrote,
 *   so they are shown as inline code or code blocks and cannot add a link or
 *   an image to the title or the body.
 * - The call's input is compact JSON. The reason is at most 2000 characters
 *   and a bound input at most 16 KB of compact JSON, so the body stays far
 *   below its 64 KB limit. Indented JSON would not: deeply nested input
 *   grows by its indentation on every line.
 * - The answers are `session`, `profile` and `deny`, in that order, with the
 *   same labels and sentences as the Requests dock in the session view. No
 *   answer is primary, because the dock gives none more weight either.
 */
export const buildPermissionRequestNotification = (
  input: PermissionRequestNotificationInput,
): CoreNotification => {
  const asker =
    input.sessionTitle !== ""
      ? formatInlineCode(shortenForTitle(input.sessionTitle))
      : input.agentName !== undefined
        ? formatInlineCode(shortenForTitle(input.agentName))
        : "A session";
  const session =
    input.sessionTitle === "" ? "A session" : `The session ${formatInlineCode(input.sessionTitle)}`;
  const agent = input.agentName === undefined ? "" : ` of ${formatInlineCode(input.agentName)}`;
  const intro =
    `${session}${agent} asks for \`${input.grant}\`, which its permission profile ` +
    `${formatInlineCode(input.profileName)} does not grant. Its reason:`;
  const call =
    input.operation === undefined
      ? []
      : [
          `It wants to run \`${input.operation.op}\` with:`,
          formatCodeBlock(JSON.stringify(input.operation.input)),
        ];
  const actions = PERMISSION_DECISION_OUTCOMES.map((outcome): CoreAction => ({
    id: outcome,
    label: PERMISSION_ANSWER_LABELS[outcome],
    description: describePermissionAnswer(outcome, input.grant, input.profileName),
    operation: { op: "permission.decide", input: { requestId: input.requestId, outcome } },
  }));
  return {
    kind: "core.permission-request",
    title: `${asker} asks for \`${input.grant}\``,
    body: [intro, formatCodeBlock(input.reason), ...call].join("\n\n"),
    subject: [
      { kind: "session", id: input.sessionId },
      buildPermissionRequestSubject(input.requestId),
    ],
    actions,
  };
};
