/**
 * Owns the Codex threads inside one session: their state, introductions,
 * parent links and frames waiting for metadata. The app-server and the
 * public session operations remain in the adapter.
 */
import * as Duration from "effect/Duration";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type { OpenRequest, ProviderEvent, SessionSpec, Usage } from "@hercule/protocol";
import { now } from "../../report";
import { truncateFact, truncateMessage } from "../text";
import type { Asked } from "./approvals";
import {
  buildNormalizingState,
  initializeUsageBaseline,
  markUsageIncomplete,
  requireUsageBaseline,
  restoreUsageReport,
  type Normalizing,
} from "./normalize";
import { INTERNAL_ERROR, type NotificationFrame, type Rpc, type ServerRequestFrame } from "./rpc";
import type {
  ItemCompletedNotification,
  ItemStartedNotification,
  ThreadReadParams,
  ThreadReadResponse,
  ThreadResumeParams,
} from "./types";

/** Bounds discovery work, not the number of subagents a session can run. */
export const METADATA_DEADLINE = Duration.seconds(5);
export const MAX_PENDING_THREADS = 32;
export const MAX_PENDING_FRAMES = 256;
export const MAX_PENDING_BYTES = 1024 * 1024;

export type CodexThreadFrame = NotificationFrame | ServerRequestFrame;

/** Holds an open native request until its agent receives an answer or stops. */
export interface Park {
  readonly id: string | number;
  readonly request: OpenRequest;
  readonly asked: Asked;
  readonly params: unknown;
}

export interface CodexThreadState {
  readonly state: Normalizing;
  parentThreadId: string | undefined;
  readonly turnId: string | undefined;
  readonly parks: Map<string, Park>;
  readonly fileChanges: Map<string, ReadonlyArray<string>>;
  usage: Usage | undefined;
}

interface Discovery {
  readonly thread: CodexThreadState;
  readonly frames: Array<QueuedFrame>;
  bytes: number;
  dropped: number;
  ready: boolean;
  introduced: boolean;
  itemId?: string | undefined;
  description?: string | undefined;
  agentType?: string | undefined;
  fallbackDescription?: string | undefined;
}

/** Identifies cancelled session work, a stopped subtree or one asking turn. */
type CodexStop =
  | { readonly kind: "session" }
  | { readonly kind: "subtree"; readonly ancestorId: string }
  | { readonly kind: "turn"; readonly threadId: string; readonly turnId: string };

interface QueuedFrame {
  readonly frame: CodexThreadFrame;
  readonly stops: Set<CodexStop>;
}

interface CodexTurn {
  readonly id: string;
  readonly stops: Set<CodexStop>;
}

/** Tracks one explicit input across preparation and native acceptance. */
interface CodexInput {
  submission: { readonly turnId: string | undefined } | undefined;
  stop: CodexStop | undefined;
}

interface Preparation {
  readonly done: Deferred.Deferred<void>;
  fiber: Fiber.Fiber<void> | undefined;
}

/** Returns the native thread named by a notification or a server request. */
export const readCodexThreadId = (frame: CodexThreadFrame): string | undefined => {
  const params = frame.params as
    { readonly threadId?: unknown; readonly thread?: { readonly id?: unknown } } | null | undefined;
  const id = params?.threadId ?? params?.thread?.id;
  return typeof id === "string" && id !== "" ? id : undefined;
};

const isControlFrame = (frame: CodexThreadFrame): boolean =>
  frame.method === "turn/started" ||
  frame.method === "turn/completed" ||
  frame.method === "thread/tokenUsage/updated" ||
  frame.method === "thread/closed";

