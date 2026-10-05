/**
 * PROTOTYPE (#354), throwaway. What the three variants share: the view state,
 * the subagents as the user has changed them (stopped), the Request pager,
 * the subagent's face and state, and the thread screen with hooks for each
 * variant's parts.
 */
import { useRef, useState, useSyncExternalStore, type JSX, type ReactNode } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import {
  buildThreadBlocks,
  decideThreadPose,
  describeAgent,
  type Pose,
  type ThreadBlock,
} from "@hercule/client-core";
import type { HerculeClient } from "@hercule/client-core";
import type { Session } from "@hercule/contract";
import {
  providersQuery,
  runnersQuery,
  sessionQuery,
  threadsQuery,
  transcriptQuery,
} from "../../app/queries";
import { buildLook, Face } from "../../faces";
import { Mark } from "../../marks";
import { StopIcon } from "../../icons/stop";
import { ChevronRightIcon } from "../../icons/chevron-right";
import { ThreadComposer } from "../../screens/thread/composer";
import { RequestDock } from "../../screens/thread/dock";
import { ThreadHeader } from "../../screens/thread/thread-header";
import {
  Transcript,
  type PrototypeBlock,
  type TranscriptHandle,
} from "../../screens/thread/transcript";
import { useThreadLive } from "../../screens/thread/use-thread-live";
import "../../screens/thread/thread.css";
import { SPECIMEN_NOW } from "../sidebar-fixture";
import {
  buildScenario,
  THREAD_ID,
  type ProtoRequest,
  type ProtoSubagent,
  type Scenario,
} from "./fixture";

// ---------------------------------------------------------------- the store

export type VariantKey = "A" | "B" | "C";

export const VARIANTS: readonly { readonly key: VariantKey; readonly name: string }[] = [
  { key: "A", name: "Inline tree" },
  { key: "B", name: "Side panel" },
  { key: "C", name: "Sidebar nest" },
];

const params = new URLSearchParams(location.search);
export const VARIANT: VariantKey =
  (["A", "B", "C"] as const).find((key) => key === params.get("variant")) ?? "A";
export const SCENARIO: Scenario = buildScenario(params.get("state") === "idle" ? "idle" : "busy");

interface ProtoState {
  /** The subagent whose transcript is open, or `null` for the thread. */
  readonly open: string | null;
  /** Variant B: whether the subagents panel is shown. */
  readonly panel: boolean;
  /** Variant A: whether the header's subagents popover is shown. */
  readonly popover: boolean;
  /** Which open Request the dock shows, as an index into `listOpenRequests`. */
  readonly requestIndex: number;
  /** Subagents the user stopped in the prototype. */
  readonly stopped: ReadonlySet<string>;
  /** True once the user stopped the whole session. */
  readonly sessionStopped: boolean;
}

let state: ProtoState = {
  open: null,
  panel: VARIANT === "B",
  popover: false,
  requestIndex: 0,
  stopped: new Set(),
  sessionStopped: false,
};
const listeners = new Set<() => void>();
let cache: { queryClient: QueryClient; client: HerculeClient } | null = null;

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Returns the prototype's view state, and draws the caller again when it changes. */
export const useProto = (): ProtoState => useSyncExternalStore(subscribe, () => state);

/** Changes the view state and writes the Request the dock shows into the session's cache entry. */
export const update = (change: Partial<ProtoState>): void => {
  state = { ...state, ...change };
  const requests = listOpenRequests(state);
  if (state.requestIndex >= requests.length)
    state = { ...state, requestIndex: Math.max(0, requests.length - 1) };
  syncSession();
  for (const listener of listeners) listener();
};

/** Keeps the cached session in step with the prototype: its status and the Request on the dock. */
const syncSession = (): void => {
  if (cache === null) return;
  const { queryClient, client } = cache;
  const session = buildMainSession(state);
  queryClient.setQueryData(sessionQuery(client, THREAD_ID).queryKey, session);
  queryClient.setQueryData(threadsQuery(client).queryKey, (threads) =>
    threads?.map((each) => (each.id === THREAD_ID ? session : each)),
  );
};

/** Takes the query cache the page seeded, so the prototype can change the session in it. */
export const attachCache = (queryClient: QueryClient, client: HerculeClient): void => {
  cache = { queryClient, client };
  syncSession();
};

