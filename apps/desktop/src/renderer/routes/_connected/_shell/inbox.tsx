import type { JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { inboxQuery } from "../../../app/queries";
import { isWindowVisible } from "../../../app/window-visibility";

/**
 * The Inbox: the cards of External Entities that concern the user, with their
 * places (spec 17 §Inbox).
 *
 * The route is a chunk of its own. Its loader starts the Inbox's read without
 * waiting for it, so the screen shows its loading state instead of holding
 * the whole app on the previous screen. A hidden window starts no read: the
 * Inbox is read when the window shows.
 */
export const Route = createFileRoute("/_connected/_shell/inbox")({
  staticData: { title: "Inbox" },
  loader: ({ context: { controller, queryClient } }) => {
    if (isWindowVisible()) void queryClient.prefetchQuery(inboxQuery(controller.client));
  },
  component: InboxRoute,
});

/** Renders a placeholder until the Inbox screen replaces it. */
function InboxRoute(): JSX.Element {
  return <main aria-label="Inbox" />;
}
