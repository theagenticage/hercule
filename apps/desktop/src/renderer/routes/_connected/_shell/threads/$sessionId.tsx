import { createFileRoute } from "@tanstack/react-router";

/**
 * The screen of one thread. For now the main pane stays empty: the route
 * exists so that a sidebar row can link to a thread and be marked as the
 * selected one. Slice 5 builds the screen.
 */
export const Route = createFileRoute("/_connected/_shell/threads/$sessionId")({
  staticData: { title: "Thread" },
});