const buildMainSession = (s: ProtoState): Session => ({
  ...SCENARIO.session,
  status: s.sessionStopped ? "idle" : SCENARIO.session.status,
  openRequest: listOpenRequests(s)[s.requestIndex]?.request ?? null,
});

// ------------------------------------------------------------ the subagents

/** Returns every subagent, with the ones the user stopped (and their descendants) marked stopped. */
export const listSubagents = (s: ProtoState): readonly ProtoSubagent[] =>
  SCENARIO.subagents.map((sub) =>
    sub.status === "running" && (s.sessionStopped || isStoppedBy(sub, s.stopped))
      ? {
          ...sub,
          status: "stopped",
          endedAt: new Date(SPECIMEN_NOW).toISOString(),
          activity: null,
          result: "Stopped by you",
        }
      : sub,
  );

const isStoppedBy = (sub: ProtoSubagent, stopped: ReadonlySet<string>): boolean => {
  for (let at: ProtoSubagent | undefined = sub; at !== undefined; at = findSubagent(at.parentId)) {
    if (stopped.has(at.id)) return true;
  }
  return false;
};

const findSubagent = (id: string | null): ProtoSubagent | undefined =>
  id === null ? undefined : SCENARIO.subagents.find((sub) => sub.id === id);

/** Returns the open Requests, oldest first, without those of stopped subagents. */
export const listOpenRequests = (s: ProtoState): readonly ProtoRequest[] => {
  const subagents = listSubagents(s);
  return SCENARIO.requests.filter((request) =>
    request.subagentId === null
      ? !s.sessionStopped
      : subagents.find((sub) => sub.id === request.subagentId)?.status === "running",
  );
};

export const listChildren = (
  subagents: readonly ProtoSubagent[],
  parentId: string | null,
): readonly ProtoSubagent[] => subagents.filter((sub) => sub.parentId === parentId);

export const countDescendants = (subagents: readonly ProtoSubagent[], id: string): number =>
  listDescendants(subagents, id).length;

/** Returns every subagent below `parentId`, at any depth; `null` is the main agent. */
export const listDescendants = (
  subagents: readonly ProtoSubagent[],
  parentId: string | null,
): readonly ProtoSubagent[] =>
  listChildren(subagents, parentId).flatMap((child) => [
    child,
    ...listDescendants(subagents, child.id),
  ]);

/** Returns the subagent's ancestors, the outermost first. */
export const listAncestors = (
  subagents: readonly ProtoSubagent[],
  sub: ProtoSubagent,
): readonly ProtoSubagent[] => {
  const parent = subagents.find((each) => each.id === sub.parentId);
  return parent === undefined ? [] : [...listAncestors(subagents, parent), parent];
};

export const hasOpenRequest = (s: ProtoState, id: string): boolean =>
  listOpenRequests(s).some((request) => request.subagentId === id);

/** The subagent's state as a face and a mark show it. */
export const decideSubagentPose = (
  sub: ProtoSubagent,
  waiting: boolean,
): Extract<Pose, "working" | "waiting" | "done" | "failed" | "idle"> =>
  sub.status === "running"
    ? waiting
      ? "waiting"
      : "working"
    : sub.status === "completed"
      ? "done"
      : sub.status === "failed"
        ? "failed"
        : "idle";

/** Formats a span of time as "45s", "2m 20s" or "17m". */
export const formatSpan = (ms: number): string => {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes >= 10 ? `${String(minutes)}m` : `${String(minutes)}m ${String(seconds % 60)}s`;
};

export const measureSubagent = (sub: ProtoSubagent): string =>
  formatSpan(
    (sub.endedAt === null ? SPECIMEN_NOW : Date.parse(sub.endedAt)) - Date.parse(sub.startedAt),
  );

/** "working · 17m", "done · 2m 20s": the subagent's state in words and how long it ran. */
export const describeSubagentState = (sub: ProtoSubagent, waiting: boolean): string => {
  const span = measureSubagent(sub);
  switch (sub.status) {
    case "running":
      return waiting ? `waiting on you · ${span}` : `working · ${span}`;
    case "completed":
      return `done · ${span}`;
    case "failed":
      return `failed · ${span}`;
    case "stopped":
      return `stopped · ${span}`;
  }
};

/**
 * Renders the subagent's name: its description, or, for a subagent that has
 * none, the start of its brief in italics, so it never reads as a real name.
 */
