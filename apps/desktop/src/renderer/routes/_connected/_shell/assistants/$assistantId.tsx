import type { JSX } from "react";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { queryKeys } from "@hercule/client-core";
import {
  assistantsQuery,
  conversationMessagesQuery,
  currentConversationSessionQuery,
  runnersQuery,
  runningTurnQuery,
} from "../../../../app/queries";
import { AssistantNotFound, AssistantScreen } from "../../../../screens/assistant/assistant-screen";

/**
 * The page of one assistant: its face, name and pose, over its Conversation.
 *
 * Its loader reads every assistant, finds this one, and reads the current
 * session of its main conversation, from which the pose is drawn. The live
 * connection keeps those reads current, so the shell's own reads are usually
 * what it finds. The loader then reads the newest page of the Conversation's
 * messages and, when a session has started, the rows of its running turn.
 * When no assistant has the id, the route shows `AssistantNotFound`. Any
 * other failure shows `RenderFailure`, the router's default.
 *
 * Leaving the page drops the messages and the running turn's rows. Only the
 * open Conversation keeps them current, so the cache would otherwise hold
 * them out of date, and every page the user scrolled back through.
 */
export const Route = createFileRoute("/_connected/_shell/assistants/$assistantId")({
  staticData: { title: "Assistant" },
  loader: async ({ context: { controller, queryClient }, params: { assistantId } }) => {
    const { client } = controller;
    const [assistants] = await Promise.all([
      queryClient.ensureQueryData(assistantsQuery(client)),
      queryClient.ensureQueryData(runnersQuery(client)),
    ]);
    const assistant = assistants.find((each) => each.id === assistantId);
    // The router acts on a thrown `notFound`, which is a plain descriptor
    // rather than an Error.
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    if (assistant === undefined) throw notFound();
    const conversationId = assistant.mainConversationId;
    const [session] = await Promise.all([
      queryClient.ensureQueryData(currentConversationSessionQuery(client, conversationId)),
      queryClient.ensureInfiniteQueryData(conversationMessagesQuery(client, conversationId)),
    ]);
    if (session !== null) await queryClient.ensureQueryData(runningTurnQuery(client, session.id));
  },
  onLeave: ({ context: { controller, queryClient }, params: { assistantId } }) => {
    const { client } = controller;
    const assistant = queryClient
      .getQueryData(assistantsQuery(client).queryKey)
      ?.find((each) => each.id === assistantId);
    if (assistant === undefined) return;
    const conversationId = assistant.mainConversationId;
    queryClient.removeQueries({ queryKey: queryKeys.conversationMessages(conversationId) });
    const session = queryClient.getQueryData(
      currentConversationSessionQuery(client, conversationId).queryKey,
    );
    if (session != null) queryClient.removeQueries({ queryKey: queryKeys.runningTurn(session.id) });
  },
  component: AssistantRoute,
  notFoundComponent: AssistantNotFound,
});

function AssistantRoute(): JSX.Element {
  const { assistantId } = Route.useParams();
  return <AssistantScreen assistantId={assistantId} />;
}
