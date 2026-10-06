/**
 * What the shell exchanges with main about destinations, the threads and
 * assistants main can ask the page to open: the waiting Requests the shell
 * sends for the dock badge and the notifications, and the hook that opens
 * the destination main names.
 */
import { useCallback } from "react";
import { useMatch, useNavigate, useRouteContext } from "@tanstack/react-router";
import { decideThreadPose, isSeatedPose, type Waiting } from "@hercule/client-core";
import type { Destination, WaitingRequest } from "../../../ipc/contract";
import { runnersQuery, threadsQuery } from "../../app/queries";

/**
 * Returns what main is sent of an entry of Waiting on you: where its
 * notification opens, its Request, and the title and question the
 * notification shows. An assistant's notification is titled with its name.
 */
export const buildWaitingRequest = (waiting: Waiting): WaitingRequest => {
  switch (waiting.kind) {
    case "thread":
      return {
        destination: { kind: "thread", sessionId: waiting.sessionId },
        requestId: waiting.requestId,
        title: waiting.title,
        question: waiting.question,
      };
    case "assistant":
      return {
        destination: { kind: "assistant", assistantId: waiting.assistantId },
        requestId: waiting.requestId,
        title: waiting.name,
        question: waiting.question,
      };
  }
};

/**
 * Returns a function that opens a destination main names, from the Go menu
 * or a notification:
 *
 * - a thread opens in the Office's drawer while the Office is open and the
 *   thread has a colleague there, as its sidebar row does, and on its own
 *   screen otherwise;
 * - an assistant opens on its own screen, where its Request is answered. It
 *   has no colleague in the Office, so this holds while the Office is open
 *   too.
 *
 * The thread and its runner are read from the cache when the thread is
 * opened, so the function keeps its identity while the threads change.
 */
export function useOpenDestination(): (destination: Destination) => void {
  const { controller, queryClient } = useRouteContext({ from: "/_connected/_shell" });
  const navigate = useNavigate();
  const officeOpen =
    useMatch({ from: "/_connected/_shell/office", shouldThrow: false }) !== undefined;
  return useCallback(
    (destination: Destination) => {
      switch (destination.kind) {
        case "thread": {
          const { sessionId } = destination;
          const { client } = controller;
          const session = queryClient
            .getQueryData(threadsQuery(client).queryKey)
            ?.find((each) => each.id === sessionId);
          const runner = queryClient
            .getQueryData(runnersQuery(client).queryKey)
            ?.find((each) => each.id === session?.runnerId);
          if (
            officeOpen &&
            session !== undefined &&
            isSeatedPose(decideThreadPose(session, runner))
          ) {
            void navigate({ to: "/office", search: { session: sessionId } });
          } else {
            void navigate({ to: "/threads/$sessionId", params: { sessionId } });
          }
          return;
        }
        case "assistant":
          void navigate({
            to: "/assistants/$assistantId",
            params: { assistantId: destination.assistantId },
          });
          return;
      }
    },
    [controller, navigate, officeOpen, queryClient],
  );
}
