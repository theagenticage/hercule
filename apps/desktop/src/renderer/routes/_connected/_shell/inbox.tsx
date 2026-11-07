import type { JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { inboxQuery } from "../../../app/queries";
import { isWindowVisible } from "../../../app/window-visibility";
import { InboxScreen } from "./-inbox-screen";

/**
 * The Inbox: the cards of External Entities that concern the user, with their
 * places (spec 17 §Inbox).
 *
 * The route is a chunk of its own. Its loader starts the Inbox's read without
 * waiting for it, so the screen shows its loading state instead of holding
 * the whole app on the previous screen. A hidden window starts no read: the
 * Inbox is read when the window shows (see `useInbox`). The plugins, the
 * Connections and the user are shell data, which the shell has read already
 * and keeps current, so the screen reads them from the cache.
 */
export const Route = createFileRoute("/_connected/_shell/inbox")({
  staticData: { title: "Inbox" },
  loader: ({ context: { controller, queryClient } }) => {
    if (isWindowVisible()) void queryClient.prefetchQuery(inboxQuery(controller.client));
  },
  component: InboxRoute,
});

function InboxRoute(): JSX.Element {
  const { controller } = Route.useRouteContext();
  return <InboxScreen controller={controller} />;
}
