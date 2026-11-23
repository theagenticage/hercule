/**
 * The desktop app's side of the dialogs that write a server added by URL (see
 * `url-server-flows.ts` in client-core): how this app's query cache holds the
 * servers, and the hook the Add by URL dialog and the token dialog use.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { isWebLink, readErrorMessage } from "@hercule/client-core";
import {
  buildMcpListQuery,
  findOrCreateMcpUrlServerFlows,
  type BrowserSignInPort,
  type McpUrlServerFlows,
  type UrlServerFlowState,
} from "@hercule/client-core/mcp-servers";
import type { Bridge } from "../../ipc/bridge";
import { mcpServerQuery, mcpServersQuery } from "./queries";

/**
 * Returns the port through which the attempts catch the browser's return,
 * over the main process's `signInReturn` channels and its `link.open`. Main
 * opens only web addresses, so the port refuses any other with a reason.
 */
const buildBrowserSignInPort = (bridge: Bridge): BrowserSignInPort => ({
  listen: async () => {
    const outcome = await bridge.signInReturn.listen();
    return outcome._tag === "listening"
      ? { kind: "listening", listenerId: outcome.listenerId, redirectUri: outcome.redirectUri }
      : { kind: "unavailable" };
  },
  wait: async (listenerId, authorizationUrl) => {
    const outcome = await bridge.signInReturn.wait({ listenerId, authorizationUrl });
    return outcome._tag === "received"
      ? { kind: "received", callbackQuery: outcome.callbackQuery }
      : { kind: outcome._tag };
  },
  cancel: (listenerId) => bridge.signInReturn.cancel({ listenerId }),
  open: (url) =>
    isWebLink(url)
      ? bridge.link.open({ url })
      : Promise.reject(new Error(`The sign-in page is not a web address: ${url}`)),
});

/** What a dialog opens an attempt for: a new server, or the token of the server `mcpServerId`, named `name`. */
export type UrlServerAttemptTarget =
  | { readonly kind: "add" }
  | { readonly kind: "token"; readonly mcpServerId: string; readonly name: string };

/**
 * Holds the id of a dialog's attempt, which the dialog's effect opens and
 * closes, so that React Strict Mode's second run of the effect opens a new
 * attempt instead of reusing one that was closed. It is a small store the
 * dialog reads with `useSyncExternalStore`.
 */
const createAttemptSlot = () => {
  let id: string | null = null;
  const listeners = new Set<() => void>();
  return {
    read: (): string | null => id,
    set: (next: string | null): void => {
      id = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};

/** What a dialog shows before its attempt has opened, which is one render: the empty form. */
const UNOPENED: UrlServerFlowState = { kind: "form", problem: null };

/** What `useUrlServerAttempt` returns. */
export interface UrlServerAttempt {
  readonly flows: McpUrlServerFlows;
  /** The attempt's id, or `null` until the dialog's first effect has opened it. */
  readonly attemptId: string | null;
  readonly state: UrlServerFlowState;
}

/**
 * Returns the attempt of a dialog that writes a server added by URL, opened
 * when the dialog mounts and closed when it unmounts. One attempt belongs to
 * one opening of the dialog, so a reply to an earlier opening never reaches a
 * later one. The attempts are shared by the app (one instance for each query
 * client), so a write that still runs after the dialog closed is finished
 * by the same module.
 */
export function useUrlServerAttempt(target: UrlServerAttemptTarget): UrlServerAttempt {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const { bridge } = useRouteContext({ from: "__root__" });
  const queryClient = useQueryClient();
  const flows = findOrCreateMcpUrlServerFlows({
    queryClient,
    client,
    browserSignIn: buildBrowserSignInPort(bridge),
    cache: {
      readServers: () => queryClient.getQueryData(mcpServersQuery(client).queryKey),
      readCatalogue: () => buildMcpListQuery(queryClient, mcpServersQuery(client)),
      readServerQuery: (mcpServerId) => {
        const { queryKey } = mcpServerQuery(client, mcpServerId);
        return { queryKey, queryFn: () => client.mcpServer.read({ params: { id: mcpServerId } }) };
      },
    },
  });
  const [slot] = useState(createAttemptSlot);
  const attemptId = useSyncExternalStore(slot.subscribe, slot.read);
  // Strings, not the target object, which is a new object on every render.
  const mcpServerId = target.kind === "token" ? target.mcpServerId : null;
  const name = target.kind === "token" ? target.name : null;
  useEffect(() => {
    const id =
      mcpServerId === null || name === null ? flows.openAdd() : flows.openToken(mcpServerId, name);
    slot.set(id);
    return () => {
      flows.close(id);
      slot.set(null);
    };
  }, [flows, slot, mcpServerId, name]);
  const state = useSyncExternalStore(flows.subscribe, () =>
    attemptId === null ? UNOPENED : flows.readState(attemptId),
  );
  return { flows, attemptId, state };
}

/** What a dialog calls to drive the sign-in through the browser of its attempt. */
export interface SignInActions {
  /** Starts the sign-in, or starts it again after a refusal. */
  readonly onStartSignIn: () => void;
  /** Ends the sign-in and returns the dialog to its form. */
  readonly onCancelSignIn: () => void;
  /** Opens the sign-in page in the browser again. */
  readonly onOpenSignInPage: () => void;
  /** Finishes the sign-in with the address the user pasted. */
  readonly onFinishSignIn: (pasted: string) => void;
}

/** Returns the calls that drive the sign-in of the attempt `attemptId`, which do nothing while it is `null`. */
export const buildSignInActions = (
  flows: McpUrlServerFlows,
  attemptId: string | null,
): SignInActions => ({
  onStartSignIn: () => {
    if (attemptId !== null) void flows.startSignIn(attemptId);
  },
  onCancelSignIn: () => {
    if (attemptId !== null) flows.cancelSignIn(attemptId);
  },
  onOpenSignInPage: () => {
    if (attemptId !== null) void flows.openSignInPageAgain(attemptId);
  },
  onFinishSignIn: (pasted) => {
    if (attemptId !== null) void flows.finishSignInByPaste(attemptId, pasted);
  },
});

/** What `useCheckNow` returns. */
export interface CheckNow {
  /** Asks the controller to check the server `mcpServerId` again. Does nothing while a check was asked for and the answer is not in. */
  readonly run: (mcpServerId: string) => void;
  readonly busy: boolean;
  /** Why the controller refused the check, or `null`. */
  readonly error: string | null;
}

/**
 * Returns "Check now" for a dialog that follows a server. The result of the
 * check arrives on the `mcpServer` topic; the list and the server's read are
 * read again here so the dialog's attempt, which observes that read, sees the
 * status `checking` at once.
 */
export function useCheckNow(): CheckNow {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const queryClient = useQueryClient();
  const check = useMutation({
    mutationFn: (mcpServerId: string) => client.mcpServer.check({ params: { id: mcpServerId } }),
    onSettled: async (_result, _error, mcpServerId) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: mcpServersQuery(client).queryKey, exact: true }),
        queryClient.invalidateQueries({
          queryKey: mcpServerQuery(client, mcpServerId).queryKey,
          exact: true,
        }),
      ]);
    },
  });
  return {
    run: (mcpServerId) => {
      if (!check.isPending) check.mutate(mcpServerId);
    },
    busy: check.isPending,
    error: check.error === null ? null : readErrorMessage(check.error),
  };
}
