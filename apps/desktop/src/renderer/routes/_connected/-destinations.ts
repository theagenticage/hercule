/**
 * What the shell exchanges with main about destinations, the threads,
 * assistants and signals main can ask the page to open: the waiting Requests the shell
 * sends for the dock badge and the notifications, and the hook that opens
 * the destination main names.
 */
import { useCallback } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { useMatch, useNavigate, useRouteContext } from "@tanstack/react-router";
import {
  decideThreadPose,
  isSessionSeated,
  type HerculeClient,
  type Waiting,
} from "@hercule/client-core";
import type { Destination, WaitingRequest } from "../../../ipc/contract";
import { runnersQuery, sessionQuery } from "../../app/queries";
import { useReadSessionPresentation } from "../../app/session-presentation";

/**
 * Returns what main is sent of an entry of Waiting on you: where its
 * notification opens, its open Requests, the newest of which the
 * notification shows, and the notification's title and text. An assistant's
 * notification is titled with its name.
 */
export const buildWaitingRequest = (waiting: Waiting): WaitingRequest => {
  const fields = {
    requestId: waiting.newestRequestId,
    openRequestIds: waiting.openRequestIds,
    body: waiting.notificationBody,
  };
  switch (waiting.kind) {
    case "session":
      return {
        destination: { kind: "thread", sessionId: waiting.sessionId },
        title: waiting.title,
        ...fields,
      };
    case "assistant":
      return {
        destination: { kind: "assistant", assistantId: waiting.assistantId },
        title: waiting.name,
        ...fields,
      };
  }
};

/**
 * Checks whether the session `sessionId` has a colleague in the Office,
 * from its own cached record and its runner, for a session the presentation
 * does not hold. Returns false when the cache holds no record of it.
 */
const isSeatedByCachedRecord = (
  queryClient: QueryClient,
  client: HerculeClient,
  sessionId: string,
): boolean => {
  const record = queryClient.getQueryData(sessionQuery(client, sessionId).queryKey);
  if (record === undefined) return false;
  const runner = queryClient
    .getQueryData(runnersQuery(client).queryKey)
    ?.find((each) => each.id === record.runnerId);
  return isSessionSeated(record, decideThreadPose(record, runner));
};

/**
 * Returns a function that opens a destination main names, from the Go menu
 * or a notification:
 *
 * - a thread, or an Agent's session, opens in the Office's drawer while the
 *   Office is open and the session has a colleague there
 *   (`SessionPresentation.seatedIds`), as its sidebar row does, and on its own
 *   screen otherwise;
 * - an assistant opens its Conversation, where its Request is answered: in
 *   the Office's drawer while the Office is open, because an assistant
 *   always has a colleague there, and on its own screen otherwise;
 * - a signal opens Intake with the signal selected.
 *
 * The seats are read when the destination is opened, so the function keeps
 * its identity while the threads change. A session the presentation does not
 * hold is asked from its own cached record and its runner.
 */
export function useOpenDestination(): (destination: Destination) => void {
  const { controller, queryClient } = useRouteContext({ from: "/_connected/_shell" });
  const navigate = useNavigate();
  const readPresentation = useReadSessionPresentation();
  const officeOpen =
    useMatch({ from: "/_connected/_shell/office", shouldThrow: false }) !== undefined;
  return useCallback(
    (destination: Destination) => {
      switch (destination.kind) {
        case "thread": {
          const { sessionId } = destination;
          const seated =
            readPresentation().seatedIds.has(sessionId) ||
            isSeatedByCachedRecord(queryClient, controller.client, sessionId);
          if (officeOpen && seated) {
            void navigate({ to: "/office", search: { session: sessionId } });
          } else {
            void navigate({ to: "/threads/$sessionId", params: { sessionId } });
          }
          return;
        }
        case "assistant": {
          const { assistantId } = destination;
          if (officeOpen) void navigate({ to: "/office", search: { assistant: assistantId } });
          else void navigate({ to: "/assistants/$assistantId", params: { assistantId } });
          return;
        }
        case "signal":
          void navigate({ to: "/intake", search: { signal: destination.signalId } });
          return;
      }
    },
    [controller, navigate, officeOpen, queryClient, readPresentation],
  );
}