export function SubagentName({ sub }: { readonly sub: ProtoSubagent }): JSX.Element {
  return sub.description !== null ? (
    <span className="proto-name">{sub.description}</span>
  ) : (
    <span className="proto-name proto-name--unnamed" title={sub.brief}>
      {sub.brief}
    </span>
  );
}

export const nameSubagent = (sub: ProtoSubagent): string => sub.description ?? `“${sub.brief}”`;

export function SubagentFace({
  sub,
  size,
  waiting,
}: {
  readonly sub: ProtoSubagent;
  readonly size: number;
  readonly waiting: boolean;
}): JSX.Element {
  const pose = decideSubagentPose(sub, waiting);
  return <Face look={buildLook(sub.id)} pose={pose} size={size} animated={pose === "working"} />;
}

/** Renders the subagent's mark, or nothing for a stopped one, whose word says it. */
export function SubagentMark({
  sub,
  waiting,
}: {
  readonly sub: ProtoSubagent;
  readonly waiting: boolean;
}): JSX.Element | null {
  const pose = decideSubagentPose(sub, waiting);
  return pose === "idle" ? null : <Mark state={pose} />;
}

/** Sets `--hue` to the subagent's signature hue, so `--who-ink` and `--who-tint` follow it. */
export const hueStyle = (id: string): Record<string, string> => ({
  "--hue": `var(--hue-${buildLook(id).hue})`,
});

export const stopSubagent = (id: string): void => {
  update({ stopped: new Set([...state.stopped, id]) });
};

export const stopEverything = (): void => {
  update({ sessionStopped: true });
};

export function StopButton({
  id,
  label = "Stop",
}: {
  readonly id: string;
  readonly label?: string;
}): JSX.Element {
  return (
    <button
      type="button"
      className="btn btn--quiet btn--sm proto-stop"
      onClick={(event) => {
        event.stopPropagation();
        stopSubagent(id);
      }}
    >
      <StopIcon size={12} />
      {label}
    </button>
  );
}

// -------------------------------------------------------- the Request pager

/**
 * Renders the strip on top of the dock that says whose Request it shows, and
 * which of the open Requests: "1 of 2 · Read Mollie's iDEAL docs asks, a
 * subagent of Check the iDEAL redirect · Open ›", with ‹ › to switch.
 */
