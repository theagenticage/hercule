import { useMemo, type JSX } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { isId } from "@hercule/contract";
import { ensureConversationData, ensureThreadData } from "../../../app/queries";
import { OfficeScreen } from "../../../office/office-screen";
import type { OpenColleague } from "../../../office/office-store";

/**
 * The search params of the Office: what the drawer shows. `session` names a
 * thread and `assistant` an assistant's Conversation; at most one is set. A
 * sidebar row clicked while the Office is open sets one of them.
 */
export interface OfficeSearch {
  readonly session?: string;
  readonly assistant?: string;
}

/**
 * Returns the Office's search params from the URL's. A param that is not an
 * id is dropped, so the screen never acts on a malformed link. When a link
 * names both a thread and an assistant, the thread wins, so the drawer
 * always shows one of them.
 */
const validateOfficeSearch = (search: Record<string, unknown>): OfficeSearch => {
  if (isId(search.session)) return { session: search.session };
  if (isId(search.assistant)) return { assistant: search.assistant };
  return {};
};

/**
 * The Office: the user's threads and assistants as colleagues at work in
 * one 3D place.
 *
 * The route is split into a chunk of its own, so three.js loads only when
 * the Office opens, never at the app's first paint. Its loader reads what
 * the open drawer shows before the screen renders, so the drawer shows its
 * transcript or Conversation at once. The shell's loader has already read
 * the threads and the assistants the Office draws.
 *
 * The param's name decides what the drawer shows: `session` a thread and
 * `assistant` an assistant's Conversation, whether or not the Office has a
 * colleague with that id. So an `assistant` id that no assistant has shows
 * the assistant page's "not found" state, and a `session` id that no thread
 * has shows the thread page's.
 */
export const Route = createFileRoute("/_connected/_shell/office")({
  staticData: { title: "Office" },
  validateSearch: validateOfficeSearch,
  loaderDeps: ({ search }) => ({ session: search.session, assistant: search.assistant }),
  loader: async ({ context: { controller, queryClient }, deps }) => {
    const { client } = controller;
    if (deps.session !== undefined) await ensureThreadData(queryClient, client, deps.session);
    if (deps.assistant !== undefined)
      await ensureConversationData(queryClient, client, deps.assistant);
  },
  component: OfficeRoute,
});

/** Returns what the drawer shows for the `session` and `assistant` params, or null when neither is set. */
const buildOpenColleague = (
  session: string | undefined,
  assistant: string | undefined,
): OpenColleague | null => {
  if (session !== undefined) return { kind: "thread", id: session };
  if (assistant !== undefined) return { kind: "assistant", id: assistant };
  return null;
};

/** Returns the search params that open `colleague` in the drawer, or close the drawer for null. */
const buildOfficeSearch = (colleague: OpenColleague | null): OfficeSearch => {
  if (colleague === null) return {};
  return colleague.kind === "thread" ? { session: colleague.id } : { assistant: colleague.id };
};

function OfficeRoute(): JSX.Element {
  const { session, assistant } = Route.useSearch();
  const navigate = Route.useNavigate();
  // The same object while the params stay the same, so the drawer, which
  // takes it, does not draw again when anything else changes.
  const open = useMemo(() => buildOpenColleague(session, assistant), [session, assistant]);
  return (
    <OfficeScreen
      open={open}
      onOpen={(colleague) => void navigate({ search: buildOfficeSearch(colleague) })}
    />
  );
}
