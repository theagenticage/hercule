/**
 * Who has a thing of the Inbox: the one rule that the row's holder mark and the
 * sentence of a refused move both read, so they never disagree.
 */
import type { InboxThing } from "@hercule/contract";

/** The one who has a thing: a workflow that is live on it, or the user who took it on. */
export type InboxHolder =
  | { readonly kind: "colleague"; readonly workflowId: string; readonly name: string }
  | { readonly kind: "you" };

/**
 * Returns who has `thing`: its first live workflow, else the user when they
 * took the thing on, else `undefined`. A Task made by a signal or a hand-off is
 * not the user's, so it gives no holder.
 */
export const findHolder = (
  thing: Pick<InboxThing, "liveWorkflows" | "takenOn">,
): InboxHolder | undefined => {
  const [workflow] = thing.liveWorkflows;
  if (workflow !== undefined) {
    return { kind: "colleague", workflowId: workflow.workflowId, name: workflow.name };
  }
  return thing.takenOn ? { kind: "you" } : undefined;
};
