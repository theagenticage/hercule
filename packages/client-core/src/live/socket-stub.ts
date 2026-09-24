/**
 * A fake `WebSocket` that also plays the server on the other end.
 *
 * The live transport is Effect RPC over JSON, so the stub has to use that
 * framing rather than the contract's types. Keeping that knowledge in one
 * module keeps it out of every test that only wants to send a push. The stub:
 *
 * - opens immediately;
 * - records every frame the client sends;
 * - replies to the three messages the transport needs to work: its keepalive
 *   ping, `hello` and `ping`.
 *
 * The test drives everything else.
 *
 * It lives in the package source rather than beside one test because two
 * packages use it: this package's unit tests and the web app's integration
 * tests. It is imported as `@hercule/client-core/testing`, which no app code
 * imports.
 */

/** The server version the stub replies to `hello` with, so a test can assert on it. */
export const STUB_SERVER_VERSION = "0.1.0";

/**
 * Returns a `webSocket` factory for tests. Each call creates a stub socket and
 * appends it to `sockets`, so the test can reach the current socket and every
 * earlier one.
 */
export const stubWebSocketInto =
  (sockets: Array<StubSocket>) =>
  (url: string): WebSocket => {
    const socket = new StubSocket(url);
    sockets.push(socket);
    return socket as unknown as WebSocket;
  };

/** One frame as sent over the socket: the RPC codec's JSON envelope. */
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

  /** Returns the frames the client sent with the given `_tag`. */
  frames(tag: string): Array<Frame> {
    return this.sent.filter((frame) => frame._tag === tag);
  }

  /** Returns the client's calls to one RPC method, oldest first. */
  calls(name: string): Array<Frame> {
    return this.frames("Request").filter((frame) => frame.tag === name);
  }

  /**
   * Returns the subscriptions the client holds open, oldest first: every
   * `subscribe` call it has not interrupted since.
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
   * Sends a live message on the client's subscription to `topic`. Throws when
   * the client has no subscription to `topic`, because that is a mistake in
   * the test, not a push that should silently go nowhere.
   */
  push(topic: string, message: unknown): void {
    const held = this.subscriptions().find((subscription) => subscription.topic === topic);
    if (held === undefined) throw new Error(`nothing is subscribed to ${topic}`);
    this.chunk(held.requestId, [message]);
  }

  /** Sends a stream chunk for a call the client has open. */
  chunk(requestId: unknown, values: ReadonlyArray<unknown>): void {
    this.deliver({ _tag: "Chunk", requestId, values });
  }

  /** Fails a call with a typed error, in the contract's envelope. */
  fail(requestId: unknown, error: unknown): void {
    this.deliver({
      _tag: "Exit",
      requestId,
      exit: { _tag: "Failure", cause: [{ _tag: "Fail", error }] },
    });
  }

  /** Closes the connection from the server side, without the client asking. */
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
