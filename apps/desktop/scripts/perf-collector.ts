/**
 * Records what the app's page sends and receives over the network, for the
 * perf scenarios that count reads and pushes (Tracking is the first). It uses
 * the Chrome DevTools Protocol's Network domain, which sees every HTTP request
 * to the controller, with timings and body size, and every frame of the live
 * WebSocket, parsed into pushes by topic.
 *
 * It replaces two things that gave wrong numbers:
 *
 * - Resource Timing. The page is `app://hercule` and the controller is HTTP,
 *   so the browser hides `requestStart` and `responseStart` (they read 0)
 *   unless the controller sends `Timing-Allow-Origin`. The protocol's timings
 *   are not hidden, and the controller needs no header for the measurement.
 * - A `WebSocket` patch. It sees a frame only after the patch is in, and the
 *   page subscribes during start-up. A collector is enabled before the page
 *   loads (the caller reloads the page), so it misses no frame.
 *
 * An attached tool changes what it measures. Use a collector for counts and
 * request timings, never while memory or idle CPU and wakeups are read.
 *
 * It runs on plain Node, like the perf script, so its imports name the `.ts`
 * file.
 */
import { pollUntil } from "./poll.ts";

/** One HTTP request the page made to the controller. */
export interface RecordedRequest {
  readonly method: string;
  readonly url: URL;
  /** When the request began, in milliseconds on the protocol's monotonic clock. */
  readonly startedAtMs: number;
  /** From the request to the end of its answer, or null while it is in flight. */
  durationMs: number | null;
  /** From the request being sent to the first byte of the answer, or null when the protocol reports no timing. */
  firstByteMs: number | null;
  /** The size of the answer's body after decompression, in bytes. */
  bodyBytes: number;
}

/** One message the controller pushed on a live topic. */
export interface RecordedPush {
  readonly topic: string;
  /** Whether it is the first message after subscribing, which says every record may have changed and is not a change anyone made. */
  readonly initial: boolean;
}

/** A place in the recording: how much was recorded when `Collector.checkpoint` was called. */
export interface Checkpoint {
  readonly requests: number;
  readonly pushes: number;
}

/** What a collector recorded after a `Checkpoint`. */
export interface Recording {
  readonly requests: readonly RecordedRequest[];
  readonly pushes: readonly RecordedPush[];
}

export interface Collector {
  readonly checkpoint: () => Checkpoint;
  /** Returns the requests that began and the pushes that arrived after `from`. */
  readonly since: (from: Checkpoint) => Recording;
  /** Returns the live topics the page holds now, sorted. */
  readonly listHeldTopics: () => string[];
  /**
   * Waits until `count` pushes on `topic` have arrived after `from`, the first
   * message after subscribing only if `includeInitial`. Fails with `what` after 5 s.
   */
  readonly waitForPushes: (
    from: Checkpoint,
    topic: string,
    count: number,
    what: string,
    includeInitial?: boolean,
  ) => Promise<void>;
  /**
   * Waits until no request is in flight and no request has begun or ended and
   * no push has arrived for `quietMs`, so every read a push caused has
   * finished. Call it after `waitForPushes`: a read starts some time after its
   * push arrives, and this waits that long. It cannot show that a read never
   * comes. Fails after 10 s.
   */
  readonly waitForQuietReads: (quietMs: number) => Promise<void>;
  readonly close: () => void;
}

/** The fields of the protocol's messages that the collector reads; each message carries some of them. */
interface ProtocolMessage {
  readonly id?: number;
  readonly method?: string;
  readonly error?: { readonly message: string };
  readonly params?: {
    readonly requestId: string;
    readonly timestamp: number;
    readonly type?: string;
    readonly dataLength: number;
    readonly request: { readonly url: string; readonly method: string };
    readonly response: {
      readonly payloadData: string;
      readonly timing?: {
        readonly sendEnd: number;
        readonly receiveHeadersStart: number;
        readonly receiveHeadersEnd: number;
      } | null;
    };
  };
}

/** One RPC message of the live connection, with the fields the collector reads. */
interface RpcMessage {
  readonly _tag?: string;
  readonly id?: number;
  readonly requestId?: number;
  readonly tag?: string;
  readonly payload?: { readonly topic?: string };
  readonly values?: readonly { readonly _tag?: string }[];
}

/** Follows the live connection's subscriptions from the frames it carries. */
export interface FrameTracker {
  /**
   * Reads one frame of the WebSocket `socketId` and returns the pushes it
   * carried: the `invalidate` messages of a `Chunk` for a subscription it has
   * seen. Frames of any other kind carry none, so a keepalive is never a push.
   */
  readonly readFrame: (socketId: string, payload: string) => RecordedPush[];
  /** Forgets the subscriptions of the WebSocket `socketId`, which closed. */
  readonly forgetSocket: (socketId: string) => void;
  /** Returns the topics subscribed and not unsubscribed or ended since, sorted. */
  readonly listHeldTopics: () => string[];
}

