/**
 * Draws a workflow's graph: its triggers and steps as cards, and the edges
 * between them (spec 17 §Workflows, "The open workflow"). On a run's page it
 * also draws the run on top: where the run is at each node and how far it
 * came along each edge, looked up by the ids the graph model gives them
 * (spec 17 §Workflows, "A run's page").
 */
import {
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
} from "react";
import type { PluginIdentity } from "@hercule/client-core";
import { buildCurve } from "@hercule/client-core/graph-layout";
import type {
  EdgeOnRun,
  GraphEdge,
  NodeRunState,
  RunOverlay,
  WorkflowGraphDrawing,
} from "@hercule/client-core/graph-model";
import { describeNodeRunStatus, type NodeCard } from "@hercule/client-core/node-details";
import { MinusIcon } from "../../icons/minus";
import { PlusIcon } from "../../icons/plus";
import { Mark } from "../../marks";
import { NodeCardContent } from "./node-card";
import { NodeIcon } from "./node-icon";
import { findNodeRunMark } from "./node-run-mark";
import { BUS, CARD, END_RADIUS, END_STUB, layOutGraphDrawing } from "./workflow-graph-layout";
import "./workflow-graph.css";
import { isTextField } from "../../app/text-field";

/** The space between the drawing and the pane's edges, which `.graph`'s negative margin takes back. */
const PANE_PADDING = 12;

/** The room under the drawing for the zoom controls, so they never cover a card. */
const ZOOM_BAR = 40;

/** How far the zoom goes out and in, and how much one press of a key or a button changes it. */
const MIN_SCALE = 0.25;
const MAX_SCALE = 2;
const ZOOM_STEP = 1.25;

/**
 * The smallest zoom the graph opens at. Below it a card's name is smaller
 * than 11px, too small to read, so a wider graph opens cut off at the right
 * and scrolls. Fit shows the whole graph however small.
 */
const OPENING_MIN_SCALE = 0.8;

/** The gap between a node and its card, and the space the card keeps from the window's edges. */
const CARD_GAP = 6;
const WINDOW_MARGIN = 8;

/** Keeps `value` between `min` and `max`. */
const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

/**
 * Returns the zoom that a key press asks for, or `undefined` for a key that
 * does not zoom: ⌘= or ⌘+ zooms in, ⌘- out, ⌘0 to 100%, and ⇧1 fits the
 * graph, as in Figma. ⇧1 is read from the key's place, because its character
 * is "!".
 */
const findKeyZoom = (event: KeyboardEvent, scale: number, fitScale: number): number | undefined => {
  if (event.metaKey) {
    if (event.key === "=" || event.key === "+") return scale * ZOOM_STEP;
    if (event.key === "-") return scale / ZOOM_STEP;
    if (event.key === "0") return 1;
    return undefined;
  }
  return event.shiftKey && !event.altKey && !event.ctrlKey && event.code === "Digit1"
    ? fitScale
    : undefined;
};

/**
 * Places the open card under its node `anchor`, at the node's left edge, or
 * over it when it does not fit below. The card stays inside the window; its
 * CSS caps its height there, and it scrolls when its rows are longer.
 */
const placeNodeCard = (card: HTMLElement, anchor: HTMLElement): void => {
  const box = anchor.getBoundingClientRect();
  const height = card.offsetHeight;
  const below = box.bottom + CARD_GAP;
  const top =
    below + height <= window.innerHeight - WINDOW_MARGIN
      ? below
      : Math.max(WINDOW_MARGIN, box.top - CARD_GAP - height);
  const left = clamp(box.left, WINDOW_MARGIN, window.innerWidth - WINDOW_MARGIN - card.offsetWidth);
  card.style.top = `${String(top)}px`;
  card.style.left = `${String(left)}px`;
};

/** The states a card is ringed in: `.node-ring` in workflow-graph.css. */
const RINGED_STATES: ReadonlySet<NodeRunState> = new Set(["waiting", "failed", "listening"]);

