/* eslint-disable no-restricted-imports -- PROTOTYPE: a copy of the #78 GraphView that reuses its layout; the real run graph will live inside graph-view/. */
/**
 * PROTOTYPE - throwaway (P021 run graph, branch prototype/P021-run-graph).
 *
 * A copy of `screens/workflow-editor/graph-view/graph-view.tsx` (#78), cut
 * down to what a run's plan needs (no edge labels) and extended with a step
 * state per card and a travel state per edge. It reuses the #78 layout
 * unchanged. Four variants draw the same state differently:
 *
 * - A calm: marks in the card's leading slot, travelled edges solid, the rest dashed.
 * - B flowing: dashes flow along the active edge, a light runs round the running card.
 * - C spotlight: the camera follows the current step, everything else steps back.
 * - D timeline: marks and start order on the cards; the time lives in the ledger below.
 */
import "@xyflow/react/dist/base.css";
import "./run-graph.css";
import {
  useEffect,
  useEffectEvent,
  useId,
  useMemo,
  useRef,
  useSyncExternalStore,
  type JSX,
  type ReactNode,
} from "react";
import {
  BaseEdge,
  Handle,
  Panel,
  Position,
  ReactFlow,
  getViewportForBounds,
  useReactFlow,
  useStore,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import type { WorkflowGraph, WorkflowGraphNode } from "@hercule/client-core";
import {
  Button,
  CancelledMark,
  DoneMark,
  FailedMark,
  QueuedMark,
  WorkingMark,
  cn,
} from "@hercule/ui";
import {
  computeDrawingViewport,
  computeGraphLayout,
  LARGEST_PLACED_ZOOM,
  type EdgeRoute,
  type Point,
  type Size,
} from "../screens/workflow-editor/graph-view/layout";
import {
  decideEdgeTravel,
  formatSeconds,
  type EdgeTravel,
  type RunStatus,
  type StepState,
  type StepView,
} from "./run-data";

export type Variant = "A" | "B" | "C" | "D";

const MONO_GLYPH_WIDTH = 0.6;
const measureMonoText = (text: string, fontSize: number): number =>
  Math.ceil([...text].length * fontSize * MONO_GLYPH_WIDTH);

const CARD_HEIGHT = 52;
const MIN_CARD_WIDTH = 136;
const ID_FONT_SIZE = 12.5;
const CARD_PADDING = 12;
const CARD_BORDER = 1;
const CARD_CORNER_RADIUS = 10;
const ARROWHEAD_SIZE = 9;
const SIDE_MARGIN = CARD_CORNER_RADIUS + ARROWHEAD_SIZE / 2;
/** The leading slot for a step's state mark: the 12px mark and the gap after it. */
const MARK_SLOT = 12 + 9;
/** The trailing duration column in variant B. */
const DURATION_SLOT = 54;

const EDGE_COLOUR = "color-mix(in oklch, var(--faint), var(--muted) 20%)";
/** A travelled edge: the muted colour pulled towards ink, so the path the run took reads first. */
const TRAVELLED_COLOUR = "color-mix(in oklch, var(--muted), var(--ink) 30%)";
const LIVE_COLOUR = "var(--live)";

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 1.5;
const FIT_PADDING = 0.08;
/** The zoom variant C moves the camera to around the current step. */
const SPOTLIGHT_ZOOM = 1.4;

const KIND_LABELS: Record<WorkflowGraphNode["kind"], string> = {
  start: "Start trigger",
  signal: "Signal trigger",
  action: "Action step",
  agent: "Agent step",
};

const isTrigger = (node: WorkflowGraphNode): boolean =>
  node.kind === "start" || node.kind === "signal";

/** Variant D: room for the start order (`#2 `) before the kind label. */
const ORDER_SLOT = 24;

const measureCard = (node: WorkflowGraphNode, variant: Variant): Size => {
  const extra = isTrigger(node)
    ? 0
    : MARK_SLOT + (variant === "B" ? DURATION_SLOT : 0) + (variant === "D" ? ORDER_SLOT : 0);
  return {
    width:
      Math.max(
        MIN_CARD_WIDTH,
        measureMonoText(node.id, ID_FONT_SIZE) + 2 * (CARD_PADDING + CARD_BORDER),
      ) + extra,
    height: CARD_HEIGHT,
  };
};

const formatCoordinate = (value: number): string => String(Math.round(value * 10) / 10);
const formatPoint = ({ x, y }: Point): string => `${formatCoordinate(x)},${formatCoordinate(y)}`;

/** The same B-spline the #78 graph draws. */
const buildCurve = (points: ReadonlyArray<Point>): string => {
  const [first, second] = [points[0]!, points[1]!];
  let path = `M${formatPoint(first)} L${formatPoint({ x: (5 * first.x + second.x) / 6, y: (5 * first.y + second.y) / 6 })}`;
  let [a, b] = [first, second];
  for (const next of [...points.slice(2), points.at(-1)!]) {
    path +=
      ` C${formatPoint({ x: (2 * a.x + b.x) / 3, y: (2 * a.y + b.y) / 3 })}` +
      ` ${formatPoint({ x: (a.x + 2 * b.x) / 3, y: (a.y + 2 * b.y) / 3 })}` +
      ` ${formatPoint({ x: (a.x + 4 * b.x + next.x) / 6, y: (a.y + 4 * b.y + next.y) / 6 })}`;
    [a, b] = [b, next];
  }
  return `${path} L${formatPoint(b)}`;
};

/** Whether the visitor asked the system for less motion. */
export const usePrefersReducedMotion = (): boolean =>
  useSyncExternalStore(
    (onChange) => {
      const query = window.matchMedia("(prefers-reduced-motion: reduce)");
      query.addEventListener("change", onChange);
      return () => query.removeEventListener("change", onChange);
    },
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );

/** The state mark for a step, or nothing for a step with no record. */
export function StepStateMark({ state }: { readonly state: StepState }): JSX.Element | null {
  switch (state) {
    case "pending":
      return <QueuedMark />;
    case "running":
      return <WorkingMark />;
    case "completed":
      return <DoneMark />;
    case "failed":
      return <FailedMark />;
    case "cancelled":
      return <CancelledMark />;
    case "unreached":
      return null;
  }
}

/** Returns how long a step has run, or ran, at `clock`, or `undefined` before it started. */
export const measureStepSeconds = (view: StepView, clock: number): number | undefined => {
  const startedAt = view.record?.startedAt;
  if (startedAt === undefined) return undefined;
  return (view.record?.finishedAt ?? clock) - startedAt;
};

/** What each card knows when it renders. */
interface CardData extends Record<string, unknown> {
  readonly node: WorkflowGraphNode;
  readonly view: StepView;
  readonly variant: Variant;
  readonly clock: number;
  readonly runStatus: RunStatus;
  /** Variant C: whether this card is the one in the spotlight. */
  readonly isFocus: boolean;
  /** Variant C: whether any card is in the spotlight. */
  readonly hasFocus: boolean;
  readonly reducedMotion: boolean;
}

type DrawnNode = Node<CardData, "card">;

interface CurveData extends Record<string, unknown> {
  readonly route: EdgeRoute;
  readonly travel: EdgeTravel;
  readonly variant: Variant;
  readonly markerBase: string;
  readonly hasFocus: boolean;
  /** Variant C: whether the edge leads into the card in the spotlight. */
  readonly leadsToFocus: boolean;
  readonly reducedMotion: boolean;
}

type DrawnEdge = Edge<CurveData, "route">;

const HANDLES = [
  { id: "left-in", type: "target", position: Position.Left },
  { id: "left-out", type: "source", position: Position.Left },
  { id: "right-in", type: "target", position: Position.Right },
  { id: "right-out", type: "source", position: Position.Right },
] as const;

const isFinished = (status: RunStatus): boolean =>
  status === "completed" || status === "failed" || status === "cancelled";

/** The hue of a step's state word: live, failed, or none. */
const STATE_WORD_CLASS: Partial<Record<StepState, string>> = {
  running: "text-live",
  failed: "text-fail",
};

function RunNodeCard({ data }: NodeProps<DrawnNode>): JSX.Element {
  const { node, view, variant, clock, runStatus, isFocus, hasFocus, reducedMotion } = data;
  const trigger = isTrigger(node);
  const { state } = view;
  const unreached = state === "unreached";
  const seconds = measureStepSeconds(view, clock);

  const handles = HANDLES.map((handle) => (
    <Handle
      key={handle.id}
      id={handle.id}
      type={handle.type}
      position={handle.position}
      isConnectable={false}
      className="invisible"
    />
  ));

  // Variant C: every card but the one in the spotlight steps back. A finished
  // run has no spotlight, and then every card shows at full strength.
  const recede =
    variant === "C" && hasFocus && !isFocus
      ? state === "completed"
        ? "opacity-55"
        : "opacity-40"
      : unreached && isFinished(runStatus)
        ? "opacity-60"
        : undefined;

  const kindLine =
    variant === "C" && isFocus ? (
      <span className={`tracking-[0.02em] normal-case ${SPOT_WORD_CLASS[state] ?? "text-muted"}`}>
        {describeFocus(state, seconds)}
      </span>
    ) : variant === "D" && view.order !== undefined ? (
      <span className="flex items-baseline gap-1.5 truncate">
        <span className="font-mono text-label tracking-normal text-muted normal-case">
          {`#${String(view.order)}`}
        </span>
        <span>{KIND_LABELS[node.kind]}</span>
      </span>
    ) : (
      KIND_LABELS[node.kind]
    );

  const spotHue =
    state === "failed" ? "var(--fail)" : state === "cancelled" ? "var(--faint)" : "var(--live)";

  return (
    <div
      style={{
        paddingInline: CARD_PADDING,
        ...(variant === "C" && isFocus ? { ["--spot" as string]: spotHue } : {}),
        ...(variant === "A" && state === "running"
          ? { borderColor: "color-mix(in oklch, var(--live) 60%, var(--line))" }
          : {}),
      }}
      data-state={state}
      className={cn(
        "relative flex h-full w-full items-center rounded-card border border-line transition-opacity duration-500",
        trigger || unreached ? "bg-surface" : "bg-raised shadow-card",
        unreached && "border-dashed border-[color-mix(in_oklch,var(--faint)_60%,transparent)]",
        recede,
        variant === "B" && state === "running" && "proto-beam",
        variant === "C" && isFocus && "proto-spot",
        variant === "C" && isFocus && !reducedMotion && state === "running" && "proto-spot-breathe",
      )}
    >
      {handles}
      {trigger ? null : (
        <span className="flex w-[21px] shrink-0 items-center" aria-hidden="true">
          <StepStateMark state={state} />
        </span>
      )}
      <span className="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
        <span className="truncate text-label leading-[14px] font-emph tracking-[0.1em] text-faint uppercase">
          {kindLine}
        </span>
        <span
          className={`truncate font-mono text-meta leading-5 font-emph ${unreached ? "text-muted" : "text-ink"}`}
        >
          {node.id}
        </span>
      </span>
      {variant === "B" && !trigger ? (
        <span
          className={cn(
            "ml-2 w-[46px] shrink-0 text-right font-mono text-fine tabular-nums",
            STATE_WORD_CLASS[state] ?? "text-faint",
          )}
        >
          {seconds !== undefined ? formatSeconds(seconds) : state === "pending" ? "queued" : ""}
        </span>
      ) : null}
      {variant === "C" && isFocus ? <SpotlightBeacon state={state} /> : null}
    </div>
  );
}

/** Variant C: the kind line of the card in the spotlight says where the run is. */
const describeFocus = (state: StepState, seconds: number | undefined): string =>
  state === "running"
    ? `running · ${formatSeconds(seconds ?? 0)}`
    : state === "pending"
      ? "runs next"
      : state === "failed"
        ? `failed after ${formatSeconds(seconds ?? 0)}`
        : "cancelled here";

const SPOT_WORD_CLASS: Partial<Record<StepState, string>> = {
  running: "text-live",
  failed: "text-fail",
};

/**
 * Variant C: the "you are here" beacon on the top-right corner of the card in
 * the spotlight. While the step runs, a ring pulses out of it.
 */
function SpotlightBeacon({ state }: { readonly state: StepState }): JSX.Element {
  const hue = state === "failed" ? "bg-fail" : state === "running" ? "bg-live" : "bg-faint";
  return (
    <span className="absolute -top-[5px] -right-[5px] flex size-2.5" aria-hidden="true">
      {state === "running" ? (
        <span className={`proto-beacon absolute inset-0 rounded-full ${hue}`} />
      ) : null}
      <span className={`relative size-2.5 rounded-full ${hue} ring-2 ring-surface`} />
    </span>
  );
}

const TONE_OF: Record<EdgeTravel, "faint" | "strong" | "live"> = {
  untravelled: "faint",
  travelled: "strong",
  active: "strong",
};

function RunEdgeCurve({ id, data }: EdgeProps<DrawnEdge>): JSX.Element | null {
  const cometMotion = useRef<SVGAnimateMotionElement>(null);
  const cometFade = useRef<SVGAnimateElement>(null);
  const previousTravel = useRef<EdgeTravel | undefined>(undefined);
  const travel = data?.travel;
  // Variant B: when the run goes along an edge, a comet runs down it once.
  // SMIL animations inserted after the page loaded would start in the past,
  // so each one is started by hand.
  useEffect(() => {
    const wasUntravelled = previousTravel.current === "untravelled";
    previousTravel.current = travel;
    if (wasUntravelled && travel !== "untravelled") {
      cometMotion.current?.beginElement();
      cometFade.current?.beginElement();
    }
  }, [travel]);

  if (data === undefined) return null;
  const { route, variant, markerBase, hasFocus, leadsToFocus, reducedMotion } = data;
  const path = buildCurve(route.points);

  let tone = TONE_OF[data.travel];
  let dashed = false;
  let flowing = false;
  let width = 1.15;
  let opacity = 1;
  switch (variant) {
    case "A":
    case "D":
      dashed = data.travel === "untravelled";
      if (data.travel === "active") tone = "live";
      if (data.travel !== "untravelled") width = 1.4;
      break;
    case "B":
      if (data.travel === "active") {
        tone = "live";
        flowing = !reducedMotion;
        dashed = reducedMotion;
      }
      if (data.travel !== "untravelled") width = 1.5;
      break;
    case "C":
      if (leadsToFocus) tone = "live";
      if (data.travel !== "untravelled") width = 1.4;
      if (hasFocus && !leadsToFocus) opacity = data.travel === "untravelled" ? 0.4 : 0.6;
      break;
  }
  const stroke = tone === "live" ? LIVE_COLOUR : tone === "strong" ? TRAVELLED_COLOUR : EDGE_COLOUR;

  return (
    <g style={{ opacity }} className="transition-opacity duration-500">
      <BaseEdge
        id={id}
        path={path}
        markerEnd={`url(#${markerBase}-${tone})`}
        className={flowing ? "proto-flow" : undefined}
        style={{
          stroke,
          strokeWidth: width,
          ...(dashed ? { strokeDasharray: "3 4" } : {}),
          transition: "stroke 400ms",
        }}
      />
      {variant === "B" && !reducedMotion ? (
        <circle r={3} fill="var(--live)" opacity={0}>
          <animateMotion
            ref={cometMotion}
            dur="0.9s"
            begin="indefinite"
            fill="freeze"
            path={path}
            calcMode="spline"
            keyTimes="0;1"
            keySplines="0.4 0 0.2 1"
          />
          <animate
            ref={cometFade}
            attributeName="opacity"
            values="0;1;1;0"
            keyTimes="0;0.1;0.8;1"
            dur="0.9s"
            begin="indefinite"
            fill="freeze"
          />
        </circle>
      ) : null}
    </g>
  );
}

const NODE_TYPES = { card: RunNodeCard };
const EDGE_TYPES = { route: RunEdgeCurve };

function ArrowMarkers({ base }: { readonly base: string }): JSX.Element {
  const tones = { faint: EDGE_COLOUR, strong: TRAVELLED_COLOUR, live: LIVE_COLOUR } as const;
  return (
    <svg width={0} height={0} className="absolute" aria-hidden="true">
      <defs>
        {Object.entries(tones).map(([tone, colour]) => (
          <marker
            key={tone}
            id={`${base}-${tone}`}
            viewBox="0 0 10 10"
            refX={9}
            refY={5}
            markerWidth={ARROWHEAD_SIZE}
            markerHeight={ARROWHEAD_SIZE}
            markerUnits="userSpaceOnUse"
            orient="auto-start-reverse"
          >
            <path
              d="M2 1.5 9 5 2 8.5"
              fill="none"
              stroke={colour}
              strokeWidth={1.3}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </marker>
        ))}
      </defs>
    </svg>
  );
}

/**
 * Places the drawing like the #78 graph does. In variant C, while a step is in
 * the spotlight, the camera moves to centre that step instead.
 */
function DrawingPlacement({
  size,
  focus,
  reducedMotion,
}: {
  readonly size: Size;
  readonly focus: { readonly x: number; readonly y: number } | undefined;
  readonly reducedMotion: boolean;
}): JSX.Element {
  const { setViewport } = useReactFlow();
  const paneWidth = useStore((state) => state.width);
  const paneHeight = useStore((state) => state.height);
  const place = useEffectEvent(() => {
    if (paneWidth === 0 || paneHeight === 0) return;
    const duration = reducedMotion ? 0 : 700;
    if (focus === undefined) {
      void setViewport(computeDrawingViewport({ width: paneWidth, height: paneHeight }, size), {
        duration,
      });
      return;
    }
    void setViewport(
      {
        x: paneWidth / 2 - focus.x * SPOTLIGHT_ZOOM,
        y: paneHeight / 2 - focus.y * SPOTLIGHT_ZOOM,
        zoom: SPOTLIGHT_ZOOM,
      },
      { duration },
    );
  });
  useEffect(() => {
    place();
  }, [paneWidth, paneHeight, focus?.x, focus?.y]);
  const fitToView = () => {
    if (paneWidth === 0 || paneHeight === 0) return;
    void setViewport(
      getViewportForBounds(
        { x: 0, y: 0, ...size },
        paneWidth,
        paneHeight,
        MIN_ZOOM,
        LARGEST_PLACED_ZOOM,
        FIT_PADDING,
      ),
    );
  };
  return (
    <Panel position="bottom-right" className="m-2!">
      <Button variant="quiet" className="text-meta" onClick={fitToView}>
        Fit to view
      </Button>
    </Panel>
  );
}

/**
 * Variant C: the step in the spotlight. The running step, else the queued step
 * that runs next, else the step the run stopped at. A completed run has none.
 */
const findFocusStep = (
  views: ReadonlyMap<string, StepView>,
  runStatus: RunStatus,
): string | undefined => {
  if (runStatus === "completed") return undefined;
  const entries = [...views.entries()];
  const pick = (state: StepState) => entries.find(([, view]) => view.state === state)?.[0];
  if (runStatus === "failed") return pick("failed");
  if (runStatus === "cancelled")
    return entries.find(
      ([, view]) => view.state === "cancelled" && view.record?.startedAt !== undefined,
    )?.[0];
  return pick("running") ?? pick("pending");
};

export function RunGraphView({
  graph,
  variant,
  views,
  clock,
  runStatus,
  overlay,
}: {
  readonly graph: WorkflowGraph;
  readonly variant: Variant;
  readonly views: ReadonlyMap<string, StepView>;
  readonly clock: number;
  readonly runStatus: RunStatus;
  /** Drawn over the pane's top-left corner, outside the drawing. */
  readonly overlay?: ReactNode;
}): JSX.Element {
  const markerBase = `run-arrow-${useId().replace(/[^\w-]/g, "")}`;
  const reducedMotion = usePrefersReducedMotion();

  const layout = useMemo(() => {
    const edges = graph.edges.map((edge, index) => ({ id: `edge-${String(index)}`, edge }));
    const computed = computeGraphLayout(
      graph.nodes.map((node) => ({ id: node.id, ...measureCard(node, variant) })),
      edges.map(({ id, edge }) => ({ id, from: edge.from, to: edge.to })),
      SIDE_MARGIN,
    );
    return { edges, computed };
  }, [graph, variant]);

  const focusId = variant === "C" ? findFocusStep(views, runStatus) : undefined;

  const nodes: Array<DrawnNode> = graph.nodes.map((node) => {
    const size = measureCard(node, variant);
    return {
      id: node.id,
      type: "card",
      position: layout.computed.nodes.get(node.id)!,
      data: {
        node,
        view: views.get(node.id) ?? { state: "unreached" },
        variant,
        clock,
        runStatus,
        isFocus: node.id === focusId,
        hasFocus: focusId !== undefined,
        reducedMotion,
      },
      ...size,
      handles: HANDLES.map((handle) => ({
        ...handle,
        x: handle.position === Position.Left ? 0 : size.width,
        y: size.height / 2,
      })),
    };
  });

  const edges: Array<DrawnEdge> = layout.edges.map(({ id, edge }) => {
    const route = layout.computed.edges.get(id)!;
    const sourceSide = route.points[1]!.x > route.points[0]!.x ? "right" : "left";
    const targetSide = route.points.at(-2)!.x < route.points.at(-1)!.x ? "left" : "right";
    return {
      id,
      type: "route",
      source: edge.from,
      target: edge.to,
      sourceHandle: `${sourceSide}-out`,
      targetHandle: `${targetSide}-in`,
      data: {
        route,
        travel: decideEdgeTravel(edge.to, views),
        variant,
        markerBase,
        hasFocus: focusId !== undefined,
        leadsToFocus: edge.to === focusId,
        reducedMotion,
      },
    };
  });

  // The camera follows the run while it is live. A finished run is shown
  // whole, with the step it stopped at still in the spotlight.
  const followId = isFinished(runStatus) ? undefined : focusId;
  const focusCentre = useMemo(() => {
    const focusId = followId;
    if (focusId === undefined) return undefined;
    const corner = layout.computed.nodes.get(focusId)!;
    const size = measureCard(
      graph.nodes.find((node) => node.id === focusId)!,
      variant,
    );
    return { x: corner.x + size.width / 2, y: corner.y + size.height / 2 };
  }, [followId, layout, graph, variant]);

  return (
    <div className="relative h-full w-full">
      <ArrowMarkers base={markerBase} />
      {overlay}
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        minZoom={MIN_ZOOM}
        maxZoom={MAX_ZOOM}
        nodesDraggable={false}
        nodesConnectable={false}
        nodesFocusable={false}
        edgesFocusable={false}
        elementsSelectable={false}
        proOptions={{ hideAttribution: true }}
      >
        <DrawingPlacement
          size={layout.computed.size}
          focus={focusCentre}
          reducedMotion={reducedMotion}
        />
      </ReactFlow>
    </div>
  );
}
