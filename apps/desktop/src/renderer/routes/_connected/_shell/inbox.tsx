import type { JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { InboxScreen } from "./-inbox-screen";

/** The Inbox: the things that concern the user (spec 17 §Inbox). The route is a chunk of its own. */
export const Route = createFileRoute("/_connected/_shell/inbox")({
  staticData: { title: "Inbox" },
  component: InboxRoute,
});

function InboxRoute(): JSX.Element {
  return <InboxScreen />;
}
