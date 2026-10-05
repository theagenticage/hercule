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
import { buildNormalizingState, restoreUsageReport, type Normalizing } from "./normalize";
import type { NotificationFrame, Rpc, ServerRequestFrame } from "./rpc";
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

export type ThreadFrame = NotificationFrame | ServerRequestFrame;

/** Keeps the native RPC id unchanged so Codex can match the reply. */
export interface Park {
  readonly id: string | number;
  readonly request: OpenRequest;
  readonly asked: Asked;
  readonly params: unknown;
}

export interface ThreadState {
  readonly state: Normalizing;
  parentThreadId: string | undefined;
  turnId: string | undefined;
  readonly parks: Map<string, Park>;
  readonly fileChanges: Map<string, ReadonlyArray<string>>;
  usage: Usage | undefined;
  /** Stops the turn already running or waiting for metadata, not future work. */
  stopping: boolean;
}

interface Discovery {
  readonly thread: ThreadState;
  readonly frames: Array<ThreadFrame>;
  readonly stopAncestors: Set<string>;
  readonly released: Deferred.Deferred<void>;
  bytes: number;
  dropped: number;
  ready: boolean;
  introduced: boolean;
  itemId?: string | undefined;
  description?: string | undefined;
  agentType?: string | undefined;
  fallbackDescription?: string | undefined;
}

/** Returns the native thread named by a notification or a server request. */
export const readThreadId = (frame: ThreadFrame): string | undefined => {
  const params = frame.params as
    { readonly threadId?: unknown; readonly thread?: { readonly id?: unknown } } | null | undefined;
  const id = params?.threadId ?? params?.thread?.id;
  return typeof id === "string" && id !== "" ? id : undefined;
};

