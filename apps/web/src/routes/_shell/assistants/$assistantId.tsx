import type { JSX } from "react";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { findWebConversation, isNotFound, resolveDisplayTimezone } from "@hercule/client-core";
import type { Conversation } from "@hercule/contract";
import { EmptyState } from "@hercule/ui";
import {
  assistantQuery,
  conversationMessagesQuery,
  conversationsQuery,
  currentConversationSessionQuery,
  settingsQuery,
} from "../../../app/queries";
import { ConversationScreen } from "../../../screens/assistant/conversation-screen";
import { HomeLink, NOT_FOUND_HEADLINE } from "../../../screens/fallbacks";

/**
 * An assistant's conversation screen. The screen draws its own header with the assistant's
 * name, so the shell's top bar is hidden here.
 *
 * The address names the assistant, not its conversation: the user opens an
 * assistant, and the address stays the same when more channels give it more
 * conversations. The loader finds the web conversation, then fetches its
 * newest messages and its current session, so the first paint shows the
 * conversation as it is rather than an empty column.
 */
export const Route = createFileRoute("/_shell/assistants/$assistantId")({
  staticData: { title: "Assistant", ownsTopBar: true },
  loader: async ({ context: { client, queryClient }, params }) => {
    const [, conversations] = await Promise.all([
      queryClient
        .ensureQueryData(assistantQuery(client, params.assistantId))
        .catch((error: unknown) => {
          // A link to an assistant that was deleted, or never existed, shows
          // the not-found screen instead of a load error.
          throw isNotFound(error) ? notFound() : error;
        }),
      queryClient.ensureQueryData(conversationsQuery(client, params.assistantId)),
    ]);
    const conversationId = readWebConversationId(conversations.items);
    await Promise.all([
      queryClient.ensureInfiniteQueryData(conversationMessagesQuery(client, conversationId)),
      queryClient.ensureQueryData(currentConversationSessionQuery(client, conversationId)),
    ]);
  },
  component: AssistantRoute,
  notFoundComponent: MissingAssistant,
});

function AssistantRoute(): JSX.Element {
  const { client, live } = Route.useRouteContext();
  const { assistantId } = Route.useParams();
  const conversations = useSuspenseQuery(conversationsQuery(client, assistantId)).data;
  const settings = useSuspenseQuery(settingsQuery(client)).data;

  // Keyed by the assistant, so moving to another assistant's conversation
  // starts with an empty composer and at the bottom of the new conversation.
  return (
    <ConversationScreen
      key={assistantId}
      client={client}
      live={live}
      assistantId={assistantId}
      conversationId={readWebConversationId(conversations.items)}
      timezone={resolveDisplayTimezone(settings.user.timezone)}
    />
  );
}

/**
 * Returns the id of the assistant's web conversation, and fails when there is
 * none. Every assistant gets its web conversation in the same write that
 * creates it, so a missing one is a broken record, not an empty conversation,
 * and the user sees the failure screen rather than a composer that cannot
 * send.
 */
const readWebConversationId = (items: readonly Conversation[]): string => {
  const web = findWebConversation(items);
  if (web === null) throw new Error("This assistant has no web conversation.");
  return web.id;
};

/** Renders the page for an assistant id that the controller does not have. */
function MissingAssistant(): JSX.Element {
  return (
    <EmptyState headline={NOT_FOUND_HEADLINE} lead="There is no assistant with this id.">
      <HomeLink />
    </EmptyState>
  );
}
