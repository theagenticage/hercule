import type { JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { EMPTY_INBOX_SEARCH } from "@hercule/client-core/inbox";
import { inboxQuery } from "../../../app/queries";
import { isWindowVisible } from "../../../app/window-visibility";
import { InboxScreen } from "./-inbox-screen";
import { DEFAULT_INBOX_SCOPE, buildInboxQuery } from "./-inbox-scope";

/**
 * The Inbox: the things that concern the user, as one list per saved query
 * with the pane beside it (spec 17 §Inbox). The route is a chunk of its own.
 *
 * The loader starts the first page of the list the screen opens on without
 * waiting for it, so the screen shows its loading shapes instead of holding
 * the whole app on the previous screen. A hidden window starts no read: the
 * list is read when the window shows. The counts, the plugins and the user
 * are shell data, which the shell has read already and keeps current.
 */
export const Route = createFileRoute("/_connected/_shell/inbox")({
  staticData: { title: "Inbox" },
  loader: ({ context: { controller, queryClient } }) => {
    if (isWindowVisible()) {
      void queryClient.prefetchQuery(
        inboxQuery(controller.client, buildInboxQuery(DEFAULT_INBOX_SCOPE, EMPTY_INBOX_SEARCH)),
      );
    }
  },
  component: InboxRoute,
});

function InboxRoute(): JSX.Element {
  const { controller } = Route.useRouteContext();
  return <InboxScreen controller={controller} />;
}
