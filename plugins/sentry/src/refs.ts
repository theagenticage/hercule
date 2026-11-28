/**
 * The External Refs this plugin gives to Sentry's things. This is the one
 * place the format lives: an event's refs, an entity's ref and a lookup all
 * build and parse them here, so a Signal and the card it belongs to always
 * name the same ref. A ref needs the organization's id, not its slug, because
 * a slug can be renamed.
 */

/** Returns the ref of an issue: `sentry:issue:<organization id>/<issue id>`. */
export const buildIssueRef = (organizationId: string, issueId: string): string =>
  `sentry:issue:${organizationId}/${issueId}`;

/** Returns the ref of a project: `sentry:project:<organization id>/<project id>`. */
export const buildProjectRef = (organizationId: string, projectId: string): string =>
  `sentry:project:${organizationId}/${projectId}`;

const ISSUE_REF_PATTERN = /^sentry:issue:(\d+)\/(\d+)$/;

/**
 * Returns the organization id and the issue id of an issue ref, or undefined
 * when `ref` is not one: another kind of ref, or an id that is not made of
 * digits.
 */
export const parseIssueRef = (
  ref: string,
): { readonly organizationId: string; readonly issueId: string } | undefined => {
  const match = ISSUE_REF_PATTERN.exec(ref);
  return match === null ? undefined : { organizationId: match[1]!, issueId: match[2]! };
};
