/**
 * The Subagents surface of the side pane: every subagent of the thread,
 * running and finished, as a tree in which a subagent sits on a rail under
 * the one that started it, with a footer that sums them up (spec 14
 * §Subagents on the thread surface). Each row shows the subagent's face
 * where the web app shows a state mark, still in its pose (spec 17 §The
 * thread, Subagents).
 */
import { useCallback, useEffect, useId, useRef, useState, type JSX, type RefObject } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Link, useRouteContext } from "@tanstack/react-router";
import {
  buildSubagentTree,
  countUsedTokens,
  describeSubagentLine,
  describeSubagentMeta,
  describeSubagentState,
  describeSubagentStop,
  formatTokenCount,
  isSubagentWaiting,
  nameSubagent,
  readErrorMessage,
  summarizeSubagents,
  type HerculeClient,
  type SubagentNode,
} from "@hercule/client-core";
import type { SessionRequest, Subagent } from "@hercule/contract";
import { useDurationText } from "../../app/age-clock";
import { sessionQuery, subagentsQuery } from "../../app/queries";
import { StopIcon } from "../../icons/stop";
import { useStopAgent } from "../use-stop-agent";
import { SubagentFace } from "./subagent-face";
import "./subagents-surface.css";

declare module "react" {
  interface CSSProperties {
    /** How far from a nested list's left edge its rail runs, as `<n>px`. */
    "--rail-x"?: string;
  }
}

/** The size of each row's face, in pixels. */
const FACE_SIZE = 22;

/** The left padding of a top-level row, in pixels. */
const ROW_PADDING = 10;

/** How much further right each level of the tree starts, in pixels. */
const INDENT_STEP = 20;

/**
 * How far from the left edge of a top-level row's nested list the rail runs,
 * in pixels: under the middle of the row's face, less about half the rail's
 * 1.5px width so the rail is centred there. Each level adds `INDENT_STEP`.
 */
const RAIL_X = ROW_PADDING + FACE_SIZE / 2 - 1;

/** What every row of the tree reads besides its own subagent. */
interface TreeContext {
  readonly client: HerculeClient;
  readonly sessionId: string;
  /** Every subagent of the session, oldest first. */
  readonly subagents: readonly Subagent[];
  readonly openRequests: readonly SessionRequest[];
  /** The subagent whose page is open in the main pane, whose row is marked current. */
  readonly openSubagentId: string | undefined;
  readonly watchScreen: ScreenWatcher;
}

/**
 * Starts reporting whether `element` is inside the visible part of the
 * surface's scroller: `onChange(true)` when it comes into view, and
 * `onChange(false)` when it leaves. Returns the function that stops the
 * reports.
 */
type ScreenWatcher = (element: Element, onChange: (onScreen: boolean) => void) => () => void;

/**
 * Returns a `ScreenWatcher` for the elements inside the scroller `scrollerRef`
 * points at. All elements share one IntersectionObserver, created on the
 * first watch and disconnected when the surface unmounts.
 */
const useScreenWatcher = (scrollerRef: RefObject<HTMLElement | null>): ScreenWatcher => {
  const watchedRef = useRef<{
    readonly observer: IntersectionObserver;
    readonly callbacks: Map<Element, (onScreen: boolean) => void>;
  } | null>(null);
  useEffect(
    () => () => {
      watchedRef.current?.observer.disconnect();
      watchedRef.current = null;
    },
    [],
  );
  return useCallback(
    (element, onChange) => {
      if (watchedRef.current === null) {
        const callbacks = new Map<Element, (onScreen: boolean) => void>();
        const observer = new IntersectionObserver(
          (entries) => {
            for (const entry of entries) callbacks.get(entry.target)?.(entry.isIntersecting);
          },
          { root: scrollerRef.current },
        );
        watchedRef.current = { observer, callbacks };
      }
      const { observer, callbacks } = watchedRef.current;
      callbacks.set(element, onChange);
      observer.observe(element);
      return () => {
        callbacks.delete(element);
        observer.unobserve(element);
      };
    },
    [scrollerRef],
  );
};

/**
 * Renders the Subagents surface of the session `sessionId`. With no
 * subagents yet, it says so and what will appear. `openSubagentId` is the
 * subagent whose page is open in the main pane; undefined on the thread's
 * own page.
 *
 * The thread's loader has read the session and its subagents, and the
 * thread's layout keeps them current, so nothing here waits.
 */
