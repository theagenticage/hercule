/**
 * The tally pill above the composer: "Subagents" and how many run, as a
 * button that shows the subagents in the side pane (spec 17 §Thread,
 * Subagents).
 */
import type { JSX } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { describeSubagentTally, toggleSurface } from "@hercule/client-core";
import { sessionQuery, subagentsQuery } from "../../app/queries";
import { Mark } from "../../marks";
import { useHasSidePane, useSidePaneLayout } from "./use-side-pane";
import "./tally-pill.css";

/**
 * Renders the tally pill of the thread `sessionId`: the tally's mark,
 * "Subagents", and the count `describeSubagentTally` writes, such as
 * "2 of 6 running". A click shows the side pane on its Subagents surface,
 * or hides the pane when that surface already shows. Renders nothing while
 * the thread has no subagent, and nothing in the Office's thread drawer,
 * which has no side pane for the pill to open.
 *
 * It reads the session and its subagents from the cache, which the
 * thread's loader fills before the page renders.
 */
export function TallyPill({ sessionId }: { readonly sessionId: string }): JSX.Element | null {
  const { controller } = useRouteContext({ from: "/_connected" });
  const { client } = controller;
  const session = useSuspenseQuery(sessionQuery(client, sessionId)).data;
  const subagents = useSuspenseQuery(subagentsQuery(client, sessionId)).data;
  const { layout, changeLayout } = useSidePaneLayout(sessionId);
  const hasSidePane = useHasSidePane();
  if (!hasSidePane || subagents.length === 0) return null;
  const tally = describeSubagentTally(subagents, session.openRequests);
  const shown = layout.open && layout.shown === "subagents";
  return (
    <span className="pill tally-pill">
      <button
        type="button"
        className={shown ? "tally-pill-button is-on" : "tally-pill-button"}
        aria-pressed={shown}
        title={shown ? "Hide the side pane" : "Show the subagents in the side pane"}
        onClick={() => {
          changeLayout((current) => toggleSurface(current, "subagents"));
        }}
      >
        <Mark state={tally.mark} />
        <span>Subagents</span>
        <small>{tally.count}</small>
      </button>
    </span>
  );
}