/** Creates a tracker that has seen no frame. */
export function createFrameTracker(): FrameTracker {
  // A subscription is named by its WebSocket's id and its RPC call's id.
  const topicBySubscription = new Map<string, string>();
  const subscriptionsWithMessage = new Set<string>();
  return {
    readFrame: (socketId, payload) => {
      let messages: RpcMessage[];
      try {
        messages = [JSON.parse(payload) as RpcMessage | RpcMessage[]].flat();
      } catch {
        return [];
      }
      const pushes: RecordedPush[] = [];
      for (const message of messages) {
        if (message._tag === "Request" && message.tag === "subscribe") {
          topicBySubscription.set(
            `${socketId}:${String(message.id)}`,
            message.payload?.topic ?? "",
          );
          continue;
        }
        const key = `${socketId}:${String(message.requestId)}`;
        if (message._tag === "Interrupt" || message._tag === "Exit") {
          topicBySubscription.delete(key);
          subscriptionsWithMessage.delete(key);
        }
        const topic = topicBySubscription.get(key);
        if (message._tag !== "Chunk" || topic === undefined) continue;
        // One Chunk can carry several messages, so "first" is decided for each message.
        for (const value of message.values ?? []) {
          if (value._tag !== "invalidate") continue;
          pushes.push({ topic, initial: !subscriptionsWithMessage.has(key) });
          subscriptionsWithMessage.add(key);
        }
      }
      return pushes;
    },
    forgetSocket: (socketId) => {
      for (const key of [...topicBySubscription.keys()]) {
        if (!key.startsWith(`${socketId}:`)) continue;
        topicBySubscription.delete(key);
        subscriptionsWithMessage.delete(key);
      }
    },
    listHeldTopics: () => [...new Set(topicBySubscription.values())].sort(),
  };
}

/**
 * Attaches a collector to the page that `pageSocketUrl` names and enables its
 * Network domain. Only requests over `http:` are recorded: the page's own
 * files come over `app:`. Fails when the connection is refused.
 */
export async function startCollector(pageSocketUrl: string): Promise<Collector> {
  const socket = new WebSocket(pageSocketUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener(
      "error",
      () => reject(new Error(`could not connect to ${pageSocketUrl}`)),
      { once: true },
    );
  });

  const requests: RecordedRequest[] = [];
  const pushes: RecordedPush[] = [];
  const requestById = new Map<string, RecordedRequest>();
  const frames = createFrameTracker();
  let inFlight = 0;
  let lastActivityAt = Date.now();

  const handleEvent = ({ method, params }: ProtocolMessage) => {
    if (params === undefined) return;
    const request = requestById.get(params.requestId);
    switch (method) {
      case "Network.requestWillBeSent": {
        const url = new URL(params.request.url);
        if (url.protocol !== "http:" || params.type === "Preflight") return;
        const recorded: RecordedRequest = {
          method: params.request.method,
          url,
          startedAtMs: params.timestamp * 1_000,
          durationMs: null,
          firstByteMs: null,
          bodyBytes: 0,
        };
        requests.push(recorded);
        requestById.set(params.requestId, recorded);
        inFlight += 1;
        lastActivityAt = Date.now();
        return;
      }
      case "Network.responseReceived": {
        const timing = params.response.timing;
        if (request === undefined || !timing) return;
        const firstByteAt =
          timing.receiveHeadersStart >= 0 ? timing.receiveHeadersStart : timing.receiveHeadersEnd;
        request.firstByteMs = firstByteAt - timing.sendEnd;
        return;
      }
      case "Network.dataReceived":
        if (request !== undefined) request.bodyBytes += params.dataLength;
        return;
      case "Network.loadingFinished":
      case "Network.loadingFailed":
        if (request === undefined || request.durationMs !== null) return;
        request.durationMs = params.timestamp * 1_000 - request.startedAtMs;
        inFlight -= 1;
        lastActivityAt = Date.now();
        return;
      case "Network.webSocketFrameSent":
      case "Network.webSocketFrameReceived":
        for (const push of frames.readFrame(params.requestId, params.response.payloadData)) {
          pushes.push(push);
          lastActivityAt = Date.now();
        }
        return;
      case "Network.webSocketClosed":
        frames.forgetSocket(params.requestId);
        return;
    }
  };

  let answerEnable: (reply: ProtocolMessage) => void = () => undefined;
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as ProtocolMessage;
    if (message.id === undefined) handleEvent(message);
    else answerEnable(message);
  });
  await new Promise<void>((resolve, reject) => {
    answerEnable = (reply) =>
      reply.error === undefined ? resolve() : reject(new Error(reply.error.message));
    socket.send(JSON.stringify({ id: 1, method: "Network.enable" }));
  });

  const countPushes = (from: Checkpoint, topic: string, includeInitial: boolean) =>
    pushes
      .slice(from.pushes)
      .filter((push) => push.topic === topic && (includeInitial || !push.initial)).length;
  return {
    checkpoint: () => ({ requests: requests.length, pushes: pushes.length }),
    since: (from) => ({
      requests: requests.slice(from.requests),
      pushes: pushes.slice(from.pushes),
    }),
    listHeldTopics: frames.listHeldTopics,
    waitForPushes: (from, topic, count, what, includeInitial = false) =>
      pollUntil(() => (countPushes(from, topic, includeInitial) >= count ? true : undefined), {
        timeoutMs: 5_000,
        intervalMs: 20,
        timeoutMessage: () =>
          `${what}: the page received ${String(countPushes(from, topic, includeInitial))} pushes on the ${topic} topic, not ${String(count)}, within 5 s`,
      }).then(() => undefined),
    waitForQuietReads: (quietMs) =>
      pollUntil(
        () => (inFlight === 0 && Date.now() - lastActivityAt >= quietMs ? true : undefined),
        {
          timeoutMs: 10_000,
          intervalMs: 20,
          timeoutMessage: "the page still had requests in flight or starting 10 s later",
        },
      ).then(() => undefined),
    close: () => socket.close(),
  };
}
