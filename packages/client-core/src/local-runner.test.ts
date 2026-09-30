/**
 * Tests detecting which runner in the fleet runs on the user's own machine.
 *
 * Only the browser can detect this, by asking each online runner's loopback
 * port which runner is listening. A runner on another machine cannot be
 * reached on 127.0.0.1, so no response is the normal case, not an error. So
 * the failure cases matter most. Each of these means "no local runner" rather
 * than a guess:
 *
 * - no port responds;
 * - a port hangs;
 * - a response names a runner that is not listed as online.
 *
 * Detection is a convenience, so a wrong result would be worse than none. The
 * tests pass in the fetch, so each case is triggered directly rather than
 * waited for.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Runner, RunnerFacts } from "@hercule/contract";
import {
  buildFetchIdentityProbe,
  detectLocalRunner,
  queryKeys,
  type FetchLike,
  type IdentityProbe,
} from "./index";
import { IDENTITY_TIMEOUT_MS } from "./local-runner";

const buildFacts = (identityPort: number): RunnerFacts => ({
  os: "darwin",
  arch: "arm64",
  totalMemoryBytes: 64 * 1024 * 1024 * 1024,
  docker: true,
  toolchains: [],
  providers: [],
  adapters: ["claude-code"],
  identityPort,
});

const buildRunner = (
  id: string,
  identityPort: number,
  connectivity: Runner["connectivity"] = "online",
): Runner => ({
  id,
  name: id,
  connectivity,
  lifecycle: "active",
  reserved: false,
  version: "1.0.0",
  labels: [],
  facts: buildFacts(identityPort),
  watermark: null,
  maxConcurrentSessions: 4,
  diskWatermarkBytes: 10 * 1024 * 1024 * 1024,
  lastSeenAt: null,
});

/** Two runners: one on the default port, and one on the fallback port it chose. */
const HERE = buildRunner("r_here", 4939);
const THERE = buildRunner("r_there", 5000);

