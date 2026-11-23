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
  type McpServerSwitchTarget,
} from "@hercule/client-core/mcp-servers";
import { mcpServerQuery, mcpServersQuery } from "./queries";

/** What a switch control gets from `useMcpServerSwitch`. */
export interface McpServerSwitch {
  /** Switches the server on or off, creating it when it has no record yet. Does nothing while `blocked`. */
  readonly press: (on: boolean) => void;
  /** Whether a write of the switch runs, started by any control, or the list could not be read again after one. */
  readonly blocked: boolean;
  /** Returns why the last press made no change, or that a saved change could not be read again, or `null`. */
  readonly problem: string | null;
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
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const queryClient = useQueryClient();
  const switches = findOrCreateMcpServerSwitches({
    queryClient,
    client,
    cache: {
      readServers: () => queryClient.getQueryData(mcpServersQuery(client).queryKey),
      readCatalogue: () => buildMcpListQuery(queryClient, mcpServersQuery(client)),
      readPageKey: (serverId) => mcpServerQuery(client, serverId).queryKey,
    },
  });
  const state = useSyncExternalStore(switches.subscribe, () => switches.readState(target));
  // A refusal stays while a control shows the target, and expires some time after the last one left.
  const key = JSON.stringify(target);
  useEffect(() => {
    const mine = JSON.parse(key) as McpServerSwitchTarget;
    return switches.attach(mine);
  }, [switches, key]);
  return {
    press: (on) => {
      switches.apply(target, on, existingRecordId);
    },
    blocked: state.blocked,
    problem: describeMcpListProblem(state),
  };
}