export function SubagentsSurface({
  sessionId,
  openSubagentId,
}: {
  readonly sessionId: string;
  readonly openSubagentId: string | undefined;
}): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const session = useSuspenseQuery(sessionQuery(client, sessionId)).data;
  const subagents = useSuspenseQuery(subagentsQuery(client, sessionId)).data;
  const stopAgent = useStopAgent(client, sessionId);
  const headingId = useId();
  const scrollerRef = useRef<HTMLDivElement>(null);
  const watchScreen = useScreenWatcher(scrollerRef);

  if (subagents.length === 0) {
    return (
      <div className="subagents-empty">
        <p className="subagents-empty-title">No subagents yet</p>
        <p>
          When an agent of this thread starts subagents, each one shows here with what it is doing.
        </p>
      </div>
    );
  }

  const tree = buildSubagentTree(subagents);
  const running = subagents.some((subagent) => subagent.status === "running");
  const context: TreeContext = {
    client,
    sessionId,
    subagents,
    openRequests: session.openRequests,
    openSubagentId,
    watchScreen,
  };
  return (
    <div className="subagents">
      <div ref={scrollerRef} className="subagents-scroll">
        <h4 id={headingId} className="subagents-section">
          Started by the main agent · {tree.length}
        </h4>
        <ul aria-labelledby={headingId} className="subagents-tree">
          {tree.map((node) => (
            <SubagentRow key={node.subagent.id} node={node} depth={0} context={context} />
          ))}
        </ul>
      </div>
      {stopAgent.error === null ? null : (
        <p role="alert" className="subagents-error subagents-error--foot">
          {readErrorMessage(stopAgent.error)}
        </p>
      )}
      <footer className="subagents-foot">
        <span>{summarizeSubagents(subagents)}</span>
        {running ? (
          <button
            type="button"
            className="btn btn--quiet btn--sm subagents-stop"
            // Not `disabled`, so the button keeps the focus while the stop
            // is on its way. `stop` ignores a second click meanwhile.
            aria-disabled={stopAgent.isPending || undefined}
            onClick={() => {
              stopAgent.stop();
            }}
          >
            <StopIcon size={12} />
            Stop all
          </button>
        ) : null}
        <span className="spacer" />
        {/* The session's usage counts its own agent and every subagent. A
            harness that has reported none leaves the total out, rather
            than showing 0. */}
        {session.usage === undefined ? null : (
          <span>Σ {formatTokenCount(countUsedTokens(session.usage))} tok</span>
        )}
      </footer>
    </div>
  );
}

/**
 * Renders one subagent's row, which opens its page, and under it, on a rail,
 * the rows of the subagents it started. `depth` is how many subagents sit
 * above it. A running row shows Stop while the pointer is over it or
 * keyboard focus is inside it, over its state.
 *
 * A running subagent's duration counts up on the app's one age clock, so it
 * draws at most once a second, and only while the row is inside the visible
 * part of the surface and the window is shown. An ended subagent's duration
 * never changes, so its row neither watches the screen nor registers a clock.
 */
function SubagentRow({
  node,
  depth,
  context,
}: {
  readonly node: SubagentNode;
  readonly depth: number;
  readonly context: TreeContext;
}): JSX.Element {
  const { subagent, children } = node;
  const { client, sessionId, subagents, openRequests } = context;
  const waiting = isSubagentWaiting(subagent, openRequests);
  const running = subagent.status === "running";
  const rowRef = useRef<HTMLDivElement>(null);
  // Off until the observer first reports, which it does as soon as the row
  // is watched. The first render reads the duration either way.
  const [onScreen, setOnScreen] = useState(false);
  const { watchScreen } = context;
  useEffect(
    () => (running ? watchScreen(rowRef.current!, setOnScreen) : undefined),
    [running, watchScreen],
  );
  const duration = useDurationText(
    subagent.startedAt,
    running && onScreen,
    (now) => describeSubagentState(subagent, waiting, new Date(now)).duration,
  );
  // The word and its hue do not depend on the time, so any moment will do,
  // and reading the clock while rendering would make the render impure.
  const state = describeSubagentState(subagent, waiting, new Date(subagent.startedAt));
  const line = describeSubagentLine(subagent, openRequests);
  // Each row stops on its own, so a stop on its way from one row neither
  // blocks another row's Stop nor shows its failure there.
  const stopAgent = useStopAgent(client, sessionId);
  const stop = describeSubagentStop(subagent, subagents);
  const current = subagent.id === context.openSubagentId;
  const name = nameSubagent(subagent);

  return (
    <li>
      <div
        ref={rowRef}
        className={current ? "subagent-row is-on" : "subagent-row"}
        style={{ paddingLeft: ROW_PADDING + depth * INDENT_STEP }}
      >
        <SubagentFace subagent={subagent} waiting={waiting} size={FACE_SIZE} />
        <span className="subagent-row-body">
          <span className="subagent-row-top">
            {/* The link's box covers the whole row, so a click anywhere on
                the row opens the subagent's page, while Stop stays a
                separate button above it. */}
            <Link
              to="/threads/$sessionId/subagents/$subagentId"
              params={{ sessionId, subagentId: subagent.id }}
              aria-current={current ? "page" : undefined}
              title={name}
              className="subagent-row-name"
            >
              {name}
            </Link>
            <span className="subagent-row-end">
              <span data-hue={state.hue}>{state.word} ·</span>
              <span data-subagent-duration={subagent.id}>{duration}</span>
            </span>
          </span>
          {line === null ? null : (
            <span className="subagent-row-line" data-hue={line.hue}>
              {line.text}
            </span>
          )}
          <span className="subagent-row-meta">{describeSubagentMeta(subagent)}</span>
          {stopAgent.error === null ? null : (
            <span role="alert" className="subagents-error">
              {readErrorMessage(stopAgent.error)}
            </span>
          )}
        </span>
        {stop === null ? null : (
          <button
            type="button"
            className="btn btn--quiet btn--sm subagents-stop subagent-row-stop"
            title={stop.title}
            // Not `disabled`, so the button keeps the focus while the stop
            // is on its way. `stop` ignores a second click meanwhile.
            aria-disabled={stopAgent.isPending || undefined}
            onClick={() => {
              stopAgent.stop(subagent.id);
            }}
          >
            <StopIcon size={12} />
            {stop.label}
          </button>
        )}
      </div>
      {children.length === 0 ? null : (
        <ul
          className="subagents-tree subagents-tree--nested"
          style={{ "--rail-x": `${String(RAIL_X + depth * INDENT_STEP)}px` }}
        >
          {children.map((child) => (
            <SubagentRow key={child.subagent.id} node={child} depth={depth + 1} context={context} />
          ))}
        </ul>
      )}
    </li>
  );
}
