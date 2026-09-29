import type { JSX } from "react";
import {
  rootRouteId,
  useNavigate,
  useParentMatches,
  useRouteContext,
  useRouter,
  useRouterState,
  type ErrorComponentProps,
} from "@tanstack/react-router";
import { CONNECT_PATH } from "../app/entry-guard";
import { CenteredFooter, CenteredScreen } from "./centered-screen";
import "./render-failure.css";

/** The headline of both forms of the screen (spec 14, "A screen that threw while rendering"). */
const HEADLINE = "This screen did not load";

/**
 * Renders the screen the router shows when a route fails: its loader fails,
 * or its component throws while rendering. Without it, the router shows its
 * own bare error text in place of the app.
 *
 * The screen shows the error's own message, so the user can report what
 * happened, and a Try again button that loads every route on screen again.
 *
 * Where the screen appears depends on which route failed:
 *
 * - A screen inside the shell: the sidebar still stands, so the screen fills
 *   only the main pane.
 * - The shell itself, or a route above it: nothing is left standing, so the
 *   screen fills the window, and the lead drops its second sentence. A
 *   typical case is a controller that stops answering between the entry
 *   guard and the shell's reads. When a controller is saved, the foot of the
 *   screen names it and offers Change, which leads to the connect screen.
 */
export function RenderFailure({ error }: ErrorComponentProps): JSX.Element {
  // The router renders this component inside the failed route's match, so
  // the parent matches are the routes above the one that failed. The shell
  // among them means the sidebar is still on screen.
  const inShell = useParentMatches({
    select: (parents) => parents.some((match) => match.routeId === "/_connected/_shell"),
  });

  const message = (
    <p className="render-failure-message" role="alert">
      {error.message}
    </p>
  );

  return inShell ? (
    <div className="render-failure">
      <div className="render-failure-text">
        <h1 className="render-failure-headline">{HEADLINE}</h1>
        <p className="render-failure-lead">
          Something went wrong rendering it. The rest of Hercule is still here.
        </p>
        {message}
      </div>
      <TryAgainButton />
    </div>
  ) : (
    <CenteredScreen>
      <div className="render-failure-text">
        <h2 className="render-failure-headline">{HEADLINE}</h2>
        <p className="render-failure-lead">Something went wrong rendering it.</p>
        {message}
      </div>
      <TryAgainButton />
      <ControllerFooter />
    </CenteredScreen>
  );
}

/**
 * Renders the Try again button. Pressing it has the router load every route
 * on screen again, which runs their loaders and renders them anew. While the
 * router loads, the button says so and ignores further presses.
 *
 * The button reads the router's own loading state rather than keeping one:
 * the router renders this screen anew as the load starts, and a state kept
 * here would be lost then.
 */
function TryAgainButton(): JSX.Element {
  const router = useRouter();
  const loading = useRouterState({ select: (state) => state.isLoading });
  return (
    <button
      type="button"
      className="btn btn--accent render-failure-retry"
      aria-disabled={loading || undefined}
      onClick={() => {
        if (!loading) void router.invalidate();
      }}
    >
      {loading ? "Trying again…" : "Try again"}
    </button>
  );
}

/**
 * Renders the foot of the full-window screen: the saved controller's URL and
 * a Change button that leads to the connect screen. Renders nothing when no
 * controller is saved, because the app is then on the connect screen already.
 */
function ControllerFooter(): JSX.Element | null {
  const { controller } = useRouteContext({ from: rootRouteId });
  const navigate = useNavigate();
  if (controller === null) return null;
  return (
    <CenteredFooter
      text={`Controller at ${controller.url}`}
      onChange={() => {
        void navigate({ to: CONNECT_PATH });
      }}
    />
  );
}
