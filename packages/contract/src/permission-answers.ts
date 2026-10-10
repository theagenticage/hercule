/**
 * The words of the answers to a Permission Request: the label of each
 * outcome, and the sentence describing what answering with it does. The
 * Requests dock in the session view and the `core.permission-request`
 * decision in the notification center both use them, so an answer reads the
 * same wherever it is given.
 */
import type { Grant } from "./grants";
import type { PermissionDecisionOutcome } from "./groups/permission";

/** The label of each Permission Request answer. */
export const PERMISSION_ANSWER_LABELS: Readonly<Record<PermissionDecisionOutcome, string>> = {
  session: "This session only",
  profile: "Add to profile",
  deny: "Deny",
};

/**
 * Returns a sentence describing what deciding a request for `grant` with
 * `outcome` does, such as "Adds task.delete to the profile worker; every
 * session on it gains the grant." `profileName` is the name of the asking
 * session's profile.
 */
export const describePermissionAnswer = (
  outcome: PermissionDecisionOutcome,
  grant: Grant,
  profileName: string,
): string => {
  switch (outcome) {
    case "session":
      return `Lets this session use ${grant}; other sessions still ask.`;
    case "profile":
      return `Adds ${grant} to the profile ${profileName}; every session on it gains the grant.`;
    case "deny":
      return `Refuses ${grant}; the agent is told and continues.`;
  }
};