const buildIdentityResponse = (id: string): Response =>
  new Response(JSON.stringify({ runnerId: id }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

/**
 * Returns a probe that asks with a fetch with one response per port, and the
 * URLs that fetch was asked for. A port with no response set rejects, the way
 * a browser reports a port nothing is listening on.
 */
const stubFleetFetch = (
  answers: Readonly<Record<number, Response | "refuse" | "hang">>,
): { readonly probe: IdentityProbe; readonly asked: ReadonlyArray<string> } => {
  const asked: Array<string> = [];
  const fetch: FetchLike = (url) => {
    asked.push(url);
    const port = Number(new URL(url).port);
    const answer = answers[port];
    if (answer === undefined || answer === "refuse")
      return Promise.reject(new TypeError("Failed to fetch"));
    if (answer === "hang") return new Promise<Response>(() => {});
    return Promise.resolve(answer);
  };
  return { probe: buildFetchIdentityProbe(fetch), asked };
};

/** A timeout short enough that the timeout cases run quickly. */
const QUICK = 20;

afterEach(() => {
  vi.useRealTimers();
});

describe("detectLocalRunner", () => {
  it("returns the id that an online runner's port responds with", async () => {
    const { probe, asked } = stubFleetFetch({
      4939: "refuse",
      5000: buildIdentityResponse(THERE.id),
    });

    const found = await detectLocalRunner([HERE, THERE], probe, QUICK);

    expect(found).toBe(THERE.id);
    // Always loopback: the browser must never ask another machine.
    expect([...asked].sort()).toEqual([
      "http://127.0.0.1:4939/identity",
      "http://127.0.0.1:5000/identity",
    ]);
  });

  it("asks a port once, and finds the runner among those that report it", async () => {
    const elsewhere = buildRunner("r_elsewhere", 4939);
    const { probe, asked } = stubFleetFetch({ 4939: buildIdentityResponse(HERE.id) });

    expect(await detectLocalRunner([elsewhere, HERE], probe, QUICK)).toBe(HERE.id);
    expect(asked).toEqual(["http://127.0.0.1:4939/identity"]);
  });

  it("still finds the runner on one port when another port rejects", async () => {
    // The reverse of the case above: the response comes from the other port.
    const { probe } = stubFleetFetch({ 4939: buildIdentityResponse(HERE.id), 5000: "refuse" });

    expect(await detectLocalRunner([HERE, THERE], probe, QUICK)).toBe(HERE.id);
  });

  it("still finds the runner on one port when another port hangs", async () => {
    const { probe } = stubFleetFetch({ 4939: "hang", 5000: buildIdentityResponse(THERE.id) });

    expect(await detectLocalRunner([HERE, THERE], probe, QUICK)).toBe(THERE.id);
  });
});

describe("detectLocalRunner with no trustworthy response", () => {
  it("returns null when two runners each answer on their own port", async () => {
    // Both runners are on this machine, so either could be the one the user
    // means, and a wrong pick is worse than none.
    const { probe } = stubFleetFetch({
      4939: buildIdentityResponse(HERE.id),
      5000: buildIdentityResponse(THERE.id),
    });

    expect(await detectLocalRunner([HERE, THERE], probe, QUICK)).toBe(null);
  });

  it("returns null when no port responds", async () => {
    const { probe, asked } = stubFleetFetch({ 4939: "refuse", 5000: "refuse" });

    expect(await detectLocalRunner([HERE, THERE], probe, QUICK)).toBe(null);
    expect(asked).toHaveLength(2);
  });

  it("returns null when every request times out", async () => {
    const { probe } = stubFleetFetch({ 4939: "hang", 5000: "hang" });

    expect(await detectLocalRunner([HERE, THERE], probe, QUICK)).toBe(null);
  });

  it("waits IDENTITY_TIMEOUT_MS for a response when no timeout is given", async () => {
    vi.useFakeTimers();
    const { probe } = stubFleetFetch({ 4939: "hang", 5000: "hang" });

    const detection = detectLocalRunner([HERE, THERE], probe);
    await vi.advanceTimersByTimeAsync(IDENTITY_TIMEOUT_MS);

    expect(IDENTITY_TIMEOUT_MS).toBeGreaterThan(0);
    expect(await detection).toBe(null);
  });

  it("returns null when the response names a runner that is not in the fleet", async () => {
    const { probe } = stubFleetFetch({ 4939: buildIdentityResponse("r_stranger"), 5000: "refuse" });

    expect(await detectLocalRunner([HERE, THERE], probe, QUICK)).toBe(null);
  });

  it("returns null when the response names a runner that is not online", async () => {
    const offline = buildRunner("r_offline", 4939, "offline");
    const { probe } = stubFleetFetch({ 4939: buildIdentityResponse(offline.id), 5000: "refuse" });

    // The machine has a runner, but no work can be placed on it, so there is
    // no usable local runner.
    expect(await detectLocalRunner([offline, THERE], probe, QUICK)).toBe(null);
  });
});

describe("detectLocalRunner with an untrustworthy response", () => {
  it("rejects a port that responds with a different runner's id", async () => {
    // Two machines with runners, and something on this machine's port
    // responds with the other runner's id. Trusting it would place the user's
    // next session on a machine they are not using.
    const { probe } = stubFleetFetch({ 4939: buildIdentityResponse(THERE.id), 5000: "refuse" });

    expect(await detectLocalRunner([HERE, THERE], probe, QUICK)).toBe(null);
  });

  it("rejects an error response", async () => {
    const { probe } = stubFleetFetch({
      4939: new Response("no", { status: 500 }),
      5000: "refuse",
    });

    expect(await detectLocalRunner([HERE, THERE], probe, QUICK)).toBe(null);
  });

  it("rejects a response that is not from a runner", async () => {
    // 4939 is an ordinary port number; any program may be listening on it.
    const { probe } = stubFleetFetch({
      4939: new Response(JSON.stringify({ version: "2.1" }), { status: 200 }),
      5000: "refuse",
    });

    expect(await detectLocalRunner([HERE, THERE], probe, QUICK)).toBe(null);
  });

  it("does not call a runner that has reported no port", async () => {
    const silent: Runner = { ...HERE, facts: null };
    const { probe, asked } = stubFleetFetch({ 5000: buildIdentityResponse(THERE.id) });

    expect(await detectLocalRunner([silent, THERE], probe, QUICK)).toBe(THERE.id);
    expect(asked).toEqual(["http://127.0.0.1:5000/identity"]);
  });
});

describe("queryKeys.localRunner", () => {
  it("changes only when an online runner's endpoint changes", () => {
    const key = queryKeys.localRunner([HERE, THERE]);

    // The live connection reads the runners again on every push. A runner
    // read again with other facts, or an offline one, must not run detection
    // again.
    expect(queryKeys.localRunner([{ ...HERE, lastSeenAt: "2026-09-30T10:00:00Z" }, THERE])).toEqual(
      key,
    );
    expect(queryKeys.localRunner([HERE, THERE, buildRunner("r_off", 6000, "offline")])).toEqual(
      key,
    );
    expect(queryKeys.localRunner([HERE, buildRunner("r_there", 5001)])).not.toEqual(key);
    expect(queryKeys.localRunner([HERE])).not.toEqual(key);
  });
});