/** Creates a registry whose callbacks run only while its session is live. */
export const makeCodexThreads = (options: {
  readonly sessionId: string;
  readonly rootThreadId: string;
  readonly spec: SessionSpec;
  readonly rpc: Rpc;
  readonly emit: (event: ProviderEvent) => void;
  readonly dispatch: (thread: ThreadState, frame: ThreadFrame) => void;
  readonly interrupt: (thread: ThreadState) => Effect.Effect<void>;
}) => {
  const threads = new Map<string, ThreadState>();
  const discoveries = new Map<string, Discovery>();
  const pending = new Set<Discovery>();
  const lookups = new Set<Fiber.Fiber<void>>();
  const restoreIds = new Set<string>();
  const stoppedSubtrees = new Set<string>();
  let live = true;
  let stopAll = false;
  let inputPending = false;
  let pendingFrames = 0;
  const resumedItemIds = new Map(
    options.spec.continue?.mode === "resume"
      ? (options.spec.continue.subagents ?? []).map((known) => [known.subagentId, known.itemId])
      : [],
  );
  let pendingBytes = 0;

  const createThread = (threadId: string): ThreadState => {
    const root = threadId === options.rootThreadId;
    const thread: ThreadState = {
      state: buildNormalizingState(
        options.sessionId,
        threadId,
        root ? options.spec.outputSchema : undefined,
        root ? undefined : { subagentId: threadId, rootThreadId: options.rootThreadId },
      ),
      parentThreadId: undefined,
      turnId: undefined,
      parks: new Map(),
      fileChanges: new Map(),
      usage: undefined,
      stopping: false,
    };
    if (root) thread.state.model = options.spec.modelSelection.model;
    threads.set(threadId, thread);
    return thread;
  };
  const root = createThread(options.rootThreadId);

  const warn = (message: string): void => {
    if (live)
      options.emit({
        _tag: "runtime.warning",
        eventId: crypto.randomUUID(),
        sessionId: options.sessionId,
        at: now(),
        message: truncateMessage(message),
      });
  };

  const rejectFrame = (frame: ThreadFrame): void => {
    if ("id" in frame)
      options.rpc.answer(frame.id, {
        error: {
          code: -32603,
          message:
            "The runner could not hold this request while reading its subagent's metadata. Retry the request.",
        },
      });
  };

  const descendsFrom = (thread: ThreadState, ancestorId: string): boolean => {
    const visited = new Set<string>();
    let id: string | undefined = thread.state.threadId;
    while (id !== undefined && !visited.has(id)) {
      if (id === ancestorId) return true;
      visited.add(id);
      id = threads.get(id)?.parentThreadId;
    }
    return false;
  };

  const hasStoppedAncestor = (thread: ThreadState): boolean =>
    [...stoppedSubtrees].some(
      (ancestorId) => ancestorId !== thread.state.threadId && descendsFrom(thread, ancestorId),
    );

  const createDiscovery = (threadId: string): Discovery => {
    const discovery: Discovery = {
      thread: threads.get(threadId) ?? createThread(threadId),
      frames: [],
      stopAncestors: new Set(stoppedSubtrees),
      released: Deferred.makeUnsafe<void>(),
      bytes: 0,
      dropped: 0,
      ready: false,
      introduced: false,
      itemId: resumedItemIds.get(threadId),
    };
    discoveries.set(threadId, discovery);
    pending.add(discovery);
    return discovery;
  };

  const dispatchFrame = (thread: ThreadState, frame: ThreadFrame): void => {
    if (!live) return;
    // A native turn start confirms acceptance before the RPC caller resumes.
    if (thread === root && frame.method === "turn/started" && inputPending && stopAll) {
      stopAll = false;
      for (const known of threads.values()) known.stopping = false;
    }
    try {
      if (frame.method === "item/started" || frame.method === "item/completed") {
        const item = (frame.params as ItemStartedNotification | ItemCompletedNotification).item;
        if (item.type === "collabAgentToolCall" || item.type === "subAgentActivity") {
          const ids =
            item.type === "collabAgentToolCall" ? item.receiverThreadIds : [item.agentThreadId];
          for (const id of ids) {
            if (id === "" || id === options.rootThreadId) continue;
            const requested = discoverThread(id);
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
              child.thread.parentThreadId ??= thread.state.threadId;
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
    // A completed selected turn can be continued by its parent. That new
    // turn releases the protection against descendants arriving from old work.
    if (frame.method === "turn/started" && thread.turnId === undefined && !thread.stopping) {
      stoppedSubtrees.delete(thread.state.threadId);
    }
    options.dispatch(thread, frame);
    if (
      frame.method === "turn/started" &&
      thread !== root &&
      (stopAll || thread.stopping || hasStoppedAncestor(thread))
    ) {
      Effect.runFork(options.interrupt(thread));
    }
    if (frame.method === "turn/completed" && thread.turnId === undefined) thread.stopping = false;
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
      discovery.thread.stopping ||= [...discovery.stopAncestors].some((ancestor) =>
        descendsFrom(discovery.thread, ancestor),
      );
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
      for (const frame of frames) dispatchFrame(discovery.thread, frame);
      Deferred.doneUnsafe(discovery.released, Effect.void);
      // An ancestor can become ready after its descendant's metadata reply.
      releaseDiscoveries();
    }
  };

  const applyMetadata = (discovery: Discovery, answer: unknown): void => {
    if (!live) return;
    const threadId = discovery.thread.state.threadId;
    const metadata = (answer as ThreadReadResponse | undefined)?.thread;
    if (metadata === undefined || metadata.id !== threadId) {
      discovery.ready = true;
      warn(
        `Could not read metadata for subagent ${threadId}; the app-server returned no matching thread.`,
      );
      releaseDiscoveries();
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
    discovery.thread.parentThreadId ??= metadata.parentThreadId ?? undefined;
    const parent = discovery.thread.parentThreadId;
    if (parent !== undefined && parent !== options.rootThreadId) {
      if (
        parent === threadId ||
        descendsFrom(threads.get(parent) ?? createThread(parent), threadId) ||
        discoverThread(parent) === undefined
      ) {
        discovery.thread.parentThreadId = undefined;
        warn(
          `Could not introduce the parent of subagent ${threadId}; reporting the subagent without a parent.`,
        );
      }
    }
    discovery.ready = true;
    releaseDiscoveries();
  };

  const discoverThread = (threadId: string): Discovery | undefined => {
    const known = discoveries.get(threadId);
    if (known !== undefined) return known;
    if (pending.size >= MAX_PENDING_THREADS) return undefined;
    const discovery = createDiscovery(threadId);
    const lookup = Effect.runFork(
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
            if (!live) return;
            discovery.ready = true;
            warn(
              `Could not read metadata for subagent ${threadId}; reporting the subagent with the information already available.`,
            );
            releaseDiscoveries();
          },
          onSuccess: (answer) => applyMetadata(discovery, answer),
        },
      ),
    );
    lookups.add(lookup);
    lookup.addObserver(() => lookups.delete(lookup));
    return discovery;
  };

  if (options.spec.continue?.mode === "resume") {
    for (const known of options.spec.continue.subagents ?? []) {
      if (known.subagentId === options.rootThreadId) continue;
      const thread = createThread(known.subagentId);
      if (!restoreUsageReport(thread.state, known.lastUsageReport))
        restoreIds.add(known.subagentId);
    }
  }

  return {
    root,
    /** Restores only missing usage baselines before the root can start work. */
    restoreUsage: Effect.suspend(() =>
      Effect.forEach(
        [...restoreIds],
        (threadId) =>
          Effect.gen(function* () {
            if (!live)
              return yield* Effect.fail(
                "The session exited while restoring its subagents' usage counters.",
              );
            const discovery = discoveries.get(threadId) ?? createDiscovery(threadId);
            const resumed = yield* Effect.mapError(
              Effect.timeout(
                options.rpc.request("thread/resume", {
                  threadId,
                  excludeTurns: false,
                } satisfies ThreadResumeParams),
                METADATA_DEADLINE,
              ),
              () =>
                `Could not restore usage counters for subagent ${threadId}. Input was refused to avoid counting its history twice.`,
            );
            if (!live)
              return yield* Effect.fail(
                "The session exited while restoring its subagents' usage counters.",
              );
            if ((resumed as ThreadReadResponse | undefined)?.thread?.id !== threadId)
              return yield* Effect.fail(
                `Could not restore usage counters for subagent ${threadId}: Codex returned a different thread. Input was refused.`,
              );
            applyMetadata(discovery, resumed);
            // Codex serializes resume and read for the same thread. Its resume
            // handler sends restored usage after the reply, before the read can run.
            // The read's reply therefore closes the replay, even for an unused child
            // whose history contains no usage report.
            const barrier = yield* Effect.mapError(
              Effect.timeout(
                options.rpc.request("thread/read", {
                  threadId,
                  includeTurns: false,
                } satisfies ThreadReadParams),
                METADATA_DEADLINE,
              ),
              () =>
                `Could not finish restoring usage counters for subagent ${threadId}. Input was refused to avoid counting its history twice.`,
            );
            if ((barrier as ThreadReadResponse | undefined)?.thread?.id !== threadId)
              return yield* Effect.fail(
                `Could not verify restored usage counters for subagent ${threadId}: Codex returned a different thread. Input was refused.`,
              );
            yield* Effect.mapError(
              Effect.timeout(Deferred.await(discovery.released), METADATA_DEADLINE),
              () => `Could not introduce restored subagent ${threadId}. Input was refused.`,
            );
            if (!live)
              return yield* Effect.fail(
                "The session exited while restoring its subagents' usage counters.",
              );
            discovery.thread.state.previousTotal ??= {
              inputTokens: 0,
              cachedInputTokens: 0,
              cacheWriteInputTokens: 0,
              outputTokens: 0,
            };
            restoreIds.delete(threadId);
          }),
        { discard: true },
      ),
    ).pipe(Effect.tapError((message) => Effect.sync(() => warn(message)))),
    /** Routes frames after introducing their thread, preserving arrival order. */
    receive: (frame: ThreadFrame): void => {
      if (!live) return;
      const id = readThreadId(frame);
      if (id === undefined) return;
      if (id === options.rootThreadId) return dispatchFrame(root, frame);
      const discovery = discoverThread(id);
      if (discovery === undefined) {
        rejectFrame(frame);
        warn(`Dropped 1 frame for subagent ${id}: the pending metadata lookup limit was reached.`);
        return;
      }
      if (discovery.introduced) return dispatchFrame(discovery.thread, frame);
      const bytes = Buffer.byteLength(JSON.stringify(frame));
      if (pendingFrames >= MAX_PENDING_FRAMES || pendingBytes + bytes > MAX_PENDING_BYTES) {
        discovery.dropped += 1;
        rejectFrame(frame);
        return;
      }
      discovery.frames.push(frame);
      discovery.bytes += bytes;
      pendingFrames += 1;
      pendingBytes += bytes;
    },
    /** Finds a request under its own thread, regardless of opening order. */
    findRequest: (
      requestId: string,
    ): { readonly thread: ThreadState; readonly park: Park } | undefined => {
      for (const thread of threads.values()) {
        const park = thread.parks.get(requestId);
        if (park !== undefined) return { thread, park };
      }
      return undefined;
    },
    /** Selects current work to stop, retaining guards for frames awaiting metadata. */
    selectForStop: (subagentId?: string): ReadonlyArray<ThreadState> => {
      if (subagentId === undefined) stopAll = true;
      else if (!threads.has(subagentId) || subagentId === options.rootThreadId) return [];
      else stoppedSubtrees.add(subagentId);
      const selected = [...threads.values()].filter(
        (thread) => subagentId === undefined || descendsFrom(thread, subagentId),
      );
      for (const thread of selected)
        thread.stopping =
          thread.turnId !== undefined ||
          discoveries.get(thread.state.threadId)?.introduced === false;
      if (subagentId !== undefined)
        for (const discovery of pending) discovery.stopAncestors.add(subagentId);
      return selected;
    },
    beginInput: (): void => {
      inputPending = true;
    },
    finishInput: (accepted: boolean): void => {
      inputPending = false;
      if (accepted && stopAll) {
        stopAll = false;
        for (const thread of threads.values()) thread.stopping = false;
      }
    },
    /** Returns whether new work on this thread still belongs to a stopped turn. */
    isStopped: (thread: ThreadState): boolean =>
      stopAll || thread.stopping || hasStoppedAncestor(thread),
    /** Adds every thread's process count without counting a child's history again. */
    sumUsage: (): Usage => {
      const total = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
      for (const thread of threads.values()) {
        if (thread.usage === undefined) continue;
        total.inputTokens += thread.usage.inputTokens;
        total.outputTokens += thread.usage.outputTokens;
        total.cacheReadTokens += thread.usage.cacheReadTokens ?? 0;
        total.cacheWriteTokens += thread.usage.cacheWriteTokens ?? 0;
      }
      return total;
    },
    /** Discards pending callbacks when the hosting process exits. */
    close: (): void => {
      live = false;
      for (const discovery of pending) Deferred.doneUnsafe(discovery.released, Effect.void);
      Effect.runFork(Fiber.interruptAll(lookups));
      discoveries.clear();
      stoppedSubtrees.clear();
      pending.clear();
      threads.clear();
    },
  };
};

export type CodexThreads = ReturnType<typeof makeCodexThreads>;
