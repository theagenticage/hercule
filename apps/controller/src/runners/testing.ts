/**
 * Helpers for a test that plays a runner on the real runner socket, frame by
 * frame:
 *
 * - `dialRunnerSocket` opens the socket with a runner credential and returns
 *   the test's end of it;
 * - `takeFrameWithTag` reads frames from that end until one of a given kind
 *   arrives;
 * - `buildRunnerSocketUrl` returns the address a runner dials.
 *
 * Every wait here follows events on the socket, never a timer that polls, and
 * each one fails with an error naming what never happened once its deadline
 * passes. Each deadline stays below vitest's default test timeout of 5 seconds,
 * so the helper's error is the one a test fails with, not vitest's timeout.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ControllerToRunner, type RunnerToController } from "@hercule/protocol";

/**
 * The path a runner connects to, on the same host and port as the API. It is
 * written out here rather than imported from the socket module, so a test
 * fails if the controller ever serves the socket somewhere runners do not dial.
 */
export const RUNNER_SOCKET_PATH = "/api/v1/runners/socket";

/** How long `dialRunnerSocket` waits for the controller to upgrade the connection. */
const UPGRADE_DEADLINE_MS = 3_000;

/** How long `next` waits for the controller's next frame. */
const FRAME_DEADLINE_MS = 2_000;

/** How long `closed` waits for the controller to close the connection. */
const CLOSE_DEADLINE_MS = 3_000;

/** Returns the WebSocket address of the runner socket on the controller at `base`. */
export const buildRunnerSocketUrl = (base: string): string =>
  `${base.replace(/^http:/, "ws:")}${RUNNER_SOCKET_PATH}`;

/** The close code and reason the controller ended a connection with. */
export interface SocketEnding {
  readonly code: number;
  readonly reason: string;
}

/** A test's end of a runner socket, which plays the runner. */
export interface RunnerSocket {
  /** Every frame the controller has sent so far, in order, including those `next` has returned. */
  readonly frames: ReadonlyArray<ControllerToRunner>;
  readonly send: (message: RunnerToController) => void;
  /**
   * Returns the first frame that `next` has not returned yet, waiting for it
   * if it has not arrived. Fails when the controller closes the connection
   * instead, or sends nothing within 2 seconds.
   */
  readonly next: () => Promise<ControllerToRunner>;
  /**
   * Returns how the controller ended the connection, waiting for it if the
   * connection is still open. Fails when the connection is still open after
   * 3 seconds.
   */
  readonly closed: () => Promise<SocketEnding>;
  readonly close: () => void;
}

/** A pending call of `next` or `closed`, with the timer that fails it at its deadline. */
interface Waiter<A> {
  readonly resolve: (value: A) => void;
  readonly reject: (error: Error) => void;
  readonly deadline: ReturnType<typeof setTimeout>;
}

/** Parses a WebSocket message as JSON and decodes it as a frame the controller sends a runner. */
const decodeFrame = (data: unknown): ControllerToRunner =>
  Effect.runSync(
    Schema.decodeUnknownEffect(ControllerToRunner)(JSON.parse(String(data)) as unknown),
  );

/** Builds the error a pending `next` fails with when the controller closes the connection. */
const buildClosedError = (ending: SocketEnding): Error =>
  new Error(`the controller closed (${String(ending.code)} ${ending.reason}) instead of answering`);

/**
 * Opens the runner socket on the controller at `base` with `credential`, the
 * way a runner does, and returns the test's end of it once the controller has
 * upgraded the connection. The credential is sent with the upgrade request,
 * so a connection that opens has already been accepted. Sends nothing: the
 * test sends the hello itself.
 *
 * Fails when the controller refuses the upgrade, or has not upgraded the
 * connection within 3 seconds.
 */
export const dialRunnerSocket = (base: string, credential: string): Promise<RunnerSocket> =>
  new Promise((resolveSocket, rejectSocket) => {
    const socket = new WebSocket(buildRunnerSocketUrl(base), {
      headers: { authorization: `Bearer ${credential}` },
    });
    const frames: Array<ControllerToRunner> = [];
    let taken = 0;
    let ending: SocketEnding | undefined;
    const frameWaiters: Array<Waiter<ControllerToRunner>> = [];
    const closeWaiters: Array<Waiter<SocketEnding>> = [];

    const upgradeDeadline = setTimeout(() => {
      socket.close();
      rejectSocket(new Error("the controller never upgraded the connection"));
    }, UPGRADE_DEADLINE_MS);

    /**
     * Adds a waiter to `waiters`, for a socket event to settle, and returns its
     * promise. Fails with `timeoutMessage` when no event has settled it after
     * `deadlineMs`.
     */
    const addWaiter = <A>(
      waiters: Array<Waiter<A>>,
      timeoutMessage: string,
      deadlineMs: number,
    ): Promise<A> =>
      new Promise((resolve, reject) => {
        const waiter: Waiter<A> = {
          resolve,
          reject,
          deadline: setTimeout(() => {
            waiters.splice(waiters.indexOf(waiter), 1);
            reject(new Error(timeoutMessage));
          }, deadlineMs),
        };
        waiters.push(waiter);
      });

    socket.onmessage = (event) => {
      frames.push(decodeFrame(event.data));
      const waiter = frameWaiters.shift();
      if (waiter === undefined) return;
      clearTimeout(waiter.deadline);
      waiter.resolve(frames[taken++]!);
    };
    socket.onclose = (event) => {
      clearTimeout(upgradeDeadline);
      ending = { code: event.code, reason: event.reason };
      // Rejecting does nothing once the upgrade has resolved the promise.
      rejectSocket(
        new Error(`the controller refused the upgrade (${String(ending.code)} ${ending.reason})`),
      );
      for (const waiter of frameWaiters.splice(0)) {
        clearTimeout(waiter.deadline);
        waiter.reject(buildClosedError(ending));
      }
      for (const waiter of closeWaiters.splice(0)) {
        clearTimeout(waiter.deadline);
        waiter.resolve(ending);
      }
    };
    socket.onerror = () => {
      // A refused upgrade also fires an error event. The close handler reports
      // it, because only the close event carries the code and the reason.
    };
    socket.onopen = () => {
      clearTimeout(upgradeDeadline);
      resolveSocket({
        frames,
        send: (message) => socket.send(JSON.stringify(message)),
        next: () => {
          if (taken < frames.length) return Promise.resolve(frames[taken++]!);
          if (ending !== undefined) return Promise.reject(buildClosedError(ending));
          return addWaiter(frameWaiters, "the controller sent nothing", FRAME_DEADLINE_MS);
        },
        closed: () =>
          ending === undefined
            ? addWaiter(closeWaiters, "the controller held the connection open", CLOSE_DEADLINE_MS)
            : Promise.resolve(ending),
        close: () => socket.close(),
      });
    };
  });

/**
 * Reads frames from `socket` with `next` until one with `tag` arrives, and
 * returns that frame. Frames of other kinds before it are skipped. Fails when
 * `next` fails, or when 40 frames in a row are of other kinds.
 */
export const takeFrameWithTag = async <Tag extends ControllerToRunner["_tag"]>(
  socket: RunnerSocket,
  tag: Tag,
): Promise<Extract<ControllerToRunner, { readonly _tag: Tag }>> => {
  for (let read = 0; read < 40; read++) {
    const frame = await socket.next();
    if (frame._tag === tag) return frame as Extract<ControllerToRunner, { readonly _tag: Tag }>;
  }
  throw new Error(`the controller never sent ${tag}`);
};
