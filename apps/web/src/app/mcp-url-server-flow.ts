/**
 * The web app's side of the dialogs that write a server added by URL (see
 * `url-server-attempt.ts` in client-core): the hook each dialog uses to open
 * its attempt, draw it, and close it.
 */
import { useLayoutEffect, useState, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { HerculeClient } from "@hercule/client-core";
import {
  createAttemptSlot,
  openUrlServerAttempt,
  type AttemptTarget,
  type UrlServerAttempt,
  type UrlServerAttemptState,
} from "@hercule/client-core/mcp-servers";
import { buildMcpServerQueries } from "./mcp-server-queries";

/**
 * Opens the attempt of the dialog that calls it when the dialog mounts, and
 * closes it when the dialog goes. Returns the attempt, which the dialog
 * calls, and what it shows now.
 *
 * The attempt belongs to the server's id, not to its name: a rename that
 * arrives while the dialog is open changes the record, never the attempt, so a
 * sign-in in progress goes on. The first render holds an inert attempt, which
 * the layout effect replaces before the browser paints.
 */
export function useUrlServerAttempt(
  client: HerculeClient,
  target: AttemptTarget,
): { readonly attempt: UrlServerAttempt; readonly state: UrlServerAttemptState } {
  const queryClient = useQueryClient();
  const mcpServerId = target.kind === "token" ? target.mcpServerId : null;
  // The name only words a sentence before the record is read, so the one the dialog opened with serves.
  const [openedName] = useState(target.kind === "token" ? target.name : "");
  const [slot] = useState(createAttemptSlot);
  const attempt = useSyncExternalStore(slot.subscribe, slot.read);
  // A layout effect, so the unmount closes the attempt while the dialog leaves the screen: a passive
  // cleanup runs later, and a reply that lands in between would still reach the dialog.
  useLayoutEffect(() => {
    const opened = openUrlServerAttempt(
      { queryClient, client, queries: buildMcpServerQueries(queryClient, client) },
      mcpServerId === null ? { kind: "add" } : { kind: "token", mcpServerId, name: openedName },
    );
    slot.hold(opened);
    return () => {
      opened.close();
    };
  }, [queryClient, client, slot, mcpServerId, openedName]);
  const state = useSyncExternalStore(attempt.subscribe, attempt.read);
  return { attempt, state };
}
