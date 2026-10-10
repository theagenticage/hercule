/**
 * PROTOTYPE. Draws a workflow's graph: its triggers and steps as cards, and
 * the edges between them, with a run's progress on them when one is picked.
 */
import {
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { MinusIcon } from "../../icons/minus";
import { PlusIcon } from "../../icons/plus";
import { Mark } from "../../marks/mark";
import { buildCurve, computeGraphLayout, type Point, type Size } from "./graph-layout";
import {
  NODE_MARKS,
  type GraphEdge,
  type GraphNode,
  type GraphNodeState,
  type WorkflowGraphDrawing,
} from "./graph-model";
import { NodeCard } from "./node-card";
import type { NodeDetails } from "./node-details";
import { NodeIcon } from "./node-icon";
import "./workflow-graph.css";

/** The size of every card. A longer id or detail is cut short, and the card's label says it whole. */
const CARD: Size = { width: 176, height: 48 };

/**
 * The gap the layout keeps between an edge and a card's corner. It is more
 * than the cards' corner radius, so every edge meets a card's straight side.
 */
const SIDE_MARGIN = 12;

/**
 * The size of the start triggers' junction. With no width, and room for one
 * attachment point between its margins, every edge into and out of it meets
 * at its centre, where the graph draws a dot.
 */
const BUS: Size = { width: 0, height: 2 * SIDE_MARGIN };

/** The line out of a step that ends the run, and the dot at its end. */
const END_STUB = 10;
const END_RADIUS = 4;

/** The room the end dot takes beyond the layout's right edge. */
const END_ROOM = END_STUB + 2 * END_RADIUS + 2;

/**
 * An edge label's font size, `--t-11`, and the width of each glyph of the
 * mono face it is set in, which is 0.6em for every glyph. So a label's width
 * follows from its length, before anything renders.
 */
const LABEL_FONT_SIZE = 11;
const MONO_GLYPH_WIDTH = 0.6;
/** A label's line height and side padding, as `.wfg-label` draws it. */
const LABEL_HEIGHT = 15;
const LABEL_PADDING = 4;

/** The space between the drawing and the pane's edges, which holds the marks that sit over a card's corner. */
const PANE_PADDING = 12;

/** How far the zoom can go out and in, and how much one step of the keys or buttons changes it. */
const MIN_SCALE = 0.25;
const MAX_SCALE = 2;
const ZOOM_STEP = 1.25;

/**
 * The smallest zoom the graph opens at. A graph wider than its pane at this
 * zoom opens cut off at the right, and scrolls: below 80%, a card's name is
 * smaller than 11px, too small to read. Fit shows the whole graph however small.
 */
const OPENING_MIN_SCALE = 0.8;

/** The room under the drawing for the zoom controls, so they never cover a card. */
const ZOOM_ROOM = 40;

/** How strongly a pinch on the trackpad zooms, per pixel of the wheel event it sends. */
const PINCH_SENSITIVITY = 0.01;

/** Whether a pane cuts its graph off at its left and at its right edge. */
interface CutSides {
  readonly left: boolean;
  readonly right: boolean;
}

/**
 * Returns the sides at which `pane` cuts its graph off: the left once it is
 * scrolled right, and the right while more of the graph is past that edge.
 */
const findCutSides = (pane: HTMLElement): CutSides => ({
  left: pane.scrollLeft > 0,
  // The scroll width is rounded, so the last pixel does not count.
  right: pane.scrollLeft + pane.clientWidth < pane.scrollWidth - 1,
});

/** The words a screen reader says for each state, after the card's name. */
const STATE_WORDS: Record<GraphNodeState, string | undefined> = {
  none: undefined,
  unreached: "not reached",
  pending: "pending",
  working: "working",
  waiting: "waiting on you",
  done: "done",
  failed: "failed",
  cancelled: "cancelled",
  skipped: "skipped",
  fired: "fired",
  listening: "listening",
  quiet: "did not fire",
};

/** Returns the text of an edge's label: its condition, its limit, or both. */
const buildLabelText = (edge: GraphEdge): string | undefined =>
  [edge.condition, edge.limit].filter((part) => part !== undefined).join(" · ") || undefined;

/**
 * Returns the room the layout leaves for an edge's label. The room fits the
 * widest text the label can show in any run, `3/3` for a limit of 3, so a
 * picked run never moves a card.
 */
const measureLabelRoom = (edge: GraphEdge): Size | undefined => {
  const limit =
    edge.maxTraversals === undefined
      ? undefined
      : `${String(edge.maxTraversals)}/${String(edge.maxTraversals)}`;
  const text = [edge.condition, limit].filter((part) => part !== undefined).join(" · ");
  if (text === "") return undefined;
  const width = Math.ceil([...text].length * LABEL_FONT_SIZE * MONO_GLYPH_WIDTH);
  return { width: width + 2 * LABEL_PADDING, height: LABEL_HEIGHT };
};

/** Returns the class an edge is drawn with, and its arrowhead's, for how far the run came along it. */
const decideEdgeTone = (edge: GraphEdge): string =>
  edge.isFailedEdge
    ? "failed"
    : edge.travel === undefined || edge.travel === "notTaken"
      ? "plain"
      : edge.travel;

/** The arrowhead tones, one marker each. */
const ARROW_TONES = ["plain", "fired", "active", "notYet", "failed"] as const;

/**
 * Lays out `drawing` and returns where everything goes. The layout reads the
 * graph's structure only, never a run's progress, so every run of a workflow
 * draws its cards in the same places.
 */
const layOutDrawing = (drawing: WorkflowGraphDrawing) => {
  const layout = computeGraphLayout(
    [
      ...drawing.nodes.map((node) => ({ id: node.id, ...CARD })),
      ...(drawing.busId === undefined ? [] : [{ id: drawing.busId, ...BUS }]),
    ],
    drawing.edges.map((edge) => {
      const label = measureLabelRoom(edge);
      return {
        id: edge.id,
        from: edge.from,
        to: edge.to,
        ...(label === undefined ? {} : { label }),
        closesLoop: edge.maxTraversals !== undefined,
      };
    }),
    SIDE_MARGIN,
  );
  const hasEnd = drawing.nodes.some((node) => node.terminal);
  return {
    layout,
    size: { width: layout.size.width + (hasEnd ? END_ROOM : 0), height: layout.size.height },
  };
};

/** The states a card is dimmed in, `.wfg-node.is-unreached` and the rest in workflow-graph.css. */
const DIMMED_STATES: ReadonlySet<GraphNodeState> = new Set([
  "unreached",
  "quiet",
  "cancelled",
  "skipped",
]);

/**
 * How a node's state changed between two drawings: `brightened` when its
 * card was dimmed and no longer is, `dimmed` when the reverse, and `changed`
 * otherwise.
 */
type NodeChange = "brightened" | "dimmed" | "changed";

/** The states a card is ringed in, `.wfg-ring` in workflow-graph.css. */
const RINGED_STATES: ReadonlySet<GraphNodeState> = new Set(["waiting", "failed", "listening"]);

/**
 * Returns how each node whose state differs between two drawings of the same
 * graph changed, by node id. A node that is in only one of them has not
 * changed.
 */
const listChangedNodes = (
  before: WorkflowGraphDrawing,
  after: WorkflowGraphDrawing,
): ReadonlyMap<string, NodeChange> => {
  const states = new Map(before.nodes.map((node) => [node.id, node.state]));
  return new Map(
    after.nodes.flatMap((node): Array<[string, NodeChange]> => {
      const was = states.get(node.id);
      if (was === undefined || was === node.state) return [];
      const wasDimmed = DIMMED_STATES.has(was);
      const isDimmed = DIMMED_STATES.has(node.state);
      return [
        [
          node.id,
          wasDimmed && !isDimmed ? "brightened" : !wasDimmed && isDimmed ? "dimmed" : "changed",
        ],
      ];
    }),
  );
};

/** Keeps `value` between `min` and `max`. */
const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

/** The gap between a node and its card of details, and the space the card keeps from the window's edges. */
const CARD_GAP = 6;
const WINDOW_MARGIN = 8;

/**
 * Places the open card of details `card` under the node `anchor`, at its
 * left edge, or over it when the window has no room below. The card is kept
 * inside the window. Placing it above sets its `bottom`, so a card that
 * grows while it is open grows away from its node. A closed card has no
 * size, so it must be open.
 */
const placeNodeCard = (card: HTMLElement, anchor: HTMLElement): void => {
  const box = anchor.getBoundingClientRect();
  const fitsBelow = box.bottom + CARD_GAP + card.offsetHeight <= window.innerHeight - WINDOW_MARGIN;
  card.style.left = `${String(clamp(box.left, WINDOW_MARGIN, window.innerWidth - WINDOW_MARGIN - card.offsetWidth))}px`;
  card.style.top = fitsBelow ? `${String(box.bottom + CARD_GAP)}px` : "auto";
  card.style.bottom = fitsBelow ? "auto" : `${String(window.innerHeight - box.top + CARD_GAP)}px`;
};

/**
 * Draws a workflow's graph in a pane that zooms. The pane fits the whole graph
 * to its width when it opens, and never draws it larger than its own size.
 *
 * While the pane has focus, ⌘+ and ⌘− zoom in and out, ⌘0 shows the actual
 * size and ⌘9 fits the graph again, as in Preview. A pinch on the trackpad
 * zooms around the pointer. A zoomed graph scrolls inside the pane.
 *
 * A click on a node opens its card of details beside it; a click on another
 * node moves the card there, and a click on the same node, Escape, or a
 * click anywhere else closes it.
 */
export function WorkflowGraph({
  drawing,
  details,
  label,
  onOpenSession,
}: {
  readonly drawing: WorkflowGraphDrawing;
  /** The card of details of each node, by node id. */
  readonly details: ReadonlyMap<string, NodeDetails>;
  /** The graph's name for assistive technology, such as "Ship release, run of 14:02". */
  readonly label: string;
  /** Opens the transcript of a session, from a card of details. */
  readonly onOpenSession: (sessionId: string) => void;
}): JSX.Element {
  const id = useId().replace(/[^\w-]/g, "");
  const markerBase = `wfg-arrow-${id}`;
  const cardId = `wfg-card-${id}`;
  const { layout, size } = layOutDrawing(drawing);

  const paneRef = useRef<HTMLDivElement>(null);

  // Motion plays only on a graph on screen. A change to a graph scrolled out
  // of view applies at once, so nothing replays when it scrolls back.
  const [isOnScreen, setOnScreen] = useState(false);
  useEffect(() => {
    const observer = new IntersectionObserver((entries) => {
      setOnScreen(entries.some((entry) => entry.isIntersecting));
    });
    observer.observe(paneRef.current!);
    return () => {
      observer.disconnect();
    };
  }, []);

  // When a node's state changes while the graph is on screen, its mark pops
  // in, its ring fades in, and its card brightens or dims, so the drawing
  // keeps the previous one to compare with.
  const [previous, setPrevious] = useState(drawing);
  const [changed, setChanged] = useState<ReadonlyMap<string, NodeChange>>(new Map());
  if (previous !== drawing) {
    setChanged(isOnScreen ? listChangedNodes(previous, drawing) : new Map());
    setPrevious(drawing);
  }

  const [paneWidth, setPaneWidth] = useState<number | undefined>(undefined);
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

  // The graph opens at the zoom that fits its width to the pane, at most the
  // actual size and at least the smallest zoom that can be read. It follows
  // the pane's width until the user zooms.
  const fitScale =
    paneWidth === undefined ? 1 : clamp((paneWidth - 2 * PANE_PADDING) / size.width, MIN_SCALE, 1);
  const openingScale = Math.max(fitScale, OPENING_MIN_SCALE);
  const [zoom, setZoom] = useState<number | "opening">("opening");
  const scale = zoom === "opening" ? openingScale : zoom;
  // A graph that fits its pane at the actual size has nothing to zoom to.
  const canZoom = fitScale < 1;

  // A zoom keeps one point of the graph under the same point of the pane: the
  // pointer for a pinch, the pane's centre otherwise. The scroll that does so
  // is applied once the zoomed graph has rendered.
  const pendingScroll = useRef<Point | null>(null);
  useLayoutEffect(() => {
    const pane = paneRef.current!;
    if (pendingScroll.current !== null) {
      pane.scrollTo({ left: pendingScroll.current.x, top: pendingScroll.current.y });
      pendingScroll.current = null;
    }
  }, [scale]);

  const zoomTo = (next: number, anchor?: Point) => {
    const pane = paneRef.current!;
    const target = clamp(next, MIN_SCALE, MAX_SCALE);
    const at = anchor ?? { x: pane.clientWidth / 2, y: pane.clientHeight / 2 };
    const ratio = target / scale;
    pendingScroll.current = {
      x: (pane.scrollLeft + at.x - PANE_PADDING) * ratio + PANE_PADDING - at.x,
      y: (pane.scrollTop + at.y - PANE_PADDING) * ratio + PANE_PADDING - at.y,
    };
    setZoom(target);
  };

  // The pane fades a side it cuts the graph off at, so a card cut in half
  // reads as more graph that way and not as a fault. A scroll, a zoom and a
  // new pane width change the sides. Each side is its own state, so a
  // scroll that changes neither renders nothing.
  const [isCutLeft, setCutLeft] = useState(false);
  const [isCutRight, setCutRight] = useState(false);
  const showCutSides = (pane: HTMLElement) => {
    const sides = findCutSides(pane);
    setCutLeft(sides.left);
    setCutRight(sides.right);
  };
  const showCutSidesOfPane = useEffectEvent(() => {
    showCutSides(paneRef.current!);
  });
  useLayoutEffect(() => {
    showCutSidesOfPane();
  }, [scale, paneWidth, size.width]);

  // A pinch arrives as a wheel event with the control key down. The listener
  // is not passive, so it can stop the page from zooming or scrolling.
  const zoomWithPinch = useEffectEvent((event: WheelEvent) => {
    if (!event.ctrlKey) return;
    event.preventDefault();
    const box = paneRef.current!.getBoundingClientRect();
    zoomTo(scale * Math.exp(-event.deltaY * PINCH_SENSITIVITY), {
      x: event.clientX - box.left,
      y: event.clientY - box.top,
    });
  });
  useEffect(() => {
    const pane = paneRef.current!;
    const pinch = (event: WheelEvent) => {
      zoomWithPinch(event);
    };
    pane.addEventListener("wheel", pinch, { passive: false });
    return () => {
      pane.removeEventListener("wheel", pinch);
    };
  }, []);

  const zoomWithKeys = (event: KeyboardEvent) => {
    if (!event.metaKey) return;
    const next =
      event.key === "=" || event.key === "+"
        ? scale * ZOOM_STEP
        : event.key === "-"
          ? scale / ZOOM_STEP
          : event.key === "0"
            ? 1
            : event.key === "9"
              ? fitScale
              : undefined;
    if (next === undefined) return;
    event.preventDefault();
    zoomTo(next);
  };

  // One card of details serves every node. It is a popover, so it sits in
  // the top layer, above the pane that clips the graph, and closes on a click
  // elsewhere or on Escape. Each node is a button that targets it, which the
  // browser counts as inside the card: a click on a node never closes the
  // card by clicking outside it, only by the button's own toggle.
  const cardRef = useRef<HTMLDivElement>(null);
  const [openNodeId, setOpenNodeId] = useState<string | null>(null);
  const openNode = drawing.nodes.find((node) => node.id === openNodeId);
  const openDetails = openNodeId === null ? undefined : details.get(openNodeId);
  const pickNode = (event: MouseEvent<HTMLButtonElement>, nodeId: string) => {
    // The button's toggle closes the card that is open on this node.
    if (openNodeId === nodeId) {
      setOpenNodeId(null);
      return;
    }
    // On another node, the card closes here, so the button's toggle opens it
    // again for this node, and plays its opening again.
    const card = cardRef.current!;
    if (card.matches(":popover-open")) card.hidePopover();
    setOpenNodeId(nodeId);
    // The toggle opens the card after this handler, and the card has a size
    // only once it is open. The next frame comes before the card is painted.
    const anchor = event.currentTarget;
    requestAnimationFrame(() => {
      if (card.matches(":popover-open")) placeNodeCard(card, anchor);
    });
  };

  // The card follows its node: after every render, since a new run or a
  // zoom moves or grows it, and on any scroll or resize while it is open.
  const placeOpenCard = useEffectEvent(() => {
    const card = cardRef.current!;
    const anchor = paneRef.current!.querySelector<HTMLElement>(
      `[data-node-id="${CSS.escape(openNodeId ?? "")}"]`,
    );
    if (anchor !== null && card.matches(":popover-open")) placeNodeCard(card, anchor);
  });
  useLayoutEffect(() => {
    if (openNodeId !== null) placeOpenCard();
  });
  useEffect(() => {
    if (openNodeId === null) return;
    const follow = () => {
      placeOpenCard();
    };
    window.addEventListener("scroll", follow, { capture: true, passive: true });
    window.addEventListener("resize", follow);
    return () => {
      window.removeEventListener("scroll", follow, { capture: true });
      window.removeEventListener("resize", follow);
    };
  }, [openNodeId]);

  const paneHeight =
    Math.ceil(size.height * openingScale) + 2 * PANE_PADDING + (canZoom ? ZOOM_ROOM : 0);
  const nodePoints = layout.nodes;
  const busPoint = drawing.busId === undefined ? undefined : nodePoints.get(drawing.busId);
  const terminals = drawing.nodes.filter((node) => node.terminal);
  const endTone = (node: GraphNode) =>
    node.state === "none" ? "plain" : node.state === "done" ? "fired" : "notYet";

  return (
    <div className="wfg-frame">
      <div
        ref={paneRef}
        className={`wfg-pane${isCutLeft ? " is-cut-left" : ""}${isCutRight ? " is-cut-right" : ""}`}
        role="figure"
        aria-label={label}
        tabIndex={0}
        style={{ height: paneHeight }}
        onKeyDown={zoomWithKeys}
        onScroll={(event) => {
          showCutSides(event.currentTarget);
        }}
      >
        <div
          style={{
            width: Math.ceil(size.width * scale) + 2 * PANE_PADDING,
            height: Math.ceil(size.height * scale) + 2 * PANE_PADDING,
          }}
        >
          <div
            className="wfg"
            style={{
              width: size.width,
              height: size.height,
              transform: `translate(${String(PANE_PADDING)}px, ${String(PANE_PADDING)}px) scale(${String(scale)})`,
            }}
          >
            <svg
              className="wfg-edges"
              width={size.width}
              height={size.height}
              viewBox={`0 0 ${String(size.width)} ${String(size.height)}`}
              aria-hidden="true"
            >
              <defs>
                {ARROW_TONES.map((tone) => (
                  <marker
                    key={tone}
                    id={`${markerBase}-${tone}`}
                    viewBox="0 0 8 8"
                    refX="7"
                    refY="4"
                    markerWidth="7"
                    markerHeight="7"
                    orient="auto-start-reverse"
                  >
                    <path className={`wfg-arrow is-${tone}`} d="M1 1.2L7 4L1 6.8z" />
                  </marker>
                ))}
              </defs>
              {drawing.edges.map((edge) => {
                const tone = decideEdgeTone(edge);
                const showsArrow = edge.kind === "plan" && edge.to !== drawing.busId;
                return (
                  <path
                    key={edge.id}
                    className={`wfg-edge is-${tone}${edge.travel === "notTaken" ? " is-notTaken" : ""}${edge.kind === "correlation" ? " wfg-edge--correlation" : ""}`}
                    d={buildCurve(layout.edges.get(edge.id)!.points)}
                    markerEnd={showsArrow ? `url(#${markerBase}-${tone})` : undefined}
                  />
                );
              })}
              {busPoint === undefined ? null : (
                <circle
                  className="wfg-bus"
                  cx={busPoint.x}
                  cy={busPoint.y + BUS.height / 2}
                  r="2.5"
                />
              )}
              {terminals.map((node) => {
                const point = nodePoints.get(node.id)!;
                const x = point.x + CARD.width;
                const y = point.y + CARD.height / 2;
                return (
                  <g key={node.id}>
                    <path
                      className={`wfg-edge is-${endTone(node)}`}
                      d={`M${String(x)} ${String(y)}h${String(END_STUB)}`}
                    />
                    <circle
                      className="wfg-end"
                      cx={x + END_STUB + END_RADIUS}
                      cy={y}
                      r={END_RADIUS}
                    />
                  </g>
                );
              })}
            </svg>
            {drawing.edges.map((edge) => {
              const text = buildLabelText(edge);
              const centre = layout.edges.get(edge.id)!.label;
              if (text === undefined || centre === undefined) return null;
              return (
                <span
                  key={edge.id}
                  className={`wfg-label is-${decideEdgeTone(edge)}`}
                  style={{ left: centre.x, top: centre.y, transform: "translate(-50%, -50%)" }}
                  title={edge.fullCondition}
                >
                  {text}
                </span>
              );
            })}
            {drawing.nodes.map((node) => {
              const point = nodePoints.get(node.id)!;
              const mark = NODE_MARKS[node.state];
              const stateWords = STATE_WORDS[node.state];
              const change = changed.get(node.id);
              // The ring and the mark are keyed by the node's state, so a new
              // state mounts them again and their arrival plays once.
              return (
                <button
                  key={node.id}
                  type="button"
                  className={`wfg-node wfg-node--${node.kind === "agent" || node.kind === "action" ? "step" : "trigger"} is-${node.state}${change === "brightened" ? " is-brightening" : change === "dimmed" ? " is-dimming" : ""}${openNodeId === node.id ? " is-open" : ""}`}
                  style={{ left: point.x, top: point.y, width: CARD.width, height: CARD.height }}
                  data-node-id={node.id}
                  popoverTarget={cardId}
                  aria-expanded={openNodeId === node.id}
                  aria-label={[node.id, node.detail, stateWords].filter(Boolean).join(", ")}
                  title={`${node.id}\n${node.detail}`}
                  onClick={(event) => {
                    pickNode(event, node.id);
                  }}
                >
                  {RINGED_STATES.has(node.state) ? (
                    <span
                      key={`ring-${node.state}`}
                      className={`wfg-ring${change === undefined ? "" : " is-new"}`}
                    />
                  ) : null}
                  {node.joinsAll ? <span className="wfg-join">all</span> : null}
                  <span className="wfg-lead">
                    <NodeIcon kind={node.kind} firesOnSchedule={node.firesOnSchedule} />
                  </span>
                  <span className="wfg-text">
                    <span className="wfg-title">
                      <b>{node.id}</b>
                      {node.iterationLabel === undefined ? null : (
                        <span className="wfg-iteration">{node.iterationLabel}</span>
                      )}
                    </span>
                    <span className="wfg-detail">{node.detail}</span>
                  </span>
                  {mark === undefined ? null : (
                    <span
                      key={`mark-${node.state}`}
                      className={`wfg-mark${change === undefined ? "" : " is-new"}`}
                    >
                      <Mark state={mark} />
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </div>
      <div
        ref={cardRef}
        id={cardId}
        popover="auto"
        className="pop wfn"
        aria-label={openNode === undefined ? undefined : `${openNode.id}, details`}
        onToggle={(event) => {
          // The toggle event arrives a task after the card closed. By then a
          // click on another node may have opened it again.
          if (event.newState === "closed" && !event.currentTarget.matches(":popover-open")) {
            setOpenNodeId(null);
          }
        }}
      >
        {openNode === undefined || openDetails === undefined ? null : (
          <NodeCard node={openNode} details={openDetails} onOpenSession={onOpenSession} />
        )}
      </div>
      {canZoom ? (
        <div className="pill wfg-zoom">
          <button
            type="button"
            className="icon-btn"
            aria-label="Zoom out"
            title="Zoom out (⌘−)"
            disabled={scale <= MIN_SCALE}
            onClick={() => {
              zoomTo(scale / ZOOM_STEP);
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
            disabled={scale >= MAX_SCALE}
            onClick={() => {
              zoomTo(scale * ZOOM_STEP);
            }}
          >
            <PlusIcon size={14} />
          </button>
          <button
            type="button"
            className="btn btn--quiet btn--sm"
            title="Fit the graph to the pane (⌘9)"
            disabled={scale === fitScale}
            onClick={() => {
              zoomTo(fitScale);
            }}
          >
            Fit
          </button>
        </div>
      ) : null}
    </div>
  );
}
