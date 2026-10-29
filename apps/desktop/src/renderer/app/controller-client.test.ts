import { ConnectionError, MAX_INPUT_ANSWER_WAIT_MS } from "@hercule/client-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createControllerClient, fetchWithTimeout } from "./controller-client";

const SETUP_URL = "http://127.0.0.1:4937/api/v1/setup";

/**
 * Returns a body that sends its first byte and then nothing more. Like the
 * body of a fetch in Chromium, it fails with "Failed to fetch" when `signal`
 * aborts, not with the signal's reason.
 */
const buildStalledBody = (signal: AbortSignal): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("{"));
      signal.addEventListener(
        "abort",
        () => {
          controller.error(new TypeError("Failed to fetch"));
        },
        { once: true },
      );
    },
  });

/** Stubs the global `fetch` with `answer`, which receives the request's signal. */
const stubFetch = (answer: (signal: AbortSignal) => Promise<Response>): void => {
  vi.stubGlobal("fetch", (_url: string, init: RequestInit) => answer(init.signal as AbortSignal));
};

/**
 * Returns a body that sends a byte every `interval` ms, `count` times, then
 * ends. Like the body of a fetch in Chromium, it fails with "Failed to fetch"
 * when `signal` aborts.
 */
const buildTrickleBody = (
  signal: AbortSignal,
  interval: number,
  count: number,
): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      let sent = 0;
      const timer = setInterval(() => {
        controller.enqueue(new TextEncoder().encode(" "));
        sent += 1;
        if (sent === count) {
          clearInterval(timer);
          controller.close();
        }
      }, interval);
      signal.addEventListener(
        "abort",
        () => {
          clearInterval(timer);
          controller.error(new TypeError("Failed to fetch"));
        },
        { once: true },
      );
    },
  });

/** Returns a promise that rejects with the signal's reason when `signal` aborts, and never resolves. */
const waitForAbort = (signal: AbortSignal): Promise<Response> =>
  new Promise((_resolve, reject) => {
    signal.addEventListener(
      "abort",
      () => {
        reject(signal.reason as Error);
      },
      { once: true },
    );
  });

/**
 * Starts reading `response`'s body, and returns a function that reports the
 * read's failure so far: undefined while it has not failed, else the
 * `DOMException`'s name and message.
 */
const readBodyFailure = (response: Response): (() => string | undefined) => {
  let failure: string | undefined;
  response.text().catch((error: unknown) => {
    failure = `${(error as DOMException).name}: ${(error as DOMException).message}`;
  });
  return () => failure;
};

/**
 * Sends a request with `method` to `path` to a controller that never answers,
 * and returns a function that reports its failure so far, as `readBodyFailure`
 * does.
 */
const sendUnanswered = (path: string, method = "GET"): (() => string | undefined) => {
  stubFetch(waitForAbort);
  let failure: string | undefined;
  fetchWithTimeout(`http://127.0.0.1:4937${path}`, { method }).catch((error: unknown) => {
    failure = `${(error as DOMException).name}: ${(error as DOMException).message}`;
  });
  return () => failure;
};