/** The states a card stands back in, at half opacity: the run did not reach it, passed it by, or a trigger stayed quiet. */
const DIMMED_STATES: ReadonlySet<NodeRunState> = new Set([
  "unreached",
  "quiet",
  "cancelled",
  "skipped",
]);

/** The class of each way a run travelled along an edge, as the Bureau book names them. */
const TRAVEL_CLASSES: { readonly [Travel in EdgeOnRun["travel"]]: string } = {
  fired: "is-fired",
  active: "is-active",
  notTaken: "is-not-taken",
  notYet: "is-not-yet",
};

/**
 * The tones an edge's arrowhead comes in, each its own marker, because a
 * marker cannot take the colour of the edge it ends. An edge the run did not
 * take keeps the plain arrowhead: only its line is dashed.
 */
const ARROW_TONES = ["", "is-fired", "is-active", "is-not-yet", "is-failed"] as const;

/**
 * Returns the class an edge, its arrowhead and its label take for where the
 * run is on it, `onRun`: `is-failed` where the run failed, otherwise how far
 * the run came along it. Returns an empty string with no run.
 */
const decideEdgeTone = (onRun: EdgeOnRun | undefined): string => {
  if (onRun === undefined) return "";
  return onRun.isFailedEdge ? "is-failed" : TRAVEL_CLASSES[onRun.travel];
};

/** Returns the id of the arrowhead marker for an edge of `tone`. */
const buildArrowId = (arrowId: string, tone: string): string =>
  tone === "" || tone === "is-not-taken" ? arrowId : `${arrowId}-${tone}`;

/**
 * How a node's state changed while the run's page was open:
 *
 * - `brightened`: its card stood back at half opacity and no longer does;
 * - `dimmed`: the other way round;
 * - `changed`: any other change of state.
 */
type NodeChange = "brightened" | "dimmed" | "changed";

const NO_CHANGES: ReadonlyMap<string, NodeChange> = new Map();

/**
 * Returns how each node whose state differs between two overlays of the same
 * graph changed, by node id. A node that is in only one of them has not
 * changed.
 */
const listChangedNodes = (
  before: RunOverlay,
  after: RunOverlay,
): ReadonlyMap<string, NodeChange> => {
  const changes = new Map<string, NodeChange>();
  for (const [nodeId, { state }] of after.nodes) {
    const was = before.nodes.get(nodeId)?.state;
    if (was === undefined || was === state) continue;
    const wasDimmed = DIMMED_STATES.has(was);
    const isDimmed = DIMMED_STATES.has(state);
    changes.set(
      nodeId,
      wasDimmed && !isDimmed ? "brightened" : !wasDimmed && isDimmed ? "dimmed" : "changed",
    );
  }
  return changes;
};

/** The class of a node's card that plays its change, or an empty string for none. */
const CHANGE_CLASSES: { readonly [Change in NodeChange]: string } = {
  brightened: " is-brightening",
  dimmed: " is-dimming",
  changed: "",
};

/**
 * Renders an edge's label: its condition in mono, then its limit in the UI
 * face. The limit is the definition's, such as "≤ 3", or on a run how often
 * the run followed the edge, such as "1/3". `tone` is the edge's class on a
 * run (`decideEdgeTone`).
 */
function EdgeLabel({
  edge,
  limit,
  tone,
  left,
  top,
}: {
  readonly edge: GraphEdge;
  readonly limit: string | undefined;
  readonly tone: string;
  readonly left: number;
  readonly top: number;
}): JSX.Element {
  const isLimitOnly = edge.condition === undefined;
  const className = ["edge-label", isLimitOnly ? "edge-label--count" : "", tone]
    .filter((name) => name !== "")
    .join(" ");
  return (
    <span className={className} style={{ left, top }} title={edge.fullCondition}>
      {isLimitOnly ? limit : edge.condition}
      {!isLimitOnly && limit !== undefined ? (
        <span className="edge-label--count">{` · ${limit}`}</span>
      ) : null}
    </span>
  );
}

