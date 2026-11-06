/**
 * Tests the controller's telemetry layer on its own: where traces are posted,
 * and that a collector which stops answering cannot make the controller hold
 * export requests without bound. What the spans hold is tested end to end, in
 * `e2e/telemetry.test.ts`.
 */
import { afterEach, describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { buildTracesUrl, makeTelemetryLayer } from "./telemetry";

describe("buildTracesUrl", () => {
  it.each([
    ["http://collector:4318", "http://collector:4318/v1/traces"],
    ["http://collector:4318/", "http://collector:4318/v1/traces"],
    ["https://otlp.example.com/otlp/", "https://otlp.example.com/otlp/v1/traces"],
    ["http://collector:4318#", "http://collector:4318/v1/traces"],
    ["http://collector:4318?", "http://collector:4318/v1/traces"],
    [" http://collector:4318 ", "http://collector:4318/v1/traces"],
  ])("posts the traces of %j to %s", (endpoint, url) => {
    expect(buildTracesUrl(endpoint)).toBe(url);
  });
});

describe("a collector that stops answering", () => {
  let collector: ReturnType<typeof Bun.serve> | undefined;

  afterEach(async () => {
    await collector?.stop(true);
    collector = undefined;
  });

  /**
   * Starts a collector that answers each export request with `answer`, which
   * never finishes, and returns its endpoint and the number of export
   * requests it has received so far.
   */
  const startStalledCollector = (answer: () => Promise<Response> | Response) => {
    let received = 0;
    collector = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      idleTimeout: 0,
      fetch: () => {
        received += 1;
        return answer();
      },
    });
    return { endpoint: `http://127.0.0.1:${String(collector.port)}`, received: () => received };
  };

  /**
   * Ends 10,000 spans under the telemetry layer, which makes Effect's exporter
   * start ten export requests at once, and waits briefly for them to reach the
   * collector.
   */
  const endManySpans = (endpoint: string) =>
    Effect.runPromise(
      Effect.gen(function* () {
        for (let index = 0; index < 10_000; index += 1) {
          yield* Effect.withSpan(Effect.void, "work");
        }
        yield* Effect.sleep("500 millis");
      }).pipe(Effect.provide(makeTelemetryLayer(endpoint))),
    );

  it.each([
    ["sends no answer", () => new Promise<Response>(() => {})],
    [
      "sends its headers and one byte, then stalls",
      () =>
        new Response(
          new ReadableStream({
            start: (controller) => controller.enqueue(new Uint8Array([123])),
          }),
          { headers: { "content-type": "application/json" } },
        ),
    ],
  ])(
    "that %s receives at most four export requests at once",
    async (_, answer) => {
      const stalled = startStalledCollector(answer);
      await endManySpans(stalled.endpoint);
      expect(stalled.received()).toBeGreaterThan(0);
      expect(stalled.received()).toBeLessThanOrEqual(4);
    },
    20_000,
  );
});