/** Tracks native work and metadata until the hosting process exits. */
export const makeCodexThreads = (options: {
  readonly sessionId: string;
  readonly rootThreadId: string;
  readonly spec: SessionSpec;
  readonly rpc: Rpc;
  readonly emit: (event: ProviderEvent) => void;
  readonly dispatch: (
    thread: CodexThreadState,
    frame: CodexThreadFrame,
    cancelled: boolean,
  ) => void;
  readonly interrupt: (thread: CodexThreadState, turnId?: string) => Effect.Effect<void>;
  readonly cancelRequests: (thread: CodexThreadState) => void;
  readonly completeTurn: (thread: CodexThreadState) => void;
  readonly failSession: () => void;
}) => {
  const threads = new Map<string, CodexThreadState>();
  const discoveries = new Map<string, Discovery>();
  const pending = new Set<Discovery>();
  const background = new Set<Fiber.Fiber<void>>();
  const turns = new Map<CodexThreadState, CodexTurn>();
  const restoreIds = new Set<string>();
  const admissionStops = new Map<string | undefined, CodexStop>();
  // Queued frames share the cohort in effect when they arrived. A continuation
  // creates a fresh cohort; cancelling old cohorts never revives their frames.
  let admissionCohort = new Set<CodexStop>();
  let phase: "live" | "closing" | "exited" = "live";
  const inputs = new Set<CodexInput>();
  let preparation: Preparation | "ready" | undefined;
  let capacityDropped = 0;
  let pendingFrames = 0;
  const resumedSubagents = new Map(
    options.spec.continue?.mode === "resume"
      ? (options.spec.continue.subagents ?? []).map((known) => [known.subagentId, known])
      : [],
  );
  let pendingBytes = 0;

  const createCodexThread = (threadId: string): CodexThreadState => {
    const root = threadId === options.rootThreadId;
    const thread: CodexThreadState = {
      state: buildNormalizingState(
        options.sessionId,
        threadId,
        root ? options.spec.outputSchema : undefined,
        root ? undefined : { subagentId: threadId, rootThreadId: options.rootThreadId },
      ),
      parentThreadId: resumedSubagents.get(threadId)?.parentSubagentId,
      get turnId() {
        return turns.get(thread)?.id;
      },
      parks: new Map(),
      fileChanges: new Map(),
      usage: undefined,
    };
    if (root) thread.state.model = options.spec.modelSelection.model;
    threads.set(threadId, thread);
    return thread;
  };
  const root = createCodexThread(options.rootThreadId);

  const warn = (message: string): void => {
    if (phase !== "exited")
      options.emit({
        _tag: "runtime.warning",
        eventId: crypto.randomUUID(),
        sessionId: options.sessionId,
        at: now(),
        message: truncateMessage(message),
      });
  };

  const rejectFrame = (frame: CodexThreadFrame): void => {
    if ("id" in frame)
      options.rpc.answer(frame.id, {
        error: {
          code: INTERNAL_ERROR,
          message:
            "The runner could not hold this request while reading its subagent's metadata. Retry the request.",
        },
      });
  };

  const descendsFrom = (thread: CodexThreadState, ancestorId: string): boolean => {
    const visited = new Set<string>();
    let id: string | undefined = thread.state.threadId;
    while (id !== undefined && !visited.has(id)) {
      if (id === ancestorId) return true;
      visited.add(id);
      id = threads.get(id)?.parentThreadId;
    }
    return false;
  };

  const appliesStop = (
    thread: CodexThreadState,
    stop: CodexStop,
    turnId = thread.turnId,
  ): boolean =>
    stop.kind === "session" ||
    (stop.kind === "subtree"
      ? descendsFrom(thread, stop.ancestorId)
      : thread.state.threadId === stop.threadId && turnId === stop.turnId);

  const recordCodexParent = (
    thread: CodexThreadState,
    parentThreadId: string | undefined,
  ): void => {
    if (thread.parentThreadId !== undefined || parentThreadId === undefined) return;
    thread.parentThreadId = parentThreadId;
    // Learning one edge can reveal that already-running descendants belonged
    // to a stopped subtree, even after its parent began a later turn.
    for (const known of threads.values()) {
      if (
        (known.turnId !== undefined || known.parks.size !== 0) &&
        descendsFrom(known, thread.state.threadId) &&
        isStopped(known)
      ) {
        options.cancelRequests(known);
        runBackground(options.interrupt(known));
      }
    }
  };

  const runBackground = (effect: Effect.Effect<void>): Fiber.Fiber<void> => {
    const fiber = Effect.runFork(effect);
    background.add(fiber);
    fiber.addObserver(() => background.delete(fiber));
    return fiber;
  };

  const sumUsage = (): Usage => {
    const total = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    for (const thread of threads.values()) {
      if (thread.usage === undefined) continue;
      total.inputTokens += thread.usage.inputTokens;
      total.outputTokens += thread.usage.outputTokens;
      total.cacheReadTokens += thread.usage.cacheReadTokens ?? 0;
      total.cacheWriteTokens += thread.usage.cacheWriteTokens ?? 0;
    }
    return total;
  };

  const reportUsage = (): void => {
    if (phase === "exited") return;
    const counts = sumUsage();
    const base = {
      _tag: "session.usage.updated" as const,
      eventId: crypto.randomUUID(),
      sessionId: options.sessionId,
      at: now(),
    };
    options.emit(
      [...threads.values()].some((thread) => thread.state.usageIncomplete)
        ? { ...base, usageReport: { status: "incomplete", counts } }
        : { ...base, usage: counts },
    );
  };

  const markIncomplete = (thread: CodexThreadState): void => {
    markUsageIncomplete(thread.state);
    reportUsage();
  };

  const createDiscovery = (threadId: string): Discovery => {
    const discovery: Discovery = {
      thread: threads.get(threadId) ?? createCodexThread(threadId),
      frames: [],
      bytes: 0,
      dropped: 0,
      ready: false,
      introduced: false,
      itemId: resumedSubagents.get(threadId)?.itemId,
    };
    discoveries.set(threadId, discovery);
    pending.add(discovery);
    return discovery;
  };

  const dispatchFrame = (
    thread: CodexThreadState,
    frame: CodexThreadFrame,
    receivedStops?: ReadonlySet<CodexStop>,
    queued = false,
  ): void => {
    if (phase === "exited") return;
    try {
      if (frame.method === "item/started" || frame.method === "item/completed") {
        const item = (frame.params as ItemStartedNotification | ItemCompletedNotification).item;
        if (item.type === "collabAgentToolCall" || item.type === "subAgentActivity") {
          const ids =
            item.type === "collabAgentToolCall" ? item.receiverThreadIds : [item.agentThreadId];
          for (const id of ids) {
            if (id === "" || id === options.rootThreadId) continue;
            const requested = discoverCodexThread(id);
            const child = requested ?? createDiscovery(id);
            if (requested === undefined) {
              child.ready = true;
              warn(
                `Could not read metadata for subagent ${id}: the pending metadata lookup limit was reached. Reporting the information from its parent's item.`,
              );
            }
            if (
              (item.type === "collabAgentToolCall" && item.tool === "spawnAgent") ||
              (item.type === "subAgentActivity" && item.kind === "started")
            ) {
              recordCodexParent(child.thread, thread.state.threadId);
              child.itemId ??= item.id;
              if (item.type === "collabAgentToolCall")
                child.description ??= item.prompt ?? undefined;
              else child.fallbackDescription ??= item.agentPath.split("/").at(-1);
            }
            if (requested === undefined) releaseDiscoveries();
          }
        }
      }
    } catch {
      rejectFrame(frame);
      warn(
        `The app-server sent a ${frame.method} frame whose subagent information could not be read.`,
      );
      return;
    }
    if (frame.method === "turn/started") {
      const stops = new Set(receivedStops ?? admissionStops.values());
      const nativeTurn = (frame.params as { turn: { id: string } }).turn;
      const current = turns.get(thread);
      const submitted =
        thread === root
          ? [...inputs].find(
              (ticket) => ticket.submission !== undefined && ticket.submission.turnId === undefined,
            )
          : undefined;
      if (submitted !== undefined) recordInputAcceptance(submitted, nativeTurn.id);
      else if (current?.id !== nativeTurn.id) {
        // A selected agent can begin fresh work after its stopped turn ended.
        if (
          !queued &&
          current === undefined &&
          ![...stops].some((stop) => stop.kind === "session")
        ) {
          const selectedStop = admissionStops.get(thread.state.threadId);
          if (selectedStop !== undefined) {
            admissionStops.delete(thread.state.threadId);
            admissionCohort = new Set(admissionStops.values());
            stops.delete(selectedStop);
          }
        }
        turns.set(thread, {
          id: nativeTurn.id,
          stops,
        });
      } else for (const stop of stops) current.stops.add(stop);
    }
    const requestTurnId = (frame.params as { turnId?: string } | undefined)?.turnId;
    const requestOpenedTurn = "id" in frame && turns.get(thread)?.id !== requestTurnId;
    if ("id" in frame && typeof requestTurnId === "string" && turns.get(thread) === undefined)
      turns.set(thread, {
        id: requestTurnId,
        stops: new Set(receivedStops ?? admissionStops.values()),
      });
    const cancelled =
      "id" in frame &&
      (phase !== "live" ||
        [...(receivedStops ?? [])].some((stop) => appliesStop(thread, stop, requestTurnId)) ||
        isStopped(thread));
    options.dispatch(thread, frame, cancelled);
    if (cancelled && requestOpenedTurn && typeof requestTurnId === "string")
      runBackground(options.interrupt(thread, requestTurnId));
    else if (frame.method === "turn/started" && isStopped(thread)) {
      options.cancelRequests(thread);
      runBackground(options.interrupt(thread));
    }
    if (frame.method === "turn/completed") {
      const nativeTurn = (frame.params as { turn: { id: string; status: string } }).turn;
      if (nativeTurn.status !== "inProgress" && turns.get(thread)?.id === nativeTurn.id) {
        turns.delete(thread);
        options.completeTurn(thread);
      }
    }
  };

  const isStopped = (thread: CodexThreadState): boolean =>
    phase !== "live" ||
    [...(turns.get(thread)?.stops ?? [])].some((stop) => appliesStop(thread, stop)) ||
    [...admissionStops.values()].some((stop) => appliesStop(thread, stop));

  const recordInputAcceptance = (ticket: CodexInput, turnId: string): void => {
    if (phase === "exited") return;
    if (phase === "live" && ticket.stop === undefined) {
      admissionStops.delete(undefined);
      admissionCohort = new Set(admissionStops.values());
    }
    const existing = turns.get(root);
    const stops = new Set(existing?.id === turnId ? existing.stops : []);
    if (ticket.stop !== undefined) stops.add(ticket.stop);
    turns.set(root, { id: turnId, stops });
  };

  const releaseDiscoveries = (): void => {
    for (const discovery of pending) {
      const id = discovery.thread.state.threadId;
      if (discovery.introduced || !discovery.ready) continue;
      const parent = discovery.thread.parentThreadId;
      if (
        parent !== undefined &&
        parent !== options.rootThreadId &&
        !discoveries.get(parent)?.introduced
      )
        continue;
      discovery.introduced = true;
      pending.delete(discovery);
      if (capacityDropped !== 0 && pending.size < MAX_PENDING_THREADS) {
        warn(
          `Dropped ${capacityDropped} Codex subagent frames while metadata lookups were full. Usage is incomplete.`,
        );
        capacityDropped = 0;
      }
      options.emit({
        _tag: "subagent.started",
        eventId: crypto.randomUUID(),
        sessionId: options.sessionId,
        at: now(),
        subagentId: id,
        ...(parent === undefined || parent === options.rootThreadId
          ? {}
          : { parentSubagentId: parent }),
        ...(discovery.itemId ? { itemId: truncateFact(discovery.itemId) } : {}),
        ...((discovery.description ?? discovery.fallbackDescription)
          ? {
              description: truncateMessage(
                (discovery.description ?? discovery.fallbackDescription)!,
              ),
            }
          : {}),
        ...(discovery.agentType ? { agentType: truncateFact(discovery.agentType) } : {}),
      });
      const frames = discovery.frames.splice(0);
      pendingFrames -= frames.length;
      pendingBytes -= discovery.bytes;
      discovery.bytes = 0;
      if (discovery.dropped !== 0)
        warn(
          `Dropped ${discovery.dropped} frames for subagent ${id} while reading its metadata: the pending frame limit was reached.`,
        );
      for (const queued of frames)
        dispatchFrame(discovery.thread, queued.frame, queued.stops, true);
      // An ancestor can become ready after its descendant's metadata reply.
      releaseDiscoveries();
    }
  };

  const completeCodexDiscovery = (discovery: Discovery): void => {
    const threadId = discovery.thread.state.threadId;
    const parent = discovery.thread.parentThreadId;
    if (parent !== undefined && parent !== options.rootThreadId) {
      if (
        parent === threadId ||
        descendsFrom(threads.get(parent) ?? createCodexThread(parent), threadId)
      ) {
        discovery.thread.parentThreadId = undefined;
        warn(
          `Could not introduce the parent of subagent ${threadId}; reporting the subagent without a parent.`,
        );
      } else if (discoverCodexThread(parent) === undefined) {
        const ancestor = discoveries.get(parent) ?? createDiscovery(parent);
        warn(
          `Could not read metadata for parent subagent ${parent}; retaining its known relationship.`,
        );
        completeCodexDiscovery(ancestor);
      }
    }
    discovery.ready = true;
    releaseDiscoveries();
  };

  const applyMetadata = (discovery: Discovery, answer: unknown): void => {
    if (phase === "exited") return;
    const threadId = discovery.thread.state.threadId;
    const metadata = (answer as ThreadReadResponse | undefined)?.thread;
    if (metadata === undefined || metadata.id !== threadId) {
      warn(
        `Could not read metadata for subagent ${threadId}; the app-server returned no matching thread.`,
      );
      completeCodexDiscovery(discovery);
      return;
    }
    discovery.thread.state.model = metadata.model ?? undefined;
    discovery.agentType = metadata.agentRole ?? undefined;
    const source = metadata.source;
    const subagentSource =
      typeof source === "object" && "subAgent" in source ? source.subAgent : undefined;
    const agentPath =
      typeof subagentSource === "object" && "thread_spawn" in subagentSource
        ? subagentSource.thread_spawn.agent_path
        : undefined;
    if (agentPath != null) discovery.fallbackDescription ??= agentPath.split("/").at(-1);
    // V1 child metadata can arrive before the spawn's prompt. Leaving its
    // description empty lets the child's native first input supply the brief.
    // V2 has an agent path, even when its parent activity has not arrived yet.
    if (discovery.fallbackDescription !== undefined)
      discovery.description ??= metadata.agentNickname ?? undefined;
    recordCodexParent(discovery.thread, metadata.parentThreadId ?? undefined);
    completeCodexDiscovery(discovery);
  };

  const discoverCodexThread = (threadId: string): Discovery | undefined => {
    const known = discoveries.get(threadId);
    if (known !== undefined) return known;
    if (pending.size >= MAX_PENDING_THREADS) return undefined;
    const discovery = createDiscovery(threadId);
    runBackground(
      Effect.match(
        Effect.timeout(
          options.rpc.request("thread/read", {
            threadId,
            includeTurns: false,
          } satisfies ThreadReadParams),
          METADATA_DEADLINE,
        ),
        {
          onFailure: () => {
            if (phase === "exited") return;
            warn(
              `Could not read metadata for subagent ${threadId}; reporting the subagent with the information already available.`,
            );
            completeCodexDiscovery(discovery);
          },
          onSuccess: (answer) => applyMetadata(discovery, answer),
        },
      ),
    );
    return discovery;
  };

  if (options.spec.continue?.mode === "resume") {
    for (const known of options.spec.continue.subagents ?? []) {
      if (known.subagentId === options.rootThreadId) continue;
      const thread = createCodexThread(known.subagentId);
      if (!restoreUsageReport(thread.state, known.lastUsageReport))
        restoreIds.add(known.subagentId);
    }
  }

  const settlePreparation = (work: Preparation, interrupted: boolean): void => {
    if (preparation !== work) return;
    for (const id of restoreIds) {
      requireUsageBaseline(threads.get(id)!.state);
      if (phase !== "exited") {
        let discovery: Discovery | undefined = discoveries.get(id) ?? createDiscovery(id);
        const visited = new Set<string>();
        while (discovery !== undefined && !discovery.introduced) {
          const threadId = discovery.thread.state.threadId;
          if (visited.has(threadId)) break;
          visited.add(threadId);
          discovery.ready = true;
          const parent: string | undefined = discovery.thread.parentThreadId;
          discovery =
            parent === undefined || parent === options.rootThreadId
              ? undefined
              : (discoveries.get(parent) ?? createDiscovery(parent));
        }
        // Failed preparation still introduces carried children before their
        // incomplete snapshots. Their known ancestors need no further lookup.
        releaseDiscoveries();
      }
    }
    if (restoreIds.size !== 0 && phase !== "exited") {
      for (const id of restoreIds) {
        const counts = threads.get(id)!.usage ?? {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        };
        options.emit({
          _tag: "session.usage.updated",
          eventId: crypto.randomUUID(),
          sessionId: options.sessionId,
          at: now(),
          subagentId: id,
          usageReport: { status: "incomplete", counts },
        });
      }
      warn(
        `Could not restore usage baselines for ${restoreIds.size} Codex subagents${interrupted ? " before Stop" : ""}. Work can continue, but usage is incomplete.`,
      );
      reportUsage();
    }
    restoreIds.clear();
    preparation = "ready";
    Deferred.doneUnsafe(work.done, Effect.void);
  };

  const cancelPreparation = (): void => {
    if (preparation === undefined && restoreIds.size !== 0)
      preparation = { done: Deferred.makeUnsafe<void>(), fiber: undefined };
    if (preparation !== undefined && preparation !== "ready") {
      const work = preparation;
      settlePreparation(work, true);
      if (work.fiber !== undefined) Effect.runFork(Fiber.interrupt(work.fiber));
    }
  };

  const prepareUsage = Effect.gen(function* () {
    if (phase !== "live") return yield* Effect.fail("The Codex session is stopping or exited.");
    if (preparation === "ready") return;
    if (preparation !== undefined) return yield* Deferred.await(preparation.done);
    if (restoreIds.size === 0) {
      preparation = "ready";
      return;
    }
    const work: Preparation = { done: Deferred.makeUnsafe<void>(), fiber: undefined };
    preparation = work;
    const restore = Effect.forEach(
      [...restoreIds],
      (threadId) =>
        Effect.ignore(
          Effect.gen(function* () {
            if (preparation !== work || phase !== "live") return;
            const discovery =
              discoveries.get(threadId) ??
              (pending.size < MAX_PENDING_THREADS ? createDiscovery(threadId) : undefined);
            if (discovery === undefined) return;
            const resumed = yield* options.rpc.request("thread/resume", {
              threadId,
              excludeTurns: false,
            } satisfies ThreadResumeParams);
            if (preparation !== work || phase !== "live") return;
            if ((resumed as ThreadReadResponse | undefined)?.thread?.id !== threadId) return;
            applyMetadata(discovery, resumed);
            // Resume and read serialize for the same native thread. Read closes the
            // usage replay even when an unused child has no historical report.
            const barrier = yield* options.rpc.request("thread/read", {
              threadId,
              includeTurns: false,
            } satisfies ThreadReadParams);
            if (preparation !== work || phase !== "live") return;
            if ((barrier as ThreadReadResponse | undefined)?.thread?.id !== threadId) return;
            if (!initializeUsageBaseline(discovery.thread.state)) return;
            restoreIds.delete(threadId);
          }),
        ),
      { concurrency: 2, discard: true },
    );
    work.fiber = yield* Effect.forkChild(
      Effect.ensuring(
        Effect.ignore(Effect.timeout(restore, METADATA_DEADLINE)),
        Effect.sync(() => settlePreparation(work, false)),
      ),
    );
    background.add(work.fiber);
    work.fiber.addObserver(() => background.delete(work.fiber!));
    yield* Deferred.await(work.done);
  });

  return {
    root,
    prepareUsage,
    /** Routes frames after introducing their thread, preserving arrival order. */
    receive: (frame: CodexThreadFrame): void => {
      if (phase === "exited") return;
      const id = readCodexThreadId(frame);
      if (id === undefined) return;
      if (id === options.rootThreadId) return dispatchFrame(root, frame);
      const discovery = discoverCodexThread(id);
      if (discovery === undefined) {
        rejectFrame(frame);
        markUsageIncomplete(root.state);
        capacityDropped += 1;
        if (capacityDropped === 1) {
          warn(
            "Dropping Codex subagent frames because pending metadata lookup limit was reached. Usage is incomplete.",
          );
          reportUsage();
        }
        if (isControlFrame(frame)) {
          warn(
            "Could not retain a Codex turn or usage report within the metadata bounds. Stopping the session rather than losing its lifecycle.",
          );
          options.failSession();
        }
        return;
      }
      if (
        frame.method === "thread/tokenUsage/updated" &&
        restoreIds.has(id) &&
        preparation !== "ready"
      ) {
        const restored = restoreUsageReport(discovery.thread.state, {
          source: "codex.app-server.notification",
          payload: frame.params,
        });
        if (!restored && discovery.thread.state.previousTotal === undefined)
          requireUsageBaseline(discovery.thread.state);
      }
      if (discovery.introduced) return dispatchFrame(discovery.thread, frame);
      if (frame.method === "turn/started") {
        const previous = discovery.frames.findLast(
          (queued) =>
            queued.frame.method === "turn/started" || queued.frame.method === "turn/completed",
        )?.frame;
        const ended = previous?.params as { turn?: { id?: string; status?: string } } | undefined;
        const next = frame.params as { turn?: { id?: string } };
        if (
          previous?.method === "turn/completed" &&
          ended?.turn?.status !== "inProgress" &&
          ended?.turn?.id !== next.turn?.id &&
          !admissionStops.has(undefined)
        ) {
          admissionStops.delete(id);
          admissionCohort = new Set(admissionStops.values());
        }
      }
      const bytes = Buffer.byteLength(JSON.stringify(frame));
      const overCapacity = (): boolean =>
        pendingFrames >= MAX_PENDING_FRAMES || pendingBytes + bytes > MAX_PENDING_BYTES;
      if (isControlFrame(frame)) {
        while (overCapacity()) {
          const evicted = [...pending].find((candidate) =>
            candidate.frames.some((queued) => queued.frame.method.endsWith("/delta")),
          );
          if (evicted === undefined) break;
          const index = evicted.frames.findIndex((queued) =>
            queued.frame.method.endsWith("/delta"),
          );
          const [removed] = evicted.frames.splice(index, 1);
          const removedBytes = Buffer.byteLength(JSON.stringify(removed!.frame));
          evicted.bytes -= removedBytes;
          pendingBytes -= removedBytes;
          pendingFrames -= 1;
          evicted.dropped += 1;
        }
      }
      if (overCapacity()) {
        discovery.dropped += 1;
        rejectFrame(frame);
        if (isControlFrame(frame)) {
          markIncomplete(discovery.thread);
          warn(
            "Could not retain a Codex turn or usage report within the pending frame bounds. Stopping the session rather than losing its lifecycle.",
          );
          options.failSession();
        }
        return;
      }
      discovery.frames.push({ frame, stops: admissionCohort });
      discovery.bytes += bytes;
      pendingFrames += 1;
      pendingBytes += bytes;
    },
    /** Finds a request under its own thread, regardless of opening order. */
    findRequest: (
      requestId: string,
    ): { readonly thread: CodexThreadState; readonly park: Park } | undefined => {
      for (const thread of threads.values()) {
        const park = thread.parks.get(requestId);
        if (park !== undefined) return { thread, park };
      }
      return undefined;
    },
    /** Cancels received work permanently and fences later arrivals until continuation. */
    cancelWork: (subagentId?: string): ReadonlyArray<CodexThreadState> => {
      if (phase === "exited") return [];
      if (
        subagentId !== undefined &&
        (!threads.has(subagentId) || subagentId === options.rootThreadId)
      )
        return [];
      const stop: CodexStop =
        subagentId === undefined
          ? { kind: "session" }
          : { kind: "subtree", ancestorId: subagentId };
      admissionStops.set(subagentId, stop);
      admissionCohort = new Set(admissionStops.values());
      if (subagentId === undefined) {
        for (const ticket of inputs) ticket.stop = stop;
        cancelPreparation();
      }
      const selected = [...threads.values()].filter((thread) => appliesStop(thread, stop));
      for (const turn of turns.values()) turn.stops.add(stop);
      // Metadata may reveal ancestry later. Retain this Stop on already-received
      // work even after a continuation closes its future admission fence.
      for (const discovery of pending)
        for (const queued of discovery.frames) queued.stops.add(stop);
      return selected;
    },
    /** Cancels this asking turn without fencing its descendants or a later turn. */
    cancelAskingTurn: (thread: CodexThreadState): void => {
      const turn = turns.get(thread);
      if (turn !== undefined)
        turn.stops.add({ kind: "turn", threadId: thread.state.threadId, turnId: turn.id });
    },
    /** Prevents every input acceptance from reopening a process being stopped. */
    beginClosing: (): void => {
      if (phase === "live") phase = "closing";
    },
    beginInput: (): CodexInput => {
      const ticket: CodexInput = { submission: undefined, stop: undefined };
      inputs.add(ticket);
      return ticket;
    },
    submitInput: (ticket: CodexInput, turnId?: string): Effect.Effect<void, string> =>
      Effect.suspend(() => {
        if (phase !== "live" || ticket.stop !== undefined)
          return Effect.fail(
            "The Codex input was stopped before it reached the harness. Send a new message to continue.",
          );
        ticket.submission = { turnId };
        return Effect.void;
      }),
    acceptInput: (ticket: CodexInput, turnId: string): void => {
      recordInputAcceptance(ticket, turnId);
      if (phase !== "exited" && isStopped(root)) runBackground(options.interrupt(root));
    },
    finishInput: (ticket: CodexInput): void => {
      inputs.delete(ticket);
    },
    isStopped,
    /** Emits each child's report and a fresh aggregate envelope for its session. */
    recordUsage: (
      thread: CodexThreadState,
      event: Extract<ProviderEvent, { _tag: "session.usage.updated" }>,
    ): void => {
      thread.usage = event.usage ?? event.usageReport.counts;
      if (event.subagentId !== undefined) options.emit(event);
      reportUsage();
    },
    /** Marks an unreadable report incomplete if no usable baseline remains; returns whether one is needed. */
    rejectUsageReport: (thread: CodexThreadState): boolean => {
      if (phase === "exited" || thread.state.previousTotal !== undefined) return false;
      requireUsageBaseline(thread.state);
      if (thread.state.subagentId !== undefined)
        options.emit({
          _tag: "session.usage.updated",
          eventId: crypto.randomUUID(),
          sessionId: options.sessionId,
          at: now(),
          subagentId: thread.state.subagentId,
          usageReport: {
            status: "incomplete",
            counts: thread.usage ?? {
              inputTokens: 0,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            },
          },
        });
      reportUsage();
      return true;
    },
    /** Discards callbacks and interrupts owned background work on process exit. */
    close: (): void => {
      if (capacityDropped !== 0)
        warn(
          `Dropped ${capacityDropped} Codex subagent frames while metadata lookups were full. Usage is incomplete.`,
        );
      phase = "exited";
      cancelPreparation();
      Effect.runFork(Fiber.interruptAll(background));
      discoveries.clear();
      admissionStops.clear();
      pending.clear();
      threads.clear();
      turns.clear();
      inputs.clear();
    },
  };
};

export type CodexThreads = ReturnType<typeof makeCodexThreads>;
