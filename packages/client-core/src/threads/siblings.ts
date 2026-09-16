/**
 * The thread chrome's tab strip (spec 14 §The thread surface): when the
 * workspace a thread stands in holds more than one thread, the title is the
 * active tab and its siblings sit beside it, in the workspace's own thread
 * order. A draft joining the workspace is the last tab.
 *
 * With one thread and no draft there is no strip at all: the row is the title.
 */
import type { Session, Workspace } from "@hydra/contract";
import { markOf, type ThreadMark } from "./rows";

export interface ThreadTab {
  /** Null on the draft being written, which is not a session yet. */
  readonly sessionId: string | null;
  readonly title: string;
  readonly mark: ThreadMark;
  readonly active: boolean;
}

export const siblingTabs = ({
  workspace,
  sessions,
  activeSessionId,
  draft = false,
}: {
  readonly workspace: Workspace | undefined;
  readonly sessions: readonly Session[];
  /** The thread on screen; null while the draft is the one on screen. */
  readonly activeSessionId: string | null;
  /** Whether the draft being written joins this workspace. */
  readonly draft?: boolean;
}): readonly ThreadTab[] => {
  if (workspace === undefined) return [];
  const tabs: ThreadTab[] = [];
  for (const id of workspace.sessionIds) {
    const session = sessions.find((each) => each.id === id);
    if (session === undefined) continue;
    tabs.push({
      sessionId: session.id,
      title: session.title,
      mark: markOf(session),
      active: session.id === activeSessionId,
    });
  }
  if (draft) tabs.push({ sessionId: null, title: "New thread", mark: "idle", active: true });
  return tabs.length < 2 ? [] : tabs;
};
