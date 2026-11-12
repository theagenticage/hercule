import { useLayoutEffect, useRef, useSyncExternalStore, type JSX } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Link, useMatch, useNavigate, useRouteContext } from "@tanstack/react-router";
import { useFailedRun } from "../app/failed-run";
import { readAcknowledgedInboxArrival, subscribeInboxArrival } from "../app/inbox-arrival";
import { readOverviewView, subscribeOverviewView } from "../app/overview-view";
import { trackBody } from "../app/motion";
import { inboxCountQuery, userQuery } from "../app/queries";
import { useToDoCount } from "../app/tracking";
import { DiscussionsIcon } from "../icons/discussions";
import { IntakeIcon } from "../icons/intake";
import { OfficeIcon } from "../icons/office";
import { WikiIcon } from "../icons/wiki";
import { WorkflowsIcon } from "../icons/workflows";
import { SELECTED_LINK_PROPS } from "../screens/selected-link-props";

/**
 * Renders the Hercule face's Work section, each row selected while its
 * screen is open:
 *
 * - Overview, first, which opens the view of the Overview used last, the
 *   Office or Work. It is selected on Work only: the Office has its own row
 *   just below, which stays selected on the Office as before. With no count.
 *   Its row is named `data-motion-target="overview"`, the place a mark flies
 *   to when a card is handed on (`flyToSidebarTarget`). While a run is failed
 *   on a Task it ends in a 7px marigold dot with no number, and a click opens
 *   Work on what failed instead, whichever view was used last.
 * - The office, with no count.
 * - The Inbox, ending in a plain grey count of the cards with a clock on them,
 *   hidden at 0, and one small marigold dot while the Inbox holds an arrival
 *   this client has not shown the user yet (see `InboxRow`).
 * - Intake, which keeps its row until the Inbox takes it, ending in its To do
 *   count in marigold: the open signals and the rows of Tracking that wait on
 *   the user. The count is hidden at 0.
 * - Workflows, with no count: a total of the user's workflows gives the user
 *   nothing to act on. What a run waits on the user for shows in Waiting on
 *   you instead. The row is also selected on a run's page, because a run
 *   belongs to its workflow, as the book draws it.
 * - Discussions and Wiki, with no count either.
 *
 * The shell's loader reads the To do list, Tracking's reads and the Inbox's
 * counts, and keeps them cached for the life of the window, so nothing here
 * waits in practice.
 */
export function WorkSection(): JSX.Element {
  const toDoCount = useToDoCount();
  const runOpen =
    useMatch({ from: "/_connected/_shell/runs/$runId", shouldThrow: false }) !== undefined;
  const navigate = useNavigate();
  const { controller } = useRouteContext({ from: "/_connected/_shell" });
  const overviewView = useSyncExternalStore(subscribeOverviewView, () =>
    readOverviewView(controller.url),
  );
  const { hasFailedRun, openFailedRuns } = useFailedRun();
  return (
    <section className="side-sec">
      <h3 className="side-h">
        <span>Work</span>
      </h3>
      {/* The link is to Work, so it is selected on Work only: a link to the
          Office would be selected on the Office too, where the row below is
          the selected one. When the Office was the view used last, the click
          is sent there instead. A failed run sends it to what failed first. */}
      <Link
        to="/work"
        className="nav-row"
        data-motion-target="overview"
        activeProps={SELECTED_LINK_PROPS}
        aria-label={hasFailedRun ? "Overview, a run failed" : undefined}
        onClick={(event) => {
          if (hasFailedRun) {
            event.preventDefault();
            openFailedRuns();
            return;
          }
          if (overviewView !== "office") return;
          event.preventDefault();
          void navigate({ to: "/office" });
        }}
      >
        <OfficeIcon />
        <span>Overview</span>
        {hasFailedRun && <i className="nav-dot" />}
      </Link>
      <Link to="/office" className="nav-row" activeProps={SELECTED_LINK_PROPS}>
        <OfficeIcon />
        <span>The office</span>
      </Link>
      <InboxRow />
      {/* A screen reader reads the count with what it counts, as it does the
          Hercule segment's: "Intake, 8 to do". */}
      <Link
        to="/intake"
        className="nav-row"
        activeProps={SELECTED_LINK_PROPS}
        aria-label={toDoCount > 0 ? `Intake, ${String(toDoCount)} to do` : undefined}
      >
        <IntakeIcon />
        <span>Intake</span>
        {toDoCount > 0 && <b className="count count--you">{toDoCount}</b>}
      </Link>
      <Link
        to="/workflows"
        className={runOpen ? "nav-row is-on" : "nav-row"}
        aria-current={runOpen ? "page" : undefined}
        activeProps={SELECTED_LINK_PROPS}
      >
        <WorkflowsIcon />
        <span>Workflows</span>
      </Link>
      <Link to="/discussions" className="nav-row" activeProps={SELECTED_LINK_PROPS}>
        <DiscussionsIcon />
        <span>Discussions</span>
      </Link>
      <Link to="/wiki" className="nav-row" activeProps={SELECTED_LINK_PROPS}>
        <WikiIcon />
        <span>Wiki</span>
      </Link>
    </section>
  );
}

/** How far the Inbox's count sits below its place before it rolls into it, in pixels. */
const COUNT_ROLL_DEPTH = 4;

/**
 * Renders the Inbox's count, and rolls it 4px into place on `hand` when the
 * number changes, so the eye sees that a move or an arrival changed it. The
 * first number it shows does not roll.
 */
function InboxCount({ value }: { readonly value: number }): JSX.Element {
  const element = useRef<HTMLElement>(null);
  const shown = useRef(value);
  useLayoutEffect(() => {
    if (shown.current === value) return;
    shown.current = value;
    if (element.current === null) return;
    const body = trackBody(element.current);
    body.set({ y: COUNT_ROLL_DEPTH });
    body.to({ y: 0 }, "hand");
  }, [value]);
  return (
    <b ref={element} className="count">
      {value}
    </b>
  );
}

/**
 * Renders the Inbox's row: the count of things someone waits on
 * (the `waits` saved query), in the plain grey `.count` and hidden at 0, and a 6px
 * marigold dot while `newestArrival` is above the arrival this client last
 * acknowledged (see `acknowledgeInboxArrival`). The dot says something new
 * came while the user was elsewhere. An update to a card the user already
 * has never raises it, because only an arrival moves `newestArrival`.
 *
 * It is its own component, so a change of the count draws this row alone.
 * A screen reader reads the dot and the count with the name: "Inbox, 22
 * waiting, something new".
 */
function InboxRow(): JSX.Element {
  const { controller } = useRouteContext({ from: "/_connected/_shell" });
  const { client } = controller;
  const { username } = useSuspenseQuery(userQuery(client)).data;
  const { waiting, newestArrival } = useSuspenseQuery(inboxCountQuery(client)).data;
  const acknowledgedArrival = useSyncExternalStore(subscribeInboxArrival, () =>
    readAcknowledgedInboxArrival(controller.url, username),
  );
  const hasNewArrival = newestArrival > acknowledgedArrival;
  const description = [
    waiting > 0 ? `${String(waiting)} waiting` : null,
    hasNewArrival ? "something new" : null,
  ].filter((part) => part !== null);
  return (
    <Link
      to="/inbox"
      className="nav-row"
      activeProps={SELECTED_LINK_PROPS}
      aria-label={description.length > 0 ? `Inbox, ${description.join(", ")}` : undefined}
    >
      <IntakeIcon />
      <span>Inbox</span>
      {hasNewArrival && <i className="nav-new" />}
      {waiting > 0 && <InboxCount value={waiting} />}
    </Link>
  );
}
