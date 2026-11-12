/**
 * The reply drafts: the words typed into the reply box of an Inbox answer.
 * One draft belongs to one answer of one signal, so a box that closes and
 * opens again (the user moved to another row and came back) gives its words
 * back. The drafts live in memory for the life of the window, in the account
 * scope (`account-scope.ts`), so the next user never sees them. A reply that
 * was sent keeps its draft, so Undo can open the box again with its words.
 */

export interface ReplyDrafts {
  /** Returns the draft of the answer `actionId` of the signal `signalId`, or "" when there is none. */
  readonly read: (signalId: string, actionId: string) => string;
  /** Keeps `text` as that answer's draft. Empty text removes the draft. */
  readonly write: (signalId: string, actionId: string, text: string) => void;
  /** Removes every draft. */
  readonly clear: () => void;
}

/** Creates an empty set of reply drafts. */
export const createReplyDrafts = (): ReplyDrafts => {
  const drafts = new Map<string, string>();
  // JSON keeps two different pairs from sharing a key, whatever characters the ids hold.
  const buildKey = (signalId: string, actionId: string): string =>
    JSON.stringify([signalId, actionId]);
  return {
    read: (signalId, actionId) => drafts.get(buildKey(signalId, actionId)) ?? "",
    write: (signalId, actionId, text) => {
      if (text === "") drafts.delete(buildKey(signalId, actionId));
      else drafts.set(buildKey(signalId, actionId), text);
    },
    clear: () => drafts.clear(),
  };
};
