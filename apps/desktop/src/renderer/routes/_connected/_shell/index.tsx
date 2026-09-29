import { createFileRoute } from "@tanstack/react-router";
import { isId } from "@hercule/contract";

/**
 * The search params of a new thread: the project it belongs to, and the
 * workspace it joins. A project's `+` and a workspace label's `+` in the
 * sidebar set them; the composer reads them (slice 7).
 */
export interface NewThreadSearch {
  readonly project?: string;
  readonly workspace?: string;
}

/**
 * Returns the new thread's search params from the URL's. A param that is not
 * an id is dropped, so the screen never acts on a malformed link.
 */
const validateNewThreadSearch = (search: Record<string, unknown>): NewThreadSearch => ({
  ...(isId(search.project) ? { project: search.project } : {}),
  ...(isId(search.workspace) ? { workspace: search.workspace } : {}),
});

/**
 * The screen the app starts on, when no thread is open: a new thread. For now
 * the main pane stays empty, so the route has no component.
 */
export const Route = createFileRoute("/_connected/_shell/")({
  // The app starts on this route, so it is not split into a chunk of its own:
  // a split route costs two more requests (its script and its stylesheet)
  // before the first render.
  codeSplitGroupings: [],
  staticData: { title: "New thread" },
  validateSearch: validateNewThreadSearch,
});
