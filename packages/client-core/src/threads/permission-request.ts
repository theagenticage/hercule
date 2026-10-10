/**
 * Builds what the Requests dock shows for a session's open Permission
 * Requests: which one is shown, how the user pages to the others, and all
 * the text of its card. A Permission Request is a session asking for a grant
 * its profile lacks. The agent keeps working while it is open, so it is not
 * an agent Request and nothing counts it as waiting on the user.
 *
 * The text lives here rather than in a component because no screen may drop
 * or reword the line that describes an answer: the user must see what a
 * click does, in the same words on every screen.
 */
import {
  PERMISSION_ANSWER_LABELS,
  PERMISSION_DECISION_OUTCOMES,
  describePermissionAnswer,
  type DescribeLine,
  type PermissionDecisionOutcome,
  type PermissionRequest,
} from "@hercule/contract";
import { locateShownRequest, type ShownRequest } from "./shown-request";

/** One answer row of the card, in the shape the answer ledger takes. */
export interface PermissionAnswerRow {
  /** The outcome the row sends, which also tells the rows apart. */
  readonly id: PermissionDecisionOutcome;
  readonly label: string;
  /**
   * What the answer does. Empty for "Add to profile" while the name of the
   * session's profile is not known, so the row keeps its place and nothing
   * names a profile that may be wrong.
   */
  readonly describeLine: DescribeLine;
  /**
   * Whether the answer can be given now. False for "Add to profile" while
   * the name of the session's profile is not known, because the user must
   * not widen a profile they cannot see.
   */
  readonly available: boolean;
}

/** All the text of one Permission Request's card. */
export interface PermissionRequestCard {
  /** The card's title, which the grant follows. */
  readonly title: string;
  /** The grant asked for, such as `task.delete`. Machine text, shown in mono. */
  readonly grant: string;
  /** Why the session needs the grant, in the agent's own words. */
  readonly reason: string;
  /**
   * The operation the session wanted to call, as the words before it and its
   * id, such as "Wants to call" and `task.delete`; null when it named none.
   */
  readonly operation: { readonly intro: string; readonly op: string } | null;
  /** The one-line question the shrunk dock shows, such as "Grant task.delete?". */
  readonly question: string;
  /** One row per outcome, in the contract's order: this session, the profile, deny. */
  readonly rows: readonly PermissionAnswerRow[];
}

/**
 * Returns the card for `request`. `profileName` is the name of the asking
 * session's permission profile, which the "Add to profile" answer names, or
 * null while it is not known.
 */
export const buildPermissionRequestCard = (
  request: PermissionRequest,
  profileName: string | null,
): PermissionRequestCard => ({
  title: "Grant this permission?",
  grant: request.grant,
  reason: request.reason,
  operation:
    request.operation === undefined ? null : { intro: "Wants to call", op: request.operation.op },
  question: `Grant ${request.grant}?`,
  rows: PERMISSION_DECISION_OUTCOMES.map((outcome) => {
    const available = outcome !== "profile" || profileName !== null;
    return {
      id: outcome,
      label: PERMISSION_ANSWER_LABELS[outcome],
      describeLine: available
        ? [
            {
              kind: "text",
              text: describePermissionAnswer(outcome, request.grant, profileName ?? ""),
            },
          ]
        : [],
      available,
    };
  }),
});

/**
 * Returns which of `openPermissionRequests` (oldest first) the dock shows,
 * with its place among them, or null when none is open. `shownRequestId` is
 * the request the user paged to; when it is not open, or none is named, the
 * dock shows the oldest.
 *
 * The dock shows Permission Requests only while it shows no agent Request:
 * an agent Request blocks the agent, a Permission Request does not. The
 * caller decides that by calling this only when `buildRequestDock` returns
 * null.
 */
export const buildPermissionRequestDock = (
  openPermissionRequests: readonly PermissionRequest[],
  shownRequestId: string | undefined,
): ShownRequest<PermissionRequest> | null =>
  locateShownRequest(openPermissionRequests, (request) => request.id, shownRequestId);
