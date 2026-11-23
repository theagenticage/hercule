/**
 * The web app's side of the dialogs that write a server added by URL (see
 * `url-server-flows.ts` in client-core): how this app's query cache holds the
 * servers, and the hook each dialog uses for its attempt.
 */
import { useMemo, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { HerculeClient } from "@hercule/client-core";
import {
  buildMcpListQuery,
  findOrCreateMcpUrlServerFlows,
  type McpUrlServerFlows,
  type UrlServerFlowState,
} from "@hercule/client-core/mcp-servers";
import { mcpServerQuery, mcpServersQuery } from "./queries";

/** What a dialog opens its attempt for. */
export type UrlServerFlowSubject =
  | { readonly kind: "add" }
  /** The token form of the server `mcpServerId`, named `name`. */
  | { readonly kind: "token"; readonly mcpServerId: string; readonly name: string };

/** What a dialog gets from `useUrlServerFlow`: the state of its attempt and the calls that drive it. */
export interface UrlServerFlow {
  readonly state: UrlServerFlowState;
  readonly submitAdd: (fields: {
    readonly address: string;
    readonly typedName: string | null;
  }) => void;
  readonly submitToken: (token: string) => void;
  /** Starts the sign-in through the browser. The web app cannot catch the browser's return, so the user pastes it (`finishSignInByPaste`). */
  readonly startSignIn: () => void;
  readonly finishSignInByPaste: (pasted: string) => void;
  readonly cancelSignIn: () => void;
  readonly retryRead: () => void;
  /** Checks the followed server again and reads it again. Resolves to the controller's reason when it refused the check, or `null`. */
  readonly checkNow: () => Promise<string | null>;
}

/** What a dialog shows before its attempt has opened, which is the first render only. */
const NOT_OPENED: UrlServerFlowState = { kind: "form", problem: null };

/**
 * Builds the external store of one dialog's attempt. The attempt opens when
 * the dialog subscribes and closes when it unsubscribes, so it lives exactly
 * as long as the mounted dialog, and a development double mount opens a
 * second one instead of reusing a closed one.
 */
const buildAttemptStore = (flows: McpUrlServerFlows, subject: UrlServerFlowSubject) => {
  let attemptId: string | null = null;
  return {
    subscribe: (listener: () => void): (() => void) => {
      const id =
        subject.kind === "add"
          ? flows.openAdd()
          : flows.openToken(subject.mcpServerId, subject.name);
      attemptId = id;
      const stop = flows.subscribe(listener);
      // The snapshot changes from "not opened" to the new attempt's state.
      listener();
      return () => {
        stop();
        flows.close(id);
        attemptId = null;
      };
    },
    readState: (): UrlServerFlowState =>
      attemptId === null ? NOT_OPENED : flows.readState(attemptId),
    submitAdd: (fields: { readonly address: string; readonly typedName: string | null }): void => {
      if (attemptId !== null) flows.submitAdd(attemptId, fields);
    },
    submitToken: (token: string): void => {
      if (attemptId !== null) flows.submitToken(attemptId, token);
    },
    startSignIn: (): void => {
      if (attemptId !== null) void flows.startSignIn(attemptId);
    },
    finishSignInByPaste: (pasted: string): void => {
      if (attemptId !== null) void flows.finishSignInByPaste(attemptId, pasted);
    },
    cancelSignIn: (): void => {
      if (attemptId !== null) flows.cancelSignIn(attemptId);
    },
    retryRead: (): void => {
      if (attemptId !== null) flows.retryRead(attemptId);
    },
    checkNow: (): Promise<string | null> =>
      attemptId === null ? Promise.resolve(null) : flows.checkNow(attemptId),
  };
};

/**
 * Opens an attempt for `subject` while the dialog that calls it is mounted,
 * and closes it when the dialog goes. Closing detaches the dialog from a
 * write that still runs: the server stays, and the reply never reaches a
 * dialog opened later.
 */
export function useUrlServerFlow(
  client: HerculeClient,
  subject: UrlServerFlowSubject,
): UrlServerFlow {
  const queryClient = useQueryClient();
  const flows = findOrCreateMcpUrlServerFlows({
    queryClient,
    client,
    cache: {
      readServers: () => queryClient.getQueryData(mcpServersQuery(client).queryKey)?.items,
      readCatalogue: () => buildMcpListQuery(queryClient, mcpServersQuery(client)),
      readServerQuery: (mcpServerId) => ({
        queryKey: mcpServerQuery(client, mcpServerId).queryKey,
        queryFn: () => client.mcpServer.read({ params: { id: mcpServerId } }),
      }),
    },
  });
  const key = JSON.stringify(subject);
  const store = useMemo(
    () => buildAttemptStore(flows, JSON.parse(key) as UrlServerFlowSubject),
    [flows, key],
  );
  const state = useSyncExternalStore(store.subscribe, store.readState);
  return {
    state,
    submitAdd: store.submitAdd,
    submitToken: store.submitToken,
    startSignIn: store.startSignIn,
    finishSignInByPaste: store.finishSignInByPaste,
    cancelSignIn: store.cancelSignIn,
    retryRead: store.retryRead,
    checkNow: store.checkNow,
  };
}
