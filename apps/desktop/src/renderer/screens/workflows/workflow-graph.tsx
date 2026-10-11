/**
 * Draws a workflow's graph: its triggers and steps as cards, and the edges
 * between them (spec 17 §Workflows, "The open workflow"). It draws no run.
 * Every node and edge keeps the id the graph model gives it, which a run's
 * page will use to draw the run's state on it.
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
} from "react";
import { buildCurve } from "@hercule/client-core/graph-layout";
import type { GraphEdge, WorkflowGraphDrawing } from "@hercule/client-core/graph-model";
import type { NodeCard } from "@hercule/client-core/node-details";
import { MinusIcon } from "../../icons/minus";
import { PlusIcon } from "../../icons/plus";
import { NodeCardContent } from "./node-card";
import { NodeIcon } from "./node-icon";
import { BUS, CARD, END_RADIUS, END_STUB, layOutGraphDrawing } from "./workflow-graph-layout";
import "./workflow-graph.css";

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

/** Renders an edge's label: its condition in mono, then its limit, such as "≤ 3", in the UI face. */
function EdgeLabel({
  edge,
  left,
  top,
}: {
  readonly edge: GraphEdge;
  readonly left: number;
  readonly top: number;
}): JSX.Element {
  const isLimitOnly = edge.condition === undefined;
  return (
    <span
      className={`edge-label${isLimitOnly ? " edge-label--count" : ""}`}
      style={{ left, top }}
      title={edge.fullCondition}
    >
      {isLimitOnly ? edge.limit : edge.condition}
      {!isLimitOnly && edge.limit !== undefined ? (
        <span className="edge-label--count">{` · ${edge.limit}`}</span>
      ) : null}
    </span>
  );
}

/**
 * Draws `drawing` in a pane that zooms. `readCard` returns the card of a
 * node by its id, and `timezone` is the zone its times are shown in. `label`
 * names the graph for assistive technology, such as "The steps of Ship
 * release".
 *
 * - The graph opens fitted to the pane's width, never below 80% and never
 *   above 100%, and follows the pane's width until the user zooms. The zoom
 *   pill shows only when the graph is wider than the pane at 100%.
 * - While the pane or a node in it has focus, ⌘= or ⌘+, ⌘-, ⌘0 and ⇧1 zoom
 *   in, out, to 100% and to fit. A text field is never inside the pane, so
 *   the keys never reach one.
 * - A side where the pane cuts the graph off fades out over 48px.
 * - A click on a node opens its card under it. A click on the same node,
 *   Escape, or a click anywhere else closes it. Escape returns focus to the
 *   node, and is not passed on, so the page does not also close.
 */
export function WorkflowGraph({
  drawing,
  readCard,
  timezone,
  label,
}: {
  readonly drawing: WorkflowGraphDrawing;
  readonly readCard: (nodeId: string) => NodeCard | undefined;
  readonly timezone: string;
  readonly label: string;
}): JSX.Element {
  const id = useId().replace(/[^\w-]/g, "");
  const arrowId = `graph-arrow-${id}`;
  const cardId = `graph-card-${id}`;
  const { layout, size } = layOutGraphDrawing(drawing);

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

  const placeOpenCard = useEffectEvent(() => {
    const anchor = openNodeId === undefined ? undefined : nodeRefs.current.get(openNodeId);
    if (anchor !== undefined) placeNodeCard(cardRef.current!, anchor);
  });
  useLayoutEffect(() => {
    cardRef.current!.togglePopover(isOpen);
    if (isOpen) placeOpenCard();
  }, [isOpen, openNodeId, scale]);

  const closeWithEscape = useEffectEvent((event: globalThis.KeyboardEvent) => {
    if (event.key !== "Escape") return;
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
                <marker
                  id={arrowId}
                  viewBox="0 0 8 8"
                  refX="7"
                  refY="4"
                  markerWidth="7"
                  markerHeight="7"
                  orient="auto-start-reverse"
                >
                  <path className="arrow" d="M1 1.2L7 4L1 6.8z" />
                </marker>
              </defs>
              {drawing.edges.map((edge) => (
                <path
                  key={edge.id}
                  className={`edge${edge.kind === "correlation" ? " edge--signal" : ""}`}
                  d={buildCurve(layout.edges.get(edge.id)!.points)}
                  // The edges into the junction meet at its dot, with no arrowhead.
                  markerEnd={
                    edge.kind === "plan" && edge.to !== drawing.busId
                      ? `url(#${arrowId})`
                      : undefined
                  }
                />
              ))}
              {busPoint === undefined ? null : (
                <circle className="bus" cx={busPoint.x} cy={busPoint.y + BUS.height / 2} r="2.5" />
              )}
              {drawing.nodes
                .filter((node) => node.terminal)
                .map((node) => {
                  const point = layout.nodes.get(node.id)!;
                  const x = point.x + CARD.width;
                  const y = point.y + CARD.height / 2;
                  return (
                    <g key={node.id}>
                      <path className="edge" d={`M${String(x)} ${String(y)}h${String(END_STUB)}`} />
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
              return <EdgeLabel key={edge.id} edge={edge} left={centre.x} top={centre.y} />;
            })}
            {drawing.nodes.map((node) => {
              const point = layout.nodes.get(node.id)!;
              const isStep = node.kind === "agent" || node.kind === "action";
              const isNodeOpen = isOpen && openNodeId === node.id;
              return (
                <button
                  key={node.id}
                  ref={(element) => {
                    if (element === null) nodeRefs.current.delete(node.id);
                    else nodeRefs.current.set(node.id, element);
                  }}
                  type="button"
                  className={`node ${isStep ? "node--step" : "node--trigger"}${isNodeOpen ? " is-open" : ""}`}
                  style={{ left: point.x, top: point.y }}
                  aria-label={`${node.id}, ${node.detail}`}
                  aria-haspopup="dialog"
                  aria-expanded={isNodeOpen}
                  aria-controls={cardId}
                  title={`${node.id}\n${node.detail}`}
                  onClick={() => {
                    setOpenNodeId(isNodeOpen ? undefined : node.id);
                  }}
                >
                  {node.joinsAll ? <span className="node-join">all</span> : null}
                  <span className="node-lead">
                    <NodeIcon kind={node.kind} firesOn={node.firesOn} />
                  </span>
                  <span className="node-text">
                    <span className="node-title">
                      <b>{node.id}</b>
                    </span>
                    <span className="node-detail">{node.detail}</span>
                  </span>
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
        className="pop node-pop"
        aria-label={isOpen ? `${openCard.id}, ${openCard.kindText}` : undefined}
      >
        {isOpen ? <NodeCardContent card={openCard} timezone={timezone} /> : null}
      </div>
    </div>
  );
}
