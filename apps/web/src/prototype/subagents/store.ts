/**
 * PROTOTYPE (#354), throwaway. The web prototype's view state, and the
 * subagents as the user has changed them: stopped, or with a Request
 * answered. The prototype's components read the state with `useProto`; the
 * stubbed API reads it too, so a refetch returns what the user sees.
 */
import { useSyncExternalStore } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "@hercule/client-core";
import type { Session } from "@hercule/contract";
import {
  buildScenario,
  NOW,
  type ProtoRequest,
  type ProtoSubagent,
  type Scenario,
} from "./fixture";

/** What the side pane can show. Only the Subagents surface is drawn; the rest are stubs. */
export type SurfaceKind = "browser" | "terminal" | "files" | "diff" | "pull-request" | "subagents";

const params = new URLSearchParams(location.search);

export const SCENARIO: Scenario = buildScenario(params.get("state") === "idle" ? "idle" : "busy");

export interface ProtoState {
  /** The subagent whose page is open, or `null` for the thread. */
  readonly open: string | null;
  /** Which open Request the permission card shows, as an index into `listOpenRequests`. */
  readonly requestIndex: number;
  /** Subagents the user stopped. */
  readonly stopped: ReadonlySet<string>;
  /** Requests the user answered. */
  readonly answered: ReadonlySet<string>;
  /** True once the user stopped the whole session. */
  readonly sessionStopped: boolean;
  /** Whether the side pane is shown, how wide, its tabs, the shown tab, and whether "+" is open. */
  readonly pane: boolean;
  readonly paneWidth: number;
  readonly surfaces: readonly SurfaceKind[];
  readonly surface: SurfaceKind;
  readonly picker: boolean;
}

let state: ProtoState = {
  open: null,
  requestIndex: 0,
  stopped: new Set(),
  answered: new Set(),
  sessionStopped: false,
  pane: true,
  paneWidth: 420,
  surfaces: ["subagents"],
  surface: "subagents",
  picker: false,
};
const listeners = new Set<() => void>();
let cache: QueryClient | null = null;

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Returns the prototype's view state, and draws the caller again when it changes. */
export const useProto = (): ProtoState => useSyncExternalStore(subscribe, () => state);

/** Returns the view state as it is now, for code outside React. */
export const readProto = (): ProtoState => state;

/** Changes the view state, and writes the session the user now sees into the query cache. */
export const update = (change: Partial<ProtoState>): void => {
  state = { ...state, ...change };
  const requests = listOpenRequests(state);
  if (state.requestIndex >= requests.length)
    state = { ...state, requestIndex: Math.max(0, requests.length - 1) };
  syncSession();
  for (const listener of listeners) listener();
};

/**
 * Puts the theme `?theme=light` or `?theme=dark` names onto the document. It
 * runs before the app mounts, so the shell's own theme switch, which reads
 * the document when it mounts, shows the same theme; that switch changes it
 * afterwards.
 */
export const applyThemeParam = (): void => {
  const theme = params.get("theme");
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
};

/** Takes the query cache, so the prototype can change the session in it. */
export const attachCache = (queryClient: QueryClient): void => {
  cache = queryClient;
};

const syncSession = (): void => {
  if (cache === null) return;
  const session = buildMainSession(state);
  cache.setQueryData(queryKeys.session(session.id), session);
  cache.setQueryData(queryKeys.sessions(), (page: { items: readonly Session[] } | undefined) =>
    page === undefined
      ? page
      : { ...page, items: page.items.map((each) => (each.id === session.id ? session : each)) },
  );
};

/** Returns the main session as the user has changed it: its status and the Request on its card. */
export const buildMainSession = (s: ProtoState): Session => ({
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
          endedAt: new Date(NOW).toISOString(),
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

/** Returns the open Requests, oldest first, without answered ones or those of stopped subagents. */
export const listOpenRequests = (s: ProtoState): readonly ProtoRequest[] => {
  const subagents = listSubagents(s);
  return SCENARIO.requests.filter(
    (request) =>
      !s.answered.has(request.request.requestId) &&
      (request.subagentId === null
        ? !s.sessionStopped
        : subagents.find((sub) => sub.id === request.subagentId)?.status === "running"),
  );
};

export const listChildren = (
  subagents: readonly ProtoSubagent[],
  parentId: string | null,
): readonly ProtoSubagent[] => subagents.filter((sub) => sub.parentId === parentId);

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

/** Formats a span of time as "45s", "2m 20s" or "17m". */
export const formatSpan = (ms: number): string => {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes >= 10 ? `${String(minutes)}m` : `${String(minutes)}m ${String(seconds % 60)}s`;
};

/** Returns how long the subagent ran, or has run so far, as `formatSpan` writes it. */
export const measureSubagent = (sub: ProtoSubagent): string =>
  formatSpan((sub.endedAt === null ? NOW : Date.parse(sub.endedAt)) - Date.parse(sub.startedAt));

/** Returns the subagent's name: its description, or, for one that has none, its brief in quotes. */
export const nameSubagent = (sub: ProtoSubagent): string => sub.description ?? `“${sub.brief}”`;

/** Returns the subagent's state word: working, waiting on you, done, failed or stopped. */
export const describeSubagentState = (sub: ProtoSubagent, waiting: boolean): string => {
  switch (sub.status) {
    case "running":
      return waiting ? "waiting on you" : "working";
    case "completed":
      return "done";
    case "failed":
      return "failed";
    case "stopped":
      return "stopped";
  }
};

export const formatTokens = (tokens: number): string => `${(tokens / 1000).toFixed(1)}k`;

export const open = (id: string | null): void => {
  update({ open: id });
};

export const stopSubagent = (id: string): void => {
  update({ stopped: new Set([...state.stopped, id]) });
};

export const stopEverything = (): void => {
  update({ sessionStopped: true });
};

export const answerRequest = (requestId: string): void => {
  update({ answered: new Set([...state.answered, requestId]) });
};

/** Shows `kind` in the side pane: opens the pane, adds the tab if it is missing, and selects it. */
export const showSurface = (kind: SurfaceKind): void => {
  update({
    pane: true,
    picker: false,
    surface: kind,
    surfaces: state.surfaces.includes(kind) ? state.surfaces : [...state.surfaces, kind],
  });
};

/** Checks whether the side pane shows the Subagents surface. */
export const showsSubagents = (s: ProtoState): boolean =>
  s.pane && s.surface === "subagents" && s.surfaces.includes("subagents");
