import type { JSX } from "react";
import { createFileRoute, notFound } from "@tanstack/react-router";
import {
  assistantsQuery,
  currentConversationSessionQuery,
  runnersQuery,
} from "../../../../app/queries";
import { AssistantNotFound, AssistantScreen } from "../../../../screens/assistant/assistant-screen";

/**
 * The page of one assistant: its face, name and pose, over its Conversation.
 *
 * Its loader reads every assistant, finds this one, and reads the current
 * session of its main conversation, from which the pose is drawn. The live
 * connection keeps all three reads current, so the shell's own reads are
 * usually what it finds. When no assistant has the id, the route shows
 * `AssistantNotFound`. Any other failure shows `RenderFailure`, the router's
 * default.
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
    await queryClient.ensureQueryData(
      currentConversationSessionQuery(client, assistant.mainConversationId),
    );
  },
  component: AssistantRoute,
  notFoundComponent: AssistantNotFound,
});

function AssistantRoute(): JSX.Element {
  const { assistantId } = Route.useParams();
  return <AssistantScreen assistantId={assistantId} />;
}
