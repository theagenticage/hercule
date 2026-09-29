import { createFileRoute } from "@tanstack/react-router";

/**
 * The screen the app starts on, when no thread is open. For now the main pane
 * stays empty, so the route has no component.
 */
export const Route = createFileRoute("/_shell/")({
  // The app starts on this route, so it is not split into a chunk of its own:
  // a split route costs two more requests (its script and its stylesheet)
  // before the first render.
  codeSplitGroupings: [],
  staticData: { title: "New thread" },
});
