/**
 * The newline-delimited JSON-RPC that Codex uses over stdio. We write our own
 * codec rather than use a library for two reasons:
 *
 * - Codex leaves out the `jsonrpc` field in both directions, and a strict
 *   library rejects such frames.
 * - An app-server ignores a method it does not know and never replies, so
 *   every request needs a timeout.
 */
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

/**
 * The app-server's stdio, split into lines. Each `stdout` item is one whole
 * line, because a frame split across two reads cannot be parsed.
 */
export interface RpcChild {
  readonly write: (text: string) => void;
  readonly stdout: AsyncIterable<string>;
}

/** The app-server child process: the part the codec uses, plus what only the adapter uses. */
export interface AppServerChild extends RpcChild {
  readonly stderr: AsyncIterable<string>;
  readonly kill: () => void;
  readonly exited: Promise<number>;
}

export type AppServerSpawn = (
  command: ReadonlyArray<string>,
  env: Readonly<Record<string, string | undefined>>,
) => AppServerChild;

/**
 * A failed request. `code` is set only when the app-server sent the error; a
 * request that failed locally, such as a failed write or a timeout, has none.
 */
export interface RpcError {
  readonly code?: number;
  readonly message: string;
}

export interface ServerRequestFrame {
  /** Sent back unchanged in the reply, because Codex uses both string and number ids. */
  readonly id: string | number;
  readonly method: string;
  readonly params: unknown;
}

export interface NotificationFrame {
  readonly method: string;
  readonly params: unknown;
}

/** The reply to a request: either a result or an error, never both. */
export type RpcReply = { readonly result: unknown } | { readonly error: RpcError };

export interface RpcHandlers {
  readonly onServerRequest: (frame: ServerRequestFrame) => void;
  readonly onNotification: (frame: NotificationFrame) => void;
  readonly onWarning: (message: string) => void;
}

export interface Rpc {
  readonly request: (method: string, params: unknown) => Effect.Effect<unknown, RpcError>;
  readonly notify: (method: string) => void;
  /**
   * Replies to a server request by its id. Every server request must get a
   * reply, including ones this build does not handle: a request with no reply
   * leaves the turn hanging forever, with no error shown anywhere.
   */
  readonly answer: (id: string | number, body: RpcReply) => void;
  /** Reads stdout until the app-server closes it. No reply is delivered until this runs. */
  readonly pump: Effect.Effect<void>;
}

/**
 * How long a request waits for the app-server to reply. Every request has a
 * timeout because an unknown method gets no reply at all. Without one, a
 * method removed in a Codex upgrade would leak a pending entry on every call
 * for the life of the process. The timeout is thirty seconds because some
 * requests go over the network (starting a thread authenticates), and the
 * app-server handles the runner's frames on its own loop, not on the loop the
 * runner uses to handle a session's frames one at a time.
 */
export const RPC_DEADLINE: Duration.Duration = Duration.seconds(30);

/** The JSON-RPC code for a request the server could not complete. */
export const INTERNAL_ERROR = -32603;

const GONE = "the app-server exited or closed its output";

const MALFORMED = "the app-server returned an error with no message";

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Parses the `error` field of a reply. The app-server may send a malformed
 * error, so a missing or non-string message is replaced with a generic one.
 */
const parseRpcError = (reply: unknown): RpcError => {
  if (typeof reply !== "object" || reply === null) return { message: MALFORMED };
  const { code, message } = reply as { readonly code?: unknown; readonly message?: unknown };
  return {
    ...(typeof code === "number" ? { code } : {}),
    message: typeof message === "string" ? message : MALFORMED,
  };
};

export const makeRpc = (child: RpcChild, handlers: RpcHandlers): Rpc => {
  const pending = new Map<number, Deferred.Deferred<unknown, RpcError>>();
  let next = 1;
  let gone = false;
  let complained = false;

  /**
   * Writes one frame. Returns the error message if the write failed, or
   * `undefined` if it succeeded. Every write goes through here because a child
   * whose stdin has closed throws on each write, and a throw from `answer` or
   * `notify` would crash the caller instead of being reported as a broken
   * connection. The warning is sent only once, because after the pipe closes
   * every later write fails for the same reason.
   */
  const send = (frame: Record<string, unknown>): string | undefined => {
    try {
      child.write(`${JSON.stringify(frame)}\n`);
      return undefined;
    } catch (error) {
      const failure = describeError(error);
      if (!complained) {
        complained = true;
        handlers.onWarning(`could not write to the app-server: ${failure}`);
      }
      return failure;
    }
  };

  const settle = (frame: Record<string, unknown>, id: number): void => {
    const waiting = pending.get(id);
    if (waiting === undefined) return;
    pending.delete(id);
    Deferred.doneUnsafe(
      waiting,
      "error" in frame
        ? Effect.fail(parseRpcError(frame["error"]))
        : Effect.succeed(frame["result"]),
    );
  };

  /**
   * Parses one line and routes it by the fields it has:
   *
   * - no `method`: a reply to one of our requests, matched by `id`.
   * - `method` and no `id`: a notification.
   * - `method` and `id`: a server request, which needs a reply. Treating it as
   *   a notification would leave Codex waiting forever.
   */
  const deliver = (line: string): void => {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // One bad line must not close the connection: Codex also writes its own
      // plain-text warnings to this pipe.
      handlers.onWarning(`the app-server wrote a line that is not JSON: ${line}`);
      return;
    }
    const method = frame["method"];
    const id = frame["id"];
    if (typeof method !== "string") {
      if (typeof id === "number") settle(frame, id);
      return;
    }
    if (typeof id !== "string" && typeof id !== "number") {
      handlers.onNotification({ method, params: frame["params"] });
      return;
    }
    handlers.onServerRequest({ id, method, params: frame["params"] });
  };

  const abandon = (): void => {
    gone = true;
    for (const [id, waiting] of pending) {
      pending.delete(id);
      Deferred.doneUnsafe(waiting, Effect.fail({ message: GONE }));
    }
  };

  return {
    request: (method, params) =>
      Effect.suspend(() => {
        if (gone) return Effect.fail<RpcError>({ message: GONE });
        const id = next++;
        const settled = Deferred.makeUnsafe<unknown, RpcError>();
        // Registered before the write, because the reply may be delivered
        // during the write. Removed again if the write itself fails.
        pending.set(id, settled);
        const failure = send({ id, method, params });
        if (failure !== undefined) {
          pending.delete(id);
          return Effect.fail<RpcError>({ message: failure });
        }
        return Deferred.await(settled).pipe(
          Effect.timeoutOrElse({
            duration: RPC_DEADLINE,
            orElse: () =>
              Effect.fail<RpcError>({
                message: `the app-server did not reply to ${method} within ${Duration.format(RPC_DEADLINE)}`,
              }),
          }),
          Effect.ensuring(Effect.sync(() => void pending.delete(id))),
        );
      }),

    notify: (method) => void send({ method }),

    answer: (id, body) => void send({ id, ...body }),

    pump: Effect.callback<void>((resume, signal) => {
      void (async () => {
        try {
          for await (const line of child.stdout) {
            if (signal.aborted) return;
            if (line.trim() !== "") deliver(line);
          }
        } catch {
          // A pipe that throws while reading means the app-server is gone,
          // just like a pipe that ends. Either way, the waiting requests fail.
        }
        if (signal.aborted) return;
        // The app-server is gone, so fail every waiting request now instead
        // of letting each one wait for its timeout.
        abandon();
        resume(Effect.void);
      })();
    }),
  };
};
