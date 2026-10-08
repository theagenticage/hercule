import { ConnectionError } from "@hercule/client-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createControllerClient, fetchWithTimeout } from "./controller-client";

const SETUP_URL = "http://127.0.0.1:4937/api/v1/setup";

/**
 * Returns a body that sends its first byte and then nothing more. Like the
 * body of a real fetch, it fails with the signal's reason when `signal`
 * aborts.
 */
const buildStalledBody = (signal: AbortSignal): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("{"));
      signal.addEventListener(
        "abort",
        () => {
          controller.error(signal.reason);
        },
        { once: true },
      );
    },
  });

/** Stubs the global `fetch` with `answer`, which receives the request's signal. */
const stubFetch = (answer: (signal: AbortSignal) => Promise<Response>): void => {
  vi.stubGlobal("fetch", (_url: string, init: RequestInit) => answer(init.signal as AbortSignal));
};

describe("fetchWithTimeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("gives up after 5 seconds on an answer whose body stalls after the headers", async () => {
    stubFetch((signal) => Promise.resolve(new Response(buildStalledBody(signal))));
    const response = await fetchWithTimeout(SETUP_URL);
    let failure: string | undefined;
    response.text().catch((error: unknown) => {
      failure = (error as DOMException).name;
    });

    await vi.advanceTimersByTimeAsync(4999);
    expect(failure).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(failure).toBe("TimeoutError");
  });

  it.each([
    ["a steer", "/api/v1/sessions/s-1/inputs/i-1/steer"],
    ["a message sent to a session", "/api/v1/sessions/s-1/input"],
  ])("gives %s, which waits on the runner, 15 seconds", async (_case, path) => {
    stubFetch((signal) => Promise.resolve(new Response(buildStalledBody(signal))));
    const response = await fetchWithTimeout(`http://127.0.0.1:4937${path}`, { method: "POST" });
    let failure: string | undefined;
    response.text().catch((error: unknown) => {
      failure = (error as DOMException).name;
    });

    await vi.advanceTimersByTimeAsync(14_999);
    expect(failure).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(failure).toBe("TimeoutError");
  });

  it.each([
    ["an image's upload", "POST", "/api/v1/attachments"],
    ["an image's download", "GET", "/api/v1/attachments/a-1/content"],
  ])("gives %s 120 seconds", async (_case, method, path) => {
    stubFetch((signal) => Promise.resolve(new Response(buildStalledBody(signal))));
    const response = await fetchWithTimeout(`http://127.0.0.1:4937${path}`, { method });
    let failure: string | undefined;
    response.text().catch((error: unknown) => {
      failure = (error as DOMException).name;
    });

    await vi.advanceTimersByTimeAsync(119_999);
    expect(failure).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(failure).toBe("TimeoutError");
  });

  it("gives another operation on a steer's path 5 seconds", async () => {
    stubFetch((signal) => Promise.resolve(new Response(buildStalledBody(signal))));
    const response = await fetchWithTimeout(
      "http://127.0.0.1:4937/api/v1/sessions/s-1/inputs/i-1",
      { method: "DELETE" },
    );
    let failure: string | undefined;
    response.text().catch((error: unknown) => {
      failure = (error as DOMException).name;
    });

    await vi.advanceTimersByTimeAsync(5000);
    expect(failure).toBe("TimeoutError");
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
        reset.abort(new TypeError("network error"));
        await expect(read).rejects.toThrow("network error");
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

  it("reports a login whose body stalls as a controller it cannot reach", async () => {
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
    expect((failure as ConnectionError).message).toBe("cannot reach http://127.0.0.1:4937");
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