/**
 * Draws `drawing` in a pane that zooms. `readCard` returns the card of a
 * node by its id, and `timezone` is the zone its times are shown in. `label`
 * names the graph for assistive technology, such as "The steps of Ship
 * release". `plugins` holds the plugins' names and marks, which a plugin's
 * action step draws.
 *
 * - The graph opens fitted to the pane's width, never below 80% and never
 *   above 100%, and follows the pane's width until the user zooms. The zoom
 *   pill shows only when the graph is wider than the pane at 100%.
 * - While the pane or a node in it has focus, ⌘= or ⌘+, ⌘-, ⌘0 and ⇧1 zoom
 *   in, out, to 100% and to fit. A text field is never inside the pane, so
 *   the keys never reach one. A zoom button at its end of the range cannot
 *   act, but keeps the focus.
 * - A side where the pane cuts the graph off fades out over 48px.
 * - With an `overlay`, the graph draws a run on top: each card's mark on its
 *   top-right corner, a ring on a card that waits on the user, failed or
 *   listens, half opacity on a card the run did not reach or passed by,
 *   "×2" after the id of a step the run came to twice, and the tone of
 *   each edge and of each stub to the end. A node whose state changes while the graph is open brightens or
 *   dims, and its ring and mark come in (spec 17 §Workflows, "Workflows'
 *   motion", items 4 and 5). A card's Open thread calls `onOpenSession`.
 * - A click on a node opens its card under it, and moves the focus to the
 *   card, which is a dialog. A click on the same node, Escape, or a click
 *   anywhere else closes it. Escape returns focus to the node, and is not
 *   passed on, so the page does not also close. Escape in a text field, such
 *   as the list's search, is left to the field.
 */
