/**
 * How a change to a thread's list of MCP servers is made: a started thread
 * writes `session.update` at once, a Draft Thread keeps its list with its
 * other unsent picks. What the thread knows of its servers is
 * `ThreadServersProvider`'s; this file loads with the submenu and the picker,
 * never with the first screen.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import type { DraftView, ThreadChoice } from "@hercule/client-core";
import { decideDraftServersPick, type McpListChoice } from "@hercule/client-core/mcp-servers";
import type { Session } from "@hercule/contract";
import { buildMcpListCache, useMcpListEdit } from "../../app/mcp-list-edits";
import { useThreadServers } from "./thread-servers";

/**
 * How the menu and the picker change the thread's list. A change goes
 * through `apply`, which hands the user's choice to the rules that resolve it
 * against the list as it is when the change is made, so a switch is never
 * applied to a list drawn earlier.
 */
export interface ThreadServerEdits {
  /** Applies the user's choice to the thread's list. Does nothing while `busy`. */
  readonly apply: (choice: McpListChoice) => void;
  /** Whether a write runs or its list could not be read again, which draws the switches as off. */
  readonly busy: boolean;
  /** Why the last change was not made, such as a session without `mcp.manage`. `null` when it was. */
  readonly refusal: string | null;
  /** Forgets a settled refusal, when the user dismisses the menu or the picker that showed it. */
  readonly clearRefusal: () => void;
}

/**
 * Returns the edits of the started thread `session`. A change is an edit of
 * the thread's list (see `useMcpListEdit`): one runs at a time for the
 * thread, wherever its menu or picker was opened from, and it counts as
 * running until the session is read again, so a second switch never starts
 * from a list the first one replaced. Closing the menu or the picker keeps
 * the guard and the refusal.
 */
export function useStartedThreadEdits(session: Session): ThreadServerEdits {
  const edit = useMcpListEdit({
    kind: "thread",
    sessionId: session.id,
    projectId: session.projectId,
  });
  return {
    apply: edit.apply,
    busy: edit.blocked,
    refusal: edit.problem(),
    clearRefusal: edit.clearRefusal,
  };
}

/**
 * Returns the edits of the Draft Thread `view`. A change is passed to
 * `onChoose`, which records it with the draft's other picks, after the rules
 * a started thread uses have decided it (`decideDraftServersPick`) against
 * the servers and records the cache holds when the user presses. A draft
 * writes nothing, so it is never busy and never refuses.
 */
export function useDraftEdits({
  view,
  onChoose,
}: {
  readonly view: DraftView;
  readonly onChoose: (choice: ThreadChoice) => void;
}): ThreadServerEdits {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const queryClient = useQueryClient();
  const { described } = useThreadServers();
  const projectId = view.resolved.config.projectId ?? null;
  return {
    apply: (choice) => {
      const cache = buildMcpListCache(queryClient, client);
      const views = cache.readViews();
      if (views === undefined) return;
      const picked = decideDraftServersPick({
        projectId,
        ids: described.mcpServerIds,
        views,
        ...cache.readStartRecords(projectId),
        choice,
      });
      if (picked !== undefined) onChoose(picked);
    },
    busy: false,
    refusal: null,
    clearRefusal: () => undefined,
  };
}
