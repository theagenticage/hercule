import type { JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { AssistantNotFound, AssistantScreen } from "../../../../screens/assistant/assistant-screen";
import { throwScreenNotFound } from "../../../../app/last-screen";
import { ensureConversationData } from "../../../../app/queries";

/**
 * The page of one assistant: its face, name and pose, over its Conversation.
 *
 * Its loader reads what the Conversation draws (see `ensureConversationData`).
 * The live connection keeps those reads current, so the shell's own reads are
 * usually what it finds. When no assistant has the id, the route shows
 * `AssistantNotFound`, or goes to the new-thread screen when the app opened
 * the page at launch (see `throwScreenNotFound`). Any other failure shows
 * `RenderFailure`, the router's default.
 *
 * The Conversation drops the messages and the running turn's rows when it
 * unmounts (see `useConversationLive` and `SessionConversation`), so
 * coming back to the page reads them again.
 */
export const Route = createFileRoute("/_connected/_shell/assistants/$assistantId")({
  staticData: { title: "Assistant" },
  loader: async ({ context: { controller, queryClient }, params: { assistantId }, location }) => {
    const found = await ensureConversationData(queryClient, controller.client, assistantId);
    if (!found) throwScreenNotFound(location);
  },
  component: AssistantRoute,
  notFoundComponent: AssistantNotFound,
});

function AssistantRoute(): JSX.Element {
  const { assistantId } = Route.useParams();
  return <AssistantScreen assistantId={assistantId} />;
}
