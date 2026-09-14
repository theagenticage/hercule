/**
 * The newline-delimited JSON-RPC Codex speaks over stdio. Hydra owns the codec
 * rather than taking a library because Codex omits the `jsonrpc` member in both
 * directions, which a strict library refuses, and because an app-server drops a
 * method it does not know without answering at all.
 */
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

/**
 * The app-server's stdio, framed: one item per line, because a frame split over
 * two reads is not a frame.
 */
export interface RpcChild {
  readonly write: (text: string) => void;
  readonly stdout: AsyncIterable<string>;
}

/** The whole child: the codec's half of it, plus what only its owner uses. */
export interface AppServerChild extends RpcChild {
  readonly stderr: AsyncIterable<string>;
  readonly kill: () => void;
  readonly exited: Promise<number>;
}

export type AppServerSpawn = (
  command: ReadonlyArray<string>,
  env: Readonly<Record<string, string | undefined>>,
) => AppServerChild;

/** `code` is the peer's; a request that failed here rather than there has none. */
export interface RpcError {
  readonly code?: number;
  readonly message: string;
}

export interface ServerRequestFrame {
  /** Echoed back verbatim: Codex types an id as a string or a number. */
  readonly id: string | number;
  readonly method: string;
  readonly params: unknown;
}

export interface NotificationFrame {
  readonly method: string;
  readonly params: unknown;
}

export interface RpcHandlers {
  readonly onServerRequest: (frame: ServerRequestFrame) => void;
  readonly onNotification: (frame: NotificationFrame) => void;
  readonly onWarning: (message: string) => void;
}

export interface Rpc {
  readonly request: (method: string, params: unknown) => Effect.Effect<unknown, RpcError>;
  readonly notify: (method: string) => void;
  /** Reads the peer until it stops talking; nothing is answered before it runs. */
  readonly pump: Effect.Effect<void>;
}

/**
 * How long a request waits. Every one is bounded because an unknown method gets
 * no reply at all, so without a bound a method dropped in a Codex upgrade would
 * leak a pending entry on every call for the life of the process.
 */
export const RPC_DEADLINE: Duration.Duration = Duration.seconds(30);

const GONE = "the app-server stopped talking";

const MALFORMED = "the app-server answered with an error it did not describe";

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** An error reply is the peer's to shape, and it may shape it wrongly. */
const errorOf = (reply: unknown): RpcError => {
  if (typeof reply !== "object" || reply === null) return { message: MALFORMED };
  const { code, message } = reply as { readonly code?: unknown; readonly message?: unknown };
  return {
    ...(typeof code === "number" ? { code } : {}),
    message: typeof message === "string" ? message : MALFORMED,
  };
};

export const rpcOver = (child: RpcChild, handlers: RpcHandlers): Rpc => {
  const pending = new Map<number, Deferred.Deferred<unknown, RpcError>>();
  let next = 1;
  let gone = false;

  const settle = (frame: Record<string, unknown>, id: number): void => {
    const waiting = pending.get(id);
    if (waiting === undefined) return;
    pending.delete(id);
    Deferred.doneUnsafe(
      waiting,
      "error" in frame ? Effect.fail(errorOf(frame["error"])) : Effect.succeed(frame["result"]),
    );
  };

  /**
   * Which of `id` and `method` a frame carries is the whole taxonomy: a server
   * request read as a notification would leave Codex waiting for ever.
   */
  const deliver = (line: string): void => {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // One unreadable line must not take the connection down: the harness
      // writes its own complaints down this pipe too.
      handlers.onWarning(`the app-server wrote a line that is not a frame: ${line}`);
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
        // Registered before the write, because the answer may be delivered
        // inside it, and taken back out again when the write is what failed.
        pending.set(id, settled);
        try {
          child.write(`${JSON.stringify({ id, method, params })}\n`);
        } catch (error) {
          pending.delete(id);
          return Effect.fail<RpcError>({ message: describe(error) });
        }
        return Deferred.await(settled).pipe(
          Effect.timeoutOrElse({
            duration: RPC_DEADLINE,
            orElse: () =>
              Effect.fail<RpcError>({
                message: `the app-server did not answer ${method} within ${Duration.format(RPC_DEADLINE)}`,
              }),
          }),
          Effect.ensuring(Effect.sync(() => void pending.delete(id))),
        );
      }),

    notify: (method) => child.write(`${JSON.stringify({ method })}\n`),

    pump: Effect.callback<void>((resume, signal) => {
      void (async () => {
        try {
          for await (const line of child.stdout) {
            if (signal.aborted) return;
            if (line.trim() !== "") deliver(line);
          }
        } catch {
          // A pipe that threw mid-read is a peer that has gone, same as one
          // that ended, and the requests waiting on it must hear so either way.
        }
        if (signal.aborted) return;
        // Every request still waiting is waiting on a peer that has gone: the
        // caller hears that now rather than at its deadline.
        abandon();
        resume(Effect.void);
      })();
    }),
  };
};
