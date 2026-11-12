import type { JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { EMPTY_INBOX_SEARCH } from "@hercule/client-core/inbox";
import { inboxOutlineQuery, inboxQuery } from "../../../app/queries";
import { isWindowVisible } from "../../../app/window-visibility";
import { InboxScreen } from "./-inbox-screen";
import { buildInboxQuery, readInboxScope, validateInboxScopeParams } from "./-inbox-scope";

/**
 * The Inbox: the things that concern the user, as one list per saved query
 * with the pane beside it (spec 17 §Inbox). The route is a chunk of its own.
 * The scope the list is on (a saved query or a Browse value) is in the URL's
 * search params, so a reload and the Back button keep it.
 *
 * The loader starts the first page of the list the URL names without waiting
 * for it, so the screen shows its loading shapes instead of holding the whole
 * app on the previous screen. The loader waits for the outline, which is small
 * and which the rail and the list head draw from. A hidden window starts no
 * read: the list is read when the window shows. The sidebar's counts, the
 * plugins and the user are shell data, which the shell has read already and
 * keeps current.
 */
export const Route = createFileRoute("/_connected/_shell/inbox")({
  staticData: { title: "Inbox" },
  validateSearch: validateInboxScopeParams,
  loaderDeps: ({ search }) => search,
  loader: async ({ context: { controller, queryClient }, deps }) => {
    if (!isWindowVisible()) return;
    void queryClient.prefetchQuery(
      inboxQuery(controller.client, buildInboxQuery(readInboxScope(deps), EMPTY_INBOX_SEARCH)),
    );
    // The rail, the search and the list head draw from the outline, so the screen waits for it.
    await queryClient.prefetchQuery(inboxOutlineQuery(controller.client));
  },
  component: InboxRoute,
});

function InboxRoute(): JSX.Element {
  const { controller } = Route.useRouteContext();
  const search = Route.useSearch();
  return <InboxScreen controller={controller} scope={readInboxScope(search)} />;
}