describe("fetchWithTimeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("gives up after 5 seconds when the headers do not arrive", async () => {
    const failure = sendUnanswered("/api/v1/setup");

    await vi.advanceTimersByTimeAsync(4999);
    expect(failure()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(failure()).toBe("TimeoutError: the controller did not answer within 5 s");
  });

  it("reads a body that takes 20 seconds to arrive, as long as it keeps arriving", async () => {
    stubFetch((signal) => Promise.resolve(new Response(buildTrickleBody(signal, 4000, 5))));
    const response = await fetchWithTimeout(SETUP_URL);
    const text = response.text();

    await vi.advanceTimersByTimeAsync(20_000);
    await expect(text).resolves.toBe("     ");
  });

  it.each([
    ["a steer", "/api/v1/sessions/s-1/inputs/i-1/steer"],
    ["a message sent to a session", "/api/v1/sessions/s-1/input"],
  ])(
    "gives %s, which waits on the runner, 2 minutes and 15 seconds for the headers",
    async (_case, path) => {
      const failure = sendUnanswered(path, "POST");

      // The controller waits up to 2 minutes and 10 seconds for an input with
      // images (`MAX_INPUT_ANSWER_WAIT_MS`); the limit sits 5 seconds above it.
      expect(MAX_INPUT_ANSWER_WAIT_MS).toBe(130_000);
      await vi.advanceTimersByTimeAsync(134_999);
      expect(failure()).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(failure()).toBe("TimeoutError: the controller did not answer within 135 s");
    },
  );

  it.each([
    ["an image's upload", "/api/v1/attachments"],
    ["a skill's import", "/api/v1/skills/import"],
  ])("gives %s 120 seconds for the headers", async (_case, path) => {
    const failure = sendUnanswered(path, "POST");

    await vi.advanceTimersByTimeAsync(119_999);
    expect(failure()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(failure()).toBe("TimeoutError: the controller did not answer within 120 s");
  });

  it("gives a slow operation's body the usual 5 seconds of silence", async () => {
    stubFetch((signal) => Promise.resolve(new Response(buildStalledBody(signal))));
    const failure = readBodyFailure(
      await fetchWithTimeout("http://127.0.0.1:4937/api/v1/attachments", { method: "POST" }),
    );

    await vi.advanceTimersByTimeAsync(5000);
    expect(failure()).toBe("TimeoutError: the controller stopped sending its answer for 5 s");
  });

  it("gives another operation on a steer's path 5 seconds", async () => {
    const failure = sendUnanswered("/api/v1/sessions/s-1/inputs/i-1", "DELETE");

    await vi.advanceTimersByTimeAsync(5000);
    expect(failure()).toBe("TimeoutError: the controller did not answer within 5 s");
  });

  it.each<[string, () => Promise<void>]>([
    [
      "the body has been read to the end",
      async () => {
        stubFetch(() => Promise.resolve(new Response('{"complete":true}')));
        const response = await fetchWithTimeout(SETUP_URL);
        expect(vi.getTimerCount()).toBe(1);
        await response.text();
      },
    ],
    [
      "the answer has no body",
      async () => {
        stubFetch(() => Promise.resolve(new Response(null, { status: 204 })));
        await fetchWithTimeout(SETUP_URL);
      },
    ],
    [
      "the request fails",
      async () => {
        stubFetch(() => Promise.reject(new TypeError("Failed to fetch")));
        await expect(fetchWithTimeout(SETUP_URL)).rejects.toThrow("Failed to fetch");
      },
    ],
    [
      "the body is cancelled",
      async () => {
        stubFetch((signal) => Promise.resolve(new Response(buildStalledBody(signal))));
        const response = await fetchWithTimeout(SETUP_URL);
        await response.body?.cancel();
      },
    ],
    [
      "the body fails",
      async () => {
        const reset = new AbortController();
        stubFetch(() => Promise.resolve(new Response(buildStalledBody(reset.signal))));
        const response = await fetchWithTimeout(SETUP_URL);
        const read = response.text();
        reset.abort();
        await expect(read).rejects.toThrow("Failed to fetch");
      },
    ],
  ])("leaves no timer once %s", async (_case, finishRequest) => {
    await finishRequest();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("createControllerClient", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("reports a login whose body stalls with the operation and the limit that ran out", async () => {
    stubFetch((signal) =>
      Promise.resolve(
        new Response(buildStalledBody(signal), {
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const client = createControllerClient("http://127.0.0.1:4937", {
      read: () => null,
      write: () => {},
    });
    let failure: unknown;
    client.auth.login({ payload: { username: "rogier", password: "secret" } }).catch((error) => {
      failure = error;
    });

    await vi.advanceTimersByTimeAsync(4999);
    expect(failure).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(failure).toBeInstanceOf(ConnectionError);
    expect((failure as ConnectionError).message).toBe(
      "auth.login: the controller stopped sending its answer for 5 s",
    );
  });

  it("returns a steer the controller answers after 8 seconds, past the usual limit", async () => {
    const inputId = "01a06d02-7700-7000-8000-000000000001";
    // Answers after 8 seconds, unless the request's signal aborts first.
    stubFetch(
      (signal) =>
        new Promise((resolve, reject) => {
          const answer = setTimeout(() => {
            resolve(
              new Response(JSON.stringify({ inputId, result: "steered" }), {
                headers: { "content-type": "application/json" },
              }),
            );
          }, 8000);
          signal.addEventListener("abort", () => {
            clearTimeout(answer);
            reject(signal.reason as Error);
          });
        }),
    );
    const client = createControllerClient("http://127.0.0.1:4937", {
      read: () => "bearer",
      write: () => {},
    });
    const steer = client.input.steer({
      params: { id: "01a06d02-7400-7000-8000-000000000001", inputId },
    });

    await vi.advanceTimersByTimeAsync(8000);
    await expect(steer).resolves.toEqual({ inputId, result: "steered" });
  });
});
