/**
 * The Office's drawer: the app's real thread screen, or an assistant's
 * Conversation screen, sliding in from the right over the Office, so the
 * user reads and answers a thread or an assistant while the Office stays
 * alive on the left.
 *
 * The drawer is open while the route names a thread or an assistant. A
 * thread need not have a colleague in the Office: a thread opened from the
 * sidebar may be asleep. Selecting another colleague with the drawer open
 * shows that colleague's thread or Conversation. After the drawer closes,
 * it keeps the last one drawn until it has slid away, then lets it go.
 *
 * Neither screen has its side pane in the drawer: a thread shows no tally
 * pill, and an assistant's Conversation holds only its transcript, its
 * Requests dock and its composer. A thread's spawn lines and the Request
 * pager's "Open subagent" link leave the Office for the subagent's full page.
 *
 * While the drawer shows a thread, it holds the `subagent` topic, as the
 * thread's own screen does, so the spawn lines stay current, and keeps the
 * thread's Request drafts, so paging between Requests keeps what was typed
 * and what was sent. An assistant's Conversation screen holds its own topics
 * and drafts, exactly as on its own page, so a streamed token costs the same
 * work in the drawer as there.
 */
import { memo, Suspense, useEffect, useState, type JSX } from "react";
import { useRouteContext } from "@tanstack/react-router";
import { useSubagentsLive } from "../../app/live";
import { useKeepRequestDrafts } from "../../app/request-drafts";
import { AssistantScreen } from "../../screens/assistant/assistant-screen";
import { AgentPage } from "../../screens/thread/agent-page";
import type { OpenColleague } from "../office-store";

/** Milliseconds the drawer keeps its colleague after closing: longer than its slide, `--dur-3`. */
const RELEASE_DELAY = 400;

/**
 * Renders the drawer, open on `open` and closed for null. Whether it shows a
 * thread or an assistant's Conversation is `open.kind`, so an assistant
 * deleted while its Conversation is open, or an assistant id that no
 * assistant has, shows the assistant page's "not found" state.
 *
 * It takes nothing from the world, and is memoized, so the drawer and the
 * screen inside it do not draw again each time a thread or an assistant
 * changes the Office.
 */
export const OfficeDrawer = memo(function OfficeDrawer({
  open,
}: {
  readonly open: OpenColleague | null;
}): JSX.Element {
  // `open` is the same object while the route's params stay the same.
  const [shown, setShown] = useState(open);
  if (open !== null && open !== shown) setShown(open);
  const threadId = shown?.kind === "thread" ? shown.id : null;
  const isOpen = open !== null;
  const { controller, queryClient } = useRouteContext({ from: "/_connected" });
  useSubagentsLive(controller.live, queryClient, threadId);
  useKeepRequestDrafts(threadId);
  // A timer rather than `transitionend`: with Reduce motion on, the slide
  // takes no time and no transition event fires.
  useEffect(() => {
    if (isOpen) return;
    const timer = setTimeout(() => setShown(null), RELEASE_DELAY);
    return () => clearTimeout(timer);
  }, [isOpen]);
  return (
    <aside
      className="office-drawer"
      data-open={isOpen}
      inert={!isOpen}
      aria-label={shown?.kind === "assistant" ? "Conversation" : "Thread"}
    >
      {shown === null ? null : (
        <div className="office-drawer-thread">
          <Suspense fallback={null}>
            {shown.kind === "assistant" ? (
              <AssistantScreen key={shown.id} assistantId={shown.id} />
            ) : (
              <AgentPage key={shown.id} sessionId={shown.id} subagentId={undefined} />
            )}
          </Suspense>
        </div>
      )}
    </aside>
  );
});
