/**
 * A `WebSocket` that is also the fake server it talks to.
 *
 * The transport under it is Effect RPC over JSON, so a stub has to speak that
 * framing rather than the contract's own shapes; putting that knowledge in one
 * module keeps it out of every test that only wants to press a push. The stub
 * opens immediately, records every frame the client writes, and answers the
 * three things the transport cannot get on without - its own keepalive,
 * `hello` and `ping`. Everything else is driven by the test.
 *
 * It lives in the shipped source rather than beside one test because two
 * packages drive the same supervisor: this one's unit tests and the web app's
 * integration tests. It is reached as `@hercule/client-core/testing`, which
 * nothing in the app imports.
 */

/** What the stub greets with, and what a caller can assert it read. */
export const STUB_SERVER_VERSION = "0.1.0";

/**
 * The `webSocket` a supervisor is built with in a test: it opens a stub and
 * keeps it, in the order it opened them, so the caller can reach the one a
 * connection is on now and the ones it has been on.
 */
export const openInto =
  (sockets: Array<StubSocket>) =>
  (url: string): WebSocket => {
    const socket = new StubSocket(url);
    sockets.push(socket);
    return socket as unknown as WebSocket;
  };

/** One frame as it crosses the wire: the RPC codec's own JSON envelope. */
export type Frame = Record<string, unknown>;

interface Listener {
  readonly handler: (event: unknown) => void;
  readonly once: boolean;
}

export class StubSocket {
  readonly url: string;
  readonly sent: Array<Frame> = [];
  readyState = 1;
  closedWith: { readonly code: number; readonly reason: string } | null = null;

  private readonly listeners = new Map<string, Array<Listener>>();

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(
    type: string,
    handler: (event: unknown) => void,
    options?: { readonly once?: boolean },
  ): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push({ handler, once: options?.once === true });
    this.listeners.set(type, existing);
  }

  removeEventListener(type: string, handler: (event: unknown) => void): void {
    const existing = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      existing.filter((listener) => listener.handler !== handler),
    );
  }

  send(data: string): void {
    const decoded: unknown = JSON.parse(data);
    const frames = (Array.isArray(decoded) ? decoded : [decoded]) as Array<Frame>;
    for (const frame of frames) {
      this.sent.push(frame);
      this.answer(frame);
    }
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState !== 1) return;
    this.readyState = 3;
    this.closedWith = { code, reason };
    queueMicrotask(() => this.emit("close", { code, reason }));
  }

  /** The frames the client sent, of one kind. */
  frames(tag: string): Array<Frame> {
    return this.sent.filter((frame) => frame._tag === tag);
  }

  /** The calls the client made to one RPC method, oldest first. */
  calls(name: string): Array<Frame> {
    return this.frames("Request").filter((frame) => frame.tag === name);
  }

  /**
   * The subscriptions the client is holding open, oldest first: every
   * `subscribe` it sent that it has not interrupted since.
   */
  subscriptions(): Array<{ readonly topic: string; readonly requestId: unknown }> {
    const ended = new Set(this.frames("Interrupt").map((frame) => frame.requestId));
    return this.calls("subscribe")
      .filter((frame) => !ended.has(frame.id))
      .map((frame) => ({
        topic: (frame.payload as { readonly topic: string }).topic,
        requestId: frame.id,
      }));
  }

  /**
   * One live message on the subscription the client holds for `topic`. Asking
   * for a topic nothing is subscribed to is the test's mistake, not a push
   * that goes nowhere, so it says so.
   */
  push(topic: string, message: unknown): void {
    const held = this.subscriptions().find((subscription) => subscription.topic === topic);
    if (held === undefined) throw new Error(`nothing is subscribed to ${topic}`);
    this.chunk(held.requestId, [message]);
  }

  /** A stream chunk for a call the client has open. */
  chunk(requestId: unknown, values: ReadonlyArray<unknown>): void {
    this.deliver({ _tag: "Chunk", requestId, values });
  }

  /** A call's typed failure, in the contract's envelope. */
  fail(requestId: unknown, error: unknown): void {
    this.deliver({
      _tag: "Exit",
      requestId,
      exit: { _tag: "Failure", cause: [{ _tag: "Fail", error }] },
    });
  }

  /** The connection going away underneath the client. */
  drop(code = 1006): void {
    this.readyState = 3;
    this.emit("close", { code, reason: "" });
  }

  private answer(frame: Frame): void {
    if (frame._tag === "Ping") {
      this.deliver({ _tag: "Pong" });
      return;
    }
    if (frame._tag !== "Request") return;
    if (frame.tag === "hello") {
      this.deliver({
        _tag: "Exit",
        requestId: frame.id,
        exit: { _tag: "Success", value: { v: 1, serverVersion: STUB_SERVER_VERSION } },
      });
    } else if (frame.tag === "ping") {
      this.deliver({
        _tag: "Exit",
        requestId: frame.id,
        exit: { _tag: "Success", value: {} },
      });
    }
  }

  private deliver(message: unknown): void {
    queueMicrotask(() => {
      if (this.readyState !== 1) return;
      this.emit("message", { data: JSON.stringify(message) });
    });
  }

  private emit(type: string, event: unknown): void {
    const existing = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      existing.filter((listener) => !listener.once),
    );
    for (const listener of existing) listener.handler(event);
  }
}
