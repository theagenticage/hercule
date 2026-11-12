import type { JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { inboxOutlineQuery } from "../../../app/queries";
import { isWindowVisible } from "../../../app/window-visibility";
import { InboxScreen } from "./-inbox-screen";
import { readInboxScope, validateInboxScopeParams } from "./-inbox-scope";

/**
 * The Inbox: the things that concern the user, as one list per saved query
 * with the pane beside it (spec 17 §Inbox). The route is a chunk of its own.
 * The scope the list is on (a saved query or a Browse value) is in the URL's
 * search params, so a reload and the Back button keep it.
 *
 * The loader waits for the outline, which is small and which the rail and the
 * list head draw from. The list's rows are not read here: the screen's visit
 * reads them, so it shows its loading shapes instead of holding the whole app
 * on the previous screen. A hidden window starts no read. The sidebar's
 * counts, the plugins and the user are shell data, which the shell has read
 * already and keeps current.
 */
export const Route = createFileRoute("/_connected/_shell/inbox")({
  staticData: { title: "Inbox" },
  validateSearch: validateInboxScopeParams,
  loader: async ({ context: { controller, queryClient } }) => {
    if (!isWindowVisible()) return;
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
