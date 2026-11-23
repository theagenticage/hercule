/**
 * The web app's side of the switch of an MCP server (see `server-switch.ts`
 * in client-core): how this app's query cache holds the servers, and the
 * hook the switch of a row and the switch of a server's page use.
 */
import { useEffect, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { HerculeClient } from "@hercule/client-core";
import {
  describeMcpListProblem,
  findOrCreateMcpServerSwitches,
  readMcpServerOffers,
  type McpServerSwitchPress,
  type McpServerSwitchTarget,
  type McpServerSwitches,
  type ReplaceDialogView,
} from "@hercule/client-core/mcp-servers";
import { buildMcpServerQueries } from "./mcp-server-queries";
import { pluginsQuery } from "./queries";

/** What a switch control gets from `useMcpServerSwitch`. */
export interface McpServerSwitch {
  /**
   * Switches the server on or off, creating it when it has no record yet.
   * Does nothing while `blocked`. Returns `replace` when the press wrote
   * nothing because the user must be asked first which server to replace.
   */
  readonly press: (on: boolean) => McpServerSwitchPress;
  /** Opens the Replace dialog of this plugin target, after `press` returned `replace`. `words` name the Connection in the dialog. */
  readonly openReplace: (words: {
    readonly connectionLabel: string;
    readonly typeName: string;
  }) => void;
  /** Whether a write of the switch runs, started by any control, or the list could not be read again after one. */
  readonly blocked: boolean;
  /** Returns why the last press made no change, or that a saved change could not be read again, or `null`. */
  readonly problem: string | null;
}

/** Returns the switches of this app's query client, over this app's shapes of the cache. */
function useMcpServerSwitches(client: HerculeClient): McpServerSwitches {
  const queryClient = useQueryClient();
  return findOrCreateMcpServerSwitches({
    queryClient,
    client,
    cache: {
      ...buildMcpServerQueries(queryClient, client),
      readOfferOrigin: (contributionId) =>
        readMcpServerOffers(queryClient.getQueryData(pluginsQuery(client).queryKey) ?? []).find(
          (offer) => offer.contributionId === contributionId,
        )?.origin,
    },
  });
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
  const switches = useMcpServerSwitches(client);
  const state = useSyncExternalStore(switches.subscribe, () => switches.readState(target));
  // A refusal stays while a control shows the target, and expires some time after the last one left.
  const key = JSON.stringify(target);
  useEffect(() => {
    const mine = JSON.parse(key) as McpServerSwitchTarget;
    return switches.attach(mine);
  }, [switches, key]);
  return {
    press: (on) => switches.apply(target, on, existingRecordId),
    openReplace: (words) => {
      switches.openReplace(target, words);
    },
    blocked: state.blocked,
    problem: describeMcpListProblem(state),
  };
}

/** What a Replace dialog gets from `useReplaceDialog`: what to draw, and the user's moves. */
export interface ReplaceDialog {
  /** What the dialog draws, or `null` once it is closed. */
  readonly view: ReplaceDialogView | null;
  readonly pick: (serverId: string) => void;
  readonly confirm: () => void;
  /** Reads the list of servers again, after the dialog said it could not. */
  readonly readAgain: () => void;
  /** Closes the dialog and forgets its refusal. */
  readonly close: () => void;
}

/**
 * Returns the Replace dialog of `target` that `openReplace` opened. It follows
 * the switches and the list of servers only, so a closed dialog and an
 * unrelated change of the query cache cost nothing.
 */
export function useReplaceDialog(
  client: HerculeClient,
  target: McpServerSwitchTarget,
): ReplaceDialog {
  const switches = useMcpServerSwitches(client);
  const view = useSyncExternalStore(switches.subscribeReplaceDialog, () =>
    switches.readReplaceDialog(target),
  );
  return {
    view,
    pick: (serverId) => {
      switches.pickReplaceServer(target, serverId);
    },
    confirm: () => {
      switches.confirmReplace(target);
    },
    readAgain: () => {
      switches.readReplaceListAgain(target);
    },
    close: () => {
      switches.closeReplace(target);
    },
  };
}