export function WorkflowGraph({
  drawing,
  readCard,
  timezone,
  label,
  plugins,
  overlay,
  onOpenSession,
}: {
  readonly drawing: WorkflowGraphDrawing;
  readonly readCard: (nodeId: string) => NodeCard | undefined;
  readonly timezone: string;
  readonly label: string;
  readonly plugins: ReadonlyArray<PluginIdentity>;
  readonly overlay?: RunOverlay | undefined;
  readonly onOpenSession?: ((sessionId: string) => void) | undefined;
}): JSX.Element {
  const id = useId().replace(/[^\w-]/g, "");
  const arrowId = `graph-arrow-${id}`;
  const cardId = `graph-card-${id}`;
  // Laying out is the graph's costliest work, so it runs again only for a
  // new drawing, never for a new overlay.
  const { layout, size } = useMemo(() => layOutGraphDrawing(drawing), [drawing]);

  // Only a change made while the graph is open plays, so the graph keeps the
  // overlay it drew last to compare with. A push that changes no node keeps
  // the changes that are playing, so a second push soon after does not cut
  // their motion short.
  const [shownOverlay, setShownOverlay] = useState(overlay);
  const [changes, setChanges] = useState(NO_CHANGES);
  if (overlay !== shownOverlay) {
    setShownOverlay(overlay);
    if (overlay === undefined || shownOverlay === undefined) {
      setChanges(NO_CHANGES);
    } else {
      const next = listChangedNodes(shownOverlay, overlay);
      if (next.size > 0) setChanges(next);
    }
  }

  const paneRef = useRef<HTMLDivElement>(null);
  const [paneWidth, setPaneWidth] = useState(0);
  useLayoutEffect(() => {
    const pane = paneRef.current!;
    const measure = () => {
      setPaneWidth(pane.clientWidth);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(pane);
    return () => {
      observer.disconnect();
    };
  }, []);

  const fitScale = clamp((paneWidth - 2 * PANE_PADDING) / size.width, MIN_SCALE, 1);
  const canZoom = fitScale < 1;
  // `undefined` until the user zooms: the graph opens fitted and follows the pane.
  const [chosenScale, setChosenScale] = useState<number | undefined>(undefined);
  const scale = chosenScale ?? Math.max(fitScale, OPENING_MIN_SCALE);
  const zoomTo = (next: number) => {
    setChosenScale(clamp(next, MIN_SCALE, MAX_SCALE));
  };
  const zoomWithKeys = (event: KeyboardEvent) => {
    if (!canZoom) return;
    const next = findKeyZoom(event, scale, fitScale);
    if (next === undefined) return;
    event.preventDefault();
    zoomTo(next);
  };

  // Each side is its own state, so a scroll that changes neither renders nothing.
  const [isCutLeft, setCutLeft] = useState(false);
  const [isCutRight, setCutRight] = useState(false);
  const showCutSides = () => {
    const pane = paneRef.current!;
    setCutLeft(pane.scrollLeft > 0);
    // The scroll width is rounded, so the last pixel does not count.
    setCutRight(pane.scrollLeft + pane.clientWidth < pane.scrollWidth - 1);
  };
  // A change of zoom or of the pane's width can cut a side, or stop cutting it, with no scroll.
  const showCutSidesAfterResize = useEffectEvent(showCutSides);
  useLayoutEffect(() => {
    showCutSidesAfterResize();
  }, [scale, paneWidth, size.width]);

  // The card is a popover, so it sits in the top layer, above the pane that
  // clips the graph. It is a manual one: the graph closes it itself, so that
  // Escape can be kept from the page and a click on its node toggles it.
  const cardRef = useRef<HTMLDivElement>(null);
  const nodeRefs = useRef(new Map<string, HTMLButtonElement>());
  const [openNodeId, setOpenNodeId] = useState<string | undefined>(undefined);
  const openCard = openNodeId === undefined ? undefined : readCard(openNodeId);
  const isOpen = openCard !== undefined;
  const openPluginId = drawing.nodes.find((node) => node.id === openNodeId)?.pluginId ?? null;

  const placeOpenCard = useEffectEvent(() => {
    const anchor = openNodeId === undefined ? undefined : nodeRefs.current.get(openNodeId);
    if (anchor !== undefined) placeNodeCard(cardRef.current!, anchor);
  });
  // The card is a dialog, so it takes the focus when it opens, or when it
  // moves to another node; a change of zoom only places it again.
  useLayoutEffect(() => {
    const card = cardRef.current!;
    card.togglePopover(isOpen);
    if (!isOpen) return;
    placeOpenCard();
    card.focus();
  }, [isOpen, openNodeId]);
  useLayoutEffect(() => {
    if (isOpen) placeOpenCard();
  }, [isOpen, scale]);

  const closeWithEscape = useEffectEvent((event: globalThis.KeyboardEvent) => {
    if (event.key !== "Escape" || isTextField(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    if (openNodeId !== undefined) nodeRefs.current.get(openNodeId)?.focus();
    setOpenNodeId(undefined);
  });
  const closeOnPointerElsewhere = useEffectEvent((event: PointerEvent) => {
    const target = event.target as Node;
    if (cardRef.current!.contains(target)) return;
    // A node's own click opens its card or closes the one it holds.
    if ([...nodeRefs.current.values()].some((node) => node.contains(target))) return;
    setOpenNodeId(undefined);
  });
  useEffect(() => {
    if (!isOpen) return;
    const follow = () => {
      placeOpenCard();
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      closeWithEscape(event);
    };
    const pointer = (event: PointerEvent) => {
      closeOnPointerElsewhere(event);
    };
    // In the capture phase, so the card takes Escape before the page does.
    window.addEventListener("keydown", escape, { capture: true });
    document.addEventListener("pointerdown", pointer, { capture: true });
    window.addEventListener("scroll", follow, { capture: true, passive: true });
    window.addEventListener("resize", follow);
    return () => {
      window.removeEventListener("keydown", escape, { capture: true });
      document.removeEventListener("pointerdown", pointer, { capture: true });
      window.removeEventListener("scroll", follow, { capture: true });
      window.removeEventListener("resize", follow);
    };
  }, [isOpen]);

  const drawHeight = Math.ceil(size.height * scale) + 2 * PANE_PADDING;
  const busPoint = drawing.busId === undefined ? undefined : layout.nodes.get(drawing.busId);

  return (
    <div className="graph">
      <div
        ref={paneRef}
        className={`graph-pane${isCutLeft ? " is-cut-left" : ""}${isCutRight ? " is-cut-right" : ""}`}
        role="group"
        aria-label={label}
        tabIndex={0}
        style={{ height: drawHeight + (canZoom ? ZOOM_BAR : 0) }}
        onKeyDown={zoomWithKeys}
        onScroll={showCutSides}
      >
        <div
          className="graph-room"
          style={{ width: Math.ceil(size.width * scale) + 2 * PANE_PADDING, height: drawHeight }}
        >
          <div
            className="graph-draw"
            style={{
              width: size.width,
              height: size.height,
              transform: `translate(${String(PANE_PADDING)}px, ${String(PANE_PADDING)}px) scale(${String(scale)})`,
            }}
          >
            <svg className="graph-edges" width={size.width} height={size.height} aria-hidden="true">
              <defs>
                {(overlay === undefined ? ARROW_TONES.slice(0, 1) : ARROW_TONES).map((tone) => (
                  <marker
                    key={tone}
                    id={buildArrowId(arrowId, tone)}
                    viewBox="0 0 8 8"
                    refX="7"
                    refY="4"
                    markerWidth="7"
                    markerHeight="7"
                    orient="auto-start-reverse"
                  >
                    <path
                      className={tone === "" ? "arrow" : `arrow ${tone}`}
                      d="M1 1.2L7 4L1 6.8z"
                    />
                  </marker>
                ))}
              </defs>
              {drawing.edges.map((edge) => {
                const tone = decideEdgeTone(overlay?.edges.get(edge.id));
                const className = ["edge", edge.kind === "correlation" ? "edge--signal" : "", tone]
                  .filter((name) => name !== "")
                  .join(" ");
                return (
                  <path
                    key={edge.id}
                    className={className}
                    d={buildCurve(layout.edges.get(edge.id)!.points)}
                    // The edges into the junction meet at its dot, with no arrowhead.
                    markerEnd={
                      edge.kind === "plan" && edge.to !== drawing.busId
                        ? `url(#${buildArrowId(arrowId, tone)})`
                        : undefined
                    }
                  />
                );
              })}
              {busPoint === undefined ? null : (
                <circle className="bus" cx={busPoint.x} cy={busPoint.y + BUS.height / 2} r="2.5" />
              )}
              {drawing.nodes
                .filter((node) => node.terminal)
                .map((node) => {
                  const point = layout.nodes.get(node.id)!;
                  const x = point.x + CARD.width;
                  const y = point.y + CARD.height / 2;
                  const travel = overlay?.endStubs.get(node.id);
                  const stubClass =
                    travel === undefined ? "edge" : `edge ${TRAVEL_CLASSES[travel]}`;
                  return (
                    <g key={node.id}>
                      <path
                        className={stubClass}
                        d={`M${String(x)} ${String(y)}h${String(END_STUB)}`}
                      />
                      <circle
                        className="graph-end"
                        cx={x + END_STUB + END_RADIUS}
                        cy={y}
                        r={END_RADIUS}
                      />
                    </g>
                  );
                })}
            </svg>
            {drawing.edges.map((edge) => {
              const centre = layout.edges.get(edge.id)!.label;
              if (
                centre === undefined ||
                (edge.condition === undefined && edge.limit === undefined)
              )
                return null;
              const onRun = overlay?.edges.get(edge.id);
              return (
                <EdgeLabel
                  key={edge.id}
                  edge={edge}
                  limit={onRun?.traversalBadge ?? edge.limit}
                  tone={decideEdgeTone(onRun)}
                  left={centre.x}
                  top={centre.y}
                />
              );
            })}
            {drawing.nodes.map((node) => {
              const point = layout.nodes.get(node.id)!;
              const isStep = node.kind !== "start" && node.kind !== "signal";
              const isNodeOpen = isOpen && openNodeId === node.id;
              const run = overlay?.nodes.get(node.id);
              const runMark = run === undefined ? undefined : findNodeRunMark(run.state);
              const change = changes.get(node.id);
              const changeClass = change === undefined ? "" : CHANGE_CLASSES[change];
              const newClass = change === undefined ? "" : " is-new";
              // A run adds where it is at the node, in the words of the node's card.
              const statusText =
                run === undefined ? undefined : describeNodeRunStatus(run.state, node.kind);
              return (
                <button
                  key={node.id}
                  ref={(element) => {
                    if (element === null) nodeRefs.current.delete(node.id);
                    else nodeRefs.current.set(node.id, element);
                  }}
                  type="button"
                  className={`node ${isStep ? "node--step" : "node--trigger"}${run === undefined ? "" : ` is-${run.state}`}${changeClass}${isNodeOpen ? " is-open" : ""}`}
                  style={{ left: point.x, top: point.y }}
                  aria-label={`${node.id}, ${node.detail}${statusText === undefined ? "" : `, ${statusText}`}`}
                  aria-haspopup="dialog"
                  aria-expanded={isNodeOpen}
                  aria-controls={cardId}
                  title={`${node.id}\n${node.detail}`}
                  onClick={() => {
                    setOpenNodeId(isNodeOpen ? undefined : node.id);
                  }}
                >
                  {run !== undefined && RINGED_STATES.has(run.state) ? (
                    // Keyed by the state, so a ring that changes colour comes in again.
                    <span key={`ring ${run.state}`} className={`node-ring${newClass}`} />
                  ) : null}
                  {node.joinsAll ? <span className="node-join">all</span> : null}
                  <span className="node-lead">
                    <NodeIcon
                      kind={node.kind}
                      firesOn={node.firesOn}
                      pluginId={node.pluginId}
                      plugins={plugins}
                    />
                  </span>
                  <span className="node-text">
                    <span className="node-title">
                      <b>{node.id}</b>
                      {run?.iterationLabel === undefined ? null : (
                        <span className="node-times">{run.iterationLabel}</span>
                      )}
                    </span>
                    <span className="node-detail">{node.detail}</span>
                  </span>
                  {runMark === undefined ? null : (
                    // Keyed by the mark, so a mark that changes pops in again.
                    <span key={`mark ${runMark}`} className={`node-mark${newClass}`}>
                      <Mark state={runMark} />
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </div>
      {canZoom ? (
        <div className="pill zoom">
          <button
            type="button"
            className="icon-btn"
            aria-label="Zoom out"
            title="Zoom out (⌘−)"
            aria-disabled={scale <= MIN_SCALE || undefined}
            data-unready={scale <= MIN_SCALE || undefined}
            onClick={() => {
              if (scale > MIN_SCALE) zoomTo(scale / ZOOM_STEP);
            }}
          >
            <MinusIcon size={14} />
          </button>
          <output aria-label="Zoom">{`${String(Math.round(scale * 100))}%`}</output>
          <button
            type="button"
            className="icon-btn"
            aria-label="Zoom in"
            title="Zoom in (⌘+)"
            aria-disabled={scale >= MAX_SCALE || undefined}
            data-unready={scale >= MAX_SCALE || undefined}
            onClick={() => {
              if (scale < MAX_SCALE) zoomTo(scale * ZOOM_STEP);
            }}
          >
            <PlusIcon size={14} />
          </button>
          <button
            type="button"
            className="btn btn--quiet btn--sm"
            title="Fit the graph to the pane (⇧1)"
            onClick={() => {
              zoomTo(fitScale);
            }}
          >
            Fit
          </button>
        </div>
      ) : null}
      <div
        ref={cardRef}
        id={cardId}
        popover="manual"
        role="dialog"
        tabIndex={-1}
        className="pop node-pop"
        aria-label={isOpen ? `${openCard.id}, ${openCard.kindText}` : undefined}
      >
        {isOpen ? (
          <NodeCardContent
            card={openCard}
            pluginId={openPluginId}
            plugins={plugins}
            timezone={timezone}
            onOpenSession={onOpenSession}
          />
        ) : null}
      </div>
    </div>
  );
}
