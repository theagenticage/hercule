/**
 * What a session is told about Discussions when it starts: the Discussions'
 * part of the coordination paragraph (spec 19 section 7.1). The controller
 * daemon puts it together with the other parts.
 */
import type { Grant } from "@hercule/contract";

const DISCUSSION_TEXT =
  "Other agent sessions may work on the same repositories as you, at the same time. " +
  "When one of them edits a file you edited, Hercule tells you and puts you both in a discussion: " +
  "read it and agree there who changes what. Nothing is ever locked. " +
  "List a repository's discussions with `hercule discussion list --resource <id>`.";

/**
 * Returns what Discussions tell a session holding `grants`: how it meets the
 * other sessions on its repositories. Returns `undefined` for a session
 * without `discussion.read`, which is told nothing about Discussions.
 */
export const describeDiscussionsToSession = (
  grants: ReadonlySet<Grant>,
): { readonly text: string } | undefined =>
  grants.has("discussion.read") ? { text: DISCUSSION_TEXT } : undefined;
