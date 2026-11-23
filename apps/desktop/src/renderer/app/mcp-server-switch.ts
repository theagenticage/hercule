/**
 * The desktop app's side of the switch of an MCP server (see
 * `server-switch.ts` in client-core): how this app's query cache holds the
 * servers, and the hook the switch of a row and the switch of a server's page
 * use.
 */
import { useEffect, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import {
  buildMcpListQuery,
  describeMcpListProblem,
  findOrCreateMcpServerSwitches,
  readMcpServerOffers,
  type McpServerSwitchPress,
  type McpServerSwitchTarget,
  type McpServerSwitches,
  type ReplaceProgress,
} from "@hercule/client-core/mcp-servers";
import { mcpServerQuery, mcpServersQuery, pluginsQuery } from "./queries";

/** What a switch control gets from `useMcpServerSwitch`. */
export interface McpServerSwitch {
  /**
   * Switches the server on or off, creating it when it has no record yet.
   * Does nothing while `blocked`. Returns `replace` with the servers added by
   * URL on the offer's address when switching it on would create a second
   * server for it: nothing was written, and the control asks which one to
   * replace.
   */
  readonly press: (on: boolean) => McpServerSwitchPress;
  /** Moves the server added by URL `serverId` onto this plugin target, switched on, with one write. Does nothing for a target that is not a plugin's. */
  readonly replace: (serverId: string) => void;
  /** Forgets the Replace's refusal. A dialog calls it when it closes. */
  readonly clearReplace: () => void;
  /** Whether a write of the switch runs, started by any control, or the list could not be read again after one. */
  readonly blocked: boolean;
  /** Returns why the last press made no change, or that a saved change could not be read again, or `null`. */
  readonly problem: string | null;
}

/** Returns the switches of this app's query client, over this app's shapes of the cache. */
function useMcpServerSwitches(): McpServerSwitches {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const queryClient = useQueryClient();
  return findOrCreateMcpServerSwitches({
    queryClient,
    client,
    cache: {
      readServers: () => queryClient.getQueryData(mcpServersQuery(client).queryKey),
      readCatalogue: () => buildMcpListQuery(queryClient, mcpServersQuery(client)),
      readOfferOrigin: (contributionId) =>
        readMcpServerOffers(queryClient.getQueryData(pluginsQuery(client).queryKey) ?? []).find(
          (offer) => offer.contributionId === contributionId,
        )?.origin,
      readPageKey: (serverId) => mcpServerQuery(client, serverId).queryKey,
    },
  });
}

/**
 * Returns the switch of `target`, shared by every control of the app that
 * switches it. The guard and the refusal belong to the target, not to the
 * control, so a row and the page of the same server never write at once. The
 * refusal stays while a control shows the target and for a while after the
 * last one is gone. A control that shows an existing record passes its id as
 * `existingRecordId`, so its press only updates that record and never creates
 * a server (see `McpServerSwitches.apply`).
 */
export function useMcpServerSwitch(
  target: McpServerSwitchTarget,
  existingRecordId?: string,
): McpServerSwitch {
  const switches = useMcpServerSwitches();
  const state = useSyncExternalStore(switches.subscribe, () => switches.readState(target));
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
    clearReplace: () => {
      switches.clearRefusal(target);
    },
    blocked: state.blocked,
    problem: describeMcpListProblem(state),
  };
}

/**
 * Returns where the Replace of `target` stands, for the Replace dialog that is
 * open: choosing, writing the server the user confirmed, replaced, or refused
 * with the server that won. It follows the switches and the list of servers
 * only, so a closed dialog and an unrelated change of the query cache cost
 * nothing. While the caller is mounted, the confirmed server is kept; after the
 * last dialog unmounts it is dropped once the write has settled.
 */
export function useReplaceProgress(target: McpServerSwitchTarget): ReplaceProgress {
  const switches = useMcpServerSwitches();
  const key = JSON.stringify(target);
  useEffect(() => {
    const mine = JSON.parse(key) as McpServerSwitchTarget;
    return switches.attachReplaceReader(mine);
  }, [switches, key]);
  return useSyncExternalStore(switches.subscribeReplaceProgress, () =>
    switches.readReplaceProgress(target),
  );
}
