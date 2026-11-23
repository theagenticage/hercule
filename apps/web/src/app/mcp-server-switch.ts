/**
 * The web app's side of the switch of an MCP server (see `server-switch.ts`
 * in client-core): how this app's query cache holds the servers, and the
 * hook the switch of a row and the switch of a server's page use.
 */
import { useEffect, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { HerculeClient } from "@hercule/client-core";
import {
  buildMcpListQuery,
  describeMcpListProblem,
  findOrCreateMcpServerSwitches,
  readMcpServerOffers,
  type McpServerSwitchPress,
  type McpServerSwitchTarget,
  type ReplaceProgress,
} from "@hercule/client-core/mcp-servers";
import { mcpServerQuery, mcpServersQuery, pluginsQuery } from "./queries";

/** What a switch control gets from `useMcpServerSwitch`. */
export interface McpServerSwitch {
  /**
   * Switches the server on or off, creating it when it has no record yet.
   * Does nothing while `blocked`. Returns `replace` with the servers added by
   * URL on the offer's address when the press wrote nothing because the user
   * must choose which one to replace first.
   */
  readonly press: (on: boolean) => McpServerSwitchPress;
  /** Moves the server added by URL `serverId` onto this target's Connection, and switches it on. */
  readonly replace: (serverId: string) => void;
  /**
   * Where the Replace of this target stands: choosing, writing the server the
   * user confirmed, replaced, or refused with the server that won. It follows
   * the switches and the servers in the cache.
   */
  readonly replaceProgress: ReplaceProgress;
  /** Forgets the confirmed Replace and its refusal. A dialog calls it when it closes. */
  readonly clearReplace: () => void;
  /** Whether a write of the switch runs, started by any control, or the list could not be read again after one. */
  readonly blocked: boolean;
  /** Returns why the last press made no change, or that a saved change could not be read again, or `null`. */
  readonly problem: string | null;
}

/**
 * Returns the switch of `target`, shared by every control of the app that
 * switches it. The guard and the refusal belong to the target, not to the
 * control, so a row and the page of the same server never write at once. A
 * control that shows an existing record passes its id as `existingRecordId`,
 * so its press only updates that record and never creates a server (see
 * `McpServerSwitches.apply`).
 */
export function useMcpServerSwitch(
  client: HerculeClient,
  target: McpServerSwitchTarget,
  existingRecordId?: string,
): McpServerSwitch {
  const queryClient = useQueryClient();
  const switches = findOrCreateMcpServerSwitches({
    queryClient,
    client,
    cache: {
      readServers: () => queryClient.getQueryData(mcpServersQuery(client).queryKey)?.items,
      readCatalogue: () => buildMcpListQuery(queryClient, mcpServersQuery(client)),
      readOfferOrigin: (contributionId) =>
        readMcpServerOffers(queryClient.getQueryData(pluginsQuery(client).queryKey) ?? []).find(
          (offer) => offer.contributionId === contributionId,
        )?.origin,
      readPageKey: (serverId) => mcpServerQuery(client, serverId).queryKey,
    },
  });
  const state = useSyncExternalStore(switches.subscribe, () => switches.readState(target));
  // The progress reads the servers the cache holds now, so it follows the cache as well as the
  // switches. `useSyncExternalStore` needs a snapshot that is equal while nothing changed, so
  // the snapshot is the progress written as text.
  const subscribeToProgress = (listener: () => void): (() => void) => {
    const stopSwitches = switches.subscribe(listener);
    const stopCache = queryClient.getQueryCache().subscribe(listener);
    return () => {
      stopSwitches();
      stopCache();
    };
  };
  const replaceProgress = JSON.parse(
    useSyncExternalStore(subscribeToProgress, () =>
      JSON.stringify(switches.readReplaceProgress(target)),
    ),
  ) as ReplaceProgress;
  // A refusal stays while a control shows the target, and expires some time after the last one left.
  const key = JSON.stringify(target);
  useEffect(() => {
    const mine = JSON.parse(key) as McpServerSwitchTarget;
    return switches.attach(mine);
  }, [switches, key]);
  return {
    press: (on) => switches.apply(target, on, existingRecordId),
    replace: (serverId) => {
      switches.replace(target, serverId);
    },
    replaceProgress,
    clearReplace: () => {
      switches.clearRefusal(target);
    },
    blocked: state.blocked,
    problem: describeMcpListProblem(state),
  };
}
