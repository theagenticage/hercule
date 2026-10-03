import type { JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { isId } from "@hercule/contract";
import { ensureThreadData } from "../../../app/queries";
import { OfficeScreen } from "../../../office/office-screen";

/**
 * The search params of the Office: the session whose thread is open in the
 * drawer. A sidebar thread clicked while the Office is open sets it.
 */
export interface OfficeSearch {
  readonly session?: string;
}

/**
 * Returns the Office's search params from the URL's. A `session` that is not
 * an id is dropped, so the screen never acts on a malformed link.
 */
const validateOfficeSearch = (search: Record<string, unknown>): OfficeSearch =>
  isId(search.session) ? { session: search.session } : {};

/**
 * The Office: the user's threads as colleagues at work in one 3D place.
 *
 * The route is split into a chunk of its own, so three.js loads only when
 * the Office opens, never at the app's first paint. Its loader reads the
 * open thread before the screen renders, so the drawer shows its transcript
 * at once. The shell's loader has already read the threads the Office draws.
 */
export const Route = createFileRoute("/_connected/_shell/office")({
  staticData: { title: "Office" },
  validateSearch: validateOfficeSearch,
  loaderDeps: ({ search }) => ({ session: search.session }),
  loader: async ({ context: { controller, queryClient }, deps }) => {
    if (deps.session !== undefined)
      await ensureThreadData(queryClient, controller.client, deps.session);
  },
  component: OfficeRoute,
});

function OfficeRoute(): JSX.Element {
  const { session } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <OfficeScreen
      openSessionId={session ?? null}
      onOpenThread={(sessionId) =>
        void navigate({ search: sessionId === null ? {} : { session: sessionId } })
      }
    />
  );
}