export function RequestPager({
  onOpen,
}: {
  readonly onOpen: (subagentId: string) => void;
}): JSX.Element | null {
  const s = useProto();
  const requests = listOpenRequests(s);
  const subagents = listSubagents(s);
  const current = requests[s.requestIndex];
  if (current === undefined) return null;
  const asker = subagents.find((sub) => sub.id === current.subagentId);
  const parent =
    asker === undefined ? undefined : subagents.find((sub) => sub.id === asker.parentId);
  return (
    <div className="proto-pager" style={asker === undefined ? undefined : hueStyle(asker.id)}>
      {requests.length > 1 ? (
        <span className="proto-pager-nav">
          <button
            type="button"
            className="icon-btn icon-btn--sm"
            aria-label="Previous Request"
            disabled={s.requestIndex === 0}
            onClick={() => update({ requestIndex: s.requestIndex - 1 })}
          >
            <span className="proto-flip">
              <ChevronRightIcon size={12} />
            </span>
          </button>
          <b>
            {s.requestIndex + 1} of {requests.length}
          </b>
          <button
            type="button"
            className="icon-btn icon-btn--sm"
            aria-label="Next Request"
            disabled={s.requestIndex === requests.length - 1}
            onClick={() => update({ requestIndex: s.requestIndex + 1 })}
          >
            <ChevronRightIcon size={12} />
          </button>
        </span>
      ) : null}
      {asker === undefined ? (
        <span className="proto-pager-who">The main agent asks</span>
      ) : (
        <>
          <span className="proto-pager-who">
            <span className="proto-ink">{nameSubagent(asker)}</span> asks
            <span className="proto-pager-sub">
              {" "}
              · subagent of {parent === undefined ? "the main agent" : nameSubagent(parent)}
            </span>
          </span>
          <span className="spacer" />
          <button type="button" className="proto-link" onClick={() => onOpen(asker.id)}>
            Open subagent ›
          </button>
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------- the thread screen

/**
 * Inserts `block` before the agent's first message. In every fixture
 * transcript, the agent spawns its subagents in the work stretch before it.
 */
export const spliceAtSpawn = (
  blocks: readonly (ThreadBlock | PrototypeBlock)[],
  block: PrototypeBlock,
): readonly (ThreadBlock | PrototypeBlock)[] => {
  const index = blocks.findIndex((each) => each.kind === "agent");
  return index < 0
    ? [...blocks, block]
    : [...blocks.slice(0, index), block, ...blocks.slice(index)];
};

/**
 * Renders the thread screen as the app does, with each variant's parts:
 *
 * - `shapeBlocks` changes the transcript's blocks, such as adding the spawn rows;
 * - `hideSubagentItems` leaves the spawns out of the work stretch;
 * - `headerExtra` is drawn in the header before Open in editor;
 * - `aboveDock` is drawn on top of the dock, or of the composer.
 */
export function PrototypeThread({
  shapeBlocks,
  hideSubagentItems,
  headerExtra,
  aboveDock,
}: {
  readonly shapeBlocks: (
    blocks: readonly ThreadBlock[],
  ) => readonly (ThreadBlock | PrototypeBlock)[];
  readonly hideSubagentItems: boolean;
  readonly headerExtra?: ReactNode;
  readonly aboveDock?: ReactNode;
}): JSX.Element {
  const { controller } = useRouteContext({ from: "/_connected" });
  const { client, live } = controller;
  const queryClient = useQueryClient();
  const s = useProto();
  const session = useSuspenseQuery(sessionQuery(client, THREAD_ID)).data;
  const allRows = useSuspenseQuery(transcriptQuery(client, THREAD_ID)).data;
  const instances = useSuspenseQuery(providersQuery(client)).data;
  const runners = useSuspenseQuery(runnersQuery(client)).data;
  const attachOpenParagraph = useThreadLive(live, queryClient, THREAD_ID, allRows);
  const [composerStack, setComposerStack] = useState<HTMLDivElement | null>(null);
  const transcriptRef = useRef<TranscriptHandle>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [composerFocused, setComposerFocused] = useState(false);
  const shrunk = !atBottom && !composerFocused;

  const rows = hideSubagentItems ? allRows.filter((row) => !isSpawnRow(row)) : allRows;
  const blocks = shapeBlocks(buildThreadBlocks(rows, session));
  const runner =
    session.runnerId === null ? undefined : runners.find((each) => each.id === session.runnerId);
  const instance = instances.find((each) => each.id === session.instanceId);
  const current = listOpenRequests(s)[s.requestIndex];

  return (
    <>
      <ThreadHeader sessionId={THREAD_ID} extra={headerExtra} />
      <Transcript
        sessionId={THREAD_ID}
        blocks={blocks}
        pose={decideThreadPose(session, runner)}
        describeAgent={(model) => describeAgent(instance, model)}
        attachOpenParagraph={attachOpenParagraph}
        composerStack={shrunk ? null : composerStack}
        onBottomChange={setAtBottom}
        ref={transcriptRef}
      />
      <ThreadComposer
        sessionId={THREAD_ID}
        shrunk={shrunk}
        onFocusChange={setComposerFocused}
        scrollTranscriptToBottom={() => {
          transcriptRef.current?.scrollToBottom();
        }}
        ref={setComposerStack}
        aboveDock={aboveDock}
        {...(current?.subagentId == null ? {} : { dockFaceSeed: current.subagentId })}
      />
    </>
  );
}

/** Checks whether a transcript row belongs to a fixture item that spawns a subagent. */
const isSpawnRow = (row: { readonly event: object }): boolean =>
  "itemId" in row.event && String(row.event.itemId).startsWith("it-sa-");

// ------------------------------------------------- a subagent's transcript

/** Returns the session a subagent's transcript is read against: its own status, Request and model. */
const buildSubagentSession = (s: ProtoState, sub: ProtoSubagent): Session => ({
  ...SCENARIO.session,
  id: sub.id,
  status: sub.status === "running" ? "busy" : "idle",
  openRequest:
    listOpenRequests(s).find((request) => request.subagentId === sub.id)?.request ?? null,
  modelSelection: { model: "claude-sonnet-5", options: {} },
});

/** Returns the blocks of the subagent's transcript: the brief its parent gave it, then its own work. */
export const buildSubagentBlocks = (
  s: ProtoState,
  sub: ProtoSubagent,
  brief: PrototypeBlock,
  spawn?: PrototypeBlock,
): readonly (ThreadBlock | PrototypeBlock)[] => {
  const spawns = spawn !== undefined && listChildren(SCENARIO.subagents, sub.id).length > 0;
  const rows = spawns ? sub.rows.filter((row) => !isSpawnRow(row)) : sub.rows;
  const built = buildThreadBlocks(rows, buildSubagentSession(s, sub));
  const blocks = spawns ? spliceAtSpawn(built, spawn) : built;
  // A stopped subagent's turn reads "Stopped after …" from its own rows; one
  // the prototype stopped has no such row, so its live row goes.
  const shown = sub.status === "stopped" ? blocks.filter((block) => block.kind !== "live") : blocks;
  return [brief, ...shown];
};

/**
 * Renders the subagent's transcript in the main pane, as a thread's is, with
 * `brief` as its first block, `spawn` where it started its own subagents,
 * and `bottom` in place of the composer: the Request dock when the subagent
 * has one, on top of `bottom`.
 */
export function SubagentTranscript({
  sub,
  brief,
  spawn,
  bottom,
}: {
  readonly sub: ProtoSubagent;
  readonly brief: PrototypeBlock;
  readonly spawn: PrototypeBlock;
  readonly bottom: ReactNode;
}): JSX.Element {
  const s = useProto();
  const [stack, setStack] = useState<HTMLDivElement | null>(null);
  const request = listOpenRequests(s).find((each) => each.subagentId === sub.id);
  const waiting = request !== undefined;
  return (
    <>
      <Transcript
        key={sub.id}
        sessionId={sub.id}
        blocks={buildSubagentBlocks(s, sub, brief, spawn)}
        pose={decideSubagentPose(sub, waiting)}
        describeAgent={() => `${nameSubagent(sub)} · Sonnet 5`}
        attachOpenParagraph={() => undefined}
        composerStack={stack}
        onBottomChange={() => undefined}
      />
      <div className="composer-wrap">
        <div className="composer" ref={setStack}>
          {request === undefined ? null : (
            <RequestDock
              key={request.request.requestId}
              sessionId={THREAD_ID}
              request={request.request}
              faceSeed={sub.id}
            />
          )}
          {bottom}
        </div>
      </div>
    </>
  );
}

/** A prototype block, drawn once, `estimate` pixels high before it is measured. */
export const buildCustomBlock = (
  key: string,
  estimate: number,
  render: () => ReactNode,
): PrototypeBlock => ({
  kind: "custom",
  key,
  estimate,
  render,
});

// --------------------------------------------------------------- the switcher

/** Renders the floating bar that switches variant and state, and takes ← and → to switch variant. */
export function Switcher(): JSX.Element {
  const go = (variant: VariantKey, scenario = SCENARIO.state): void => {
    const next = new URLSearchParams(location.search);
    next.set("variant", variant);
    next.set("state", scenario);
    location.search = next.toString();
  };
  const index = VARIANTS.findIndex((each) => each.key === VARIANT);
  const step = (by: number): void =>
    go(VARIANTS[(index + by + VARIANTS.length) % VARIANTS.length]!.key);
  useWindowKeys((event) => {
    if (
      event.target instanceof HTMLElement &&
      event.target.closest("input, textarea, [contenteditable]") !== null
    )
      return;
    if (event.key === "ArrowLeft") step(-1);
    if (event.key === "ArrowRight") step(1);
  });
  return (
    <div className="proto-switcher" role="toolbar" aria-label="Prototype variants">
      <button
        type="button"
        className="icon-btn icon-btn--sm"
        aria-label="Previous variant"
        onClick={() => step(-1)}
      >
        <span className="proto-flip">
          <ChevronRightIcon size={12} />
        </span>
      </button>
      <span className="proto-switcher-name">
        <b>{VARIANT}</b> {VARIANTS[index]!.name}
      </span>
      <button
        type="button"
        className="icon-btn icon-btn--sm"
        aria-label="Next variant"
        onClick={() => step(1)}
      >
        <ChevronRightIcon size={12} />
      </button>
      <span className="proto-switcher-sep" />
      <span className="seg">
        {(["busy", "idle"] as const).map((each) => (
          <button
            key={each}
            type="button"
            aria-pressed={SCENARIO.state === each}
            onClick={() => go(VARIANT, each)}
          >
            {each === "busy" ? "Working" : "Idle"}
          </button>
        ))}
      </span>
    </div>
  );
}

const useWindowKeys = (onKey: (event: KeyboardEvent) => void): void => {
  const [registered] = useState(() => {
    window.addEventListener("keydown", (event) => onKey(event));
    return true;
  });
  void registered;
};
