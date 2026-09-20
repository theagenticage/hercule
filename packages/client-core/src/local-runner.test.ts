/**
 * Working out which fleet runner is the one on the user's own machine.
 *
 * The question can only be answered from the browser, by asking each online
 * runner's loopback port who is there and seeing which one answers - a runner
 * on another machine is unreachable on 127.0.0.1, so silence is the normal
 * answer and not an error. That makes the failures the interesting half: a
 * fleet where nothing answers, a port that hangs, and an answer naming a
 * runner the fleet does not list online, all of which mean "no local runner"
 * rather than a guess. Detection is a convenience, so a wrong answer would be
 * worse than none.
 *
 * The fetch is handed in, so every one of those is pressed here rather than
 * waited for.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Runner, RunnerFacts } from "@hercule/contract";
import { detectLocalRunner, type FetchLike } from "./index";
import { IDENTITY_TIMEOUT_MS } from "./local-runner";

const facts = (identityPort: number): RunnerFacts => ({
  os: "darwin",
  arch: "arm64",
  totalMemoryBytes: 64 * 1024 * 1024 * 1024,
  docker: true,
  toolchains: [],
  providers: [],
  adapters: ["claude-code"],
  identityPort,
});

const runner = (
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
  facts: facts(identityPort),
  watermark: null,
  maxConcurrentSessions: 4,
  diskWatermarkBytes: 10 * 1024 * 1024 * 1024,
  lastSeenAt: null,
});

/** Two runners: one on the default port, one on a port it fell back to. */
const HERE = runner("r_here", 4939);
const THERE = runner("r_there", 5000);

const identityOf = (id: string): Response =>
  new Response(JSON.stringify({ runnerId: id }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

/**
 * A fetch that answers per port. A port with no answer behind it rejects, the
 * way a browser reports a connection nothing is listening on.
 */
const fleetFetch = (
  answers: Readonly<Record<number, Response | "refuse" | "hang">>,
): { readonly fetch: FetchLike; readonly asked: ReadonlyArray<string> } => {
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
  return { fetch, asked };
};

/** Short enough that the timeout cases cost nothing. */
const QUICK = 20;

afterEach(() => {
  vi.useRealTimers();
});

describe("finding the runner on this machine", () => {
  it("returns the id that came back from a listed online runner's port", async () => {
    const { fetch, asked } = fleetFetch({ 4939: "refuse", 5000: identityOf(THERE.id) });

    const found = await detectLocalRunner([HERE, THERE], fetch, QUICK);

    expect(found).toBe(THERE.id);
    // Loopback, every time: the browser must never leave the machine to ask.
    expect([...asked].sort()).toEqual([
      "http://127.0.0.1:4939/identity",
      "http://127.0.0.1:5000/identity",
    ]);
  });

  it("does not let one refused port hide the runner behind another", async () => {
    // The mirror of the case above: the answer arrives on the other port.
    const { fetch } = fleetFetch({ 4939: identityOf(HERE.id), 5000: "refuse" });

    expect(await detectLocalRunner([HERE, THERE], fetch, QUICK)).toBe(HERE.id);
  });

  it("does not let one hanging port hide the runner behind another", async () => {
    const { fetch } = fleetFetch({ 4939: "hang", 5000: identityOf(THERE.id) });

    expect(await detectLocalRunner([HERE, THERE], fetch, QUICK)).toBe(THERE.id);
  });
});

describe("when there is no answer to trust", () => {
  it("returns null when nothing answers", async () => {
    const { fetch, asked } = fleetFetch({ 4939: "refuse", 5000: "refuse" });

    expect(await detectLocalRunner([HERE, THERE], fetch, QUICK)).toBe(null);
    expect(asked).toHaveLength(2);
  });

  it("returns null when every answer times out", async () => {
    const { fetch } = fleetFetch({ 4939: "hang", 5000: "hang" });

    expect(await detectLocalRunner([HERE, THERE], fetch, QUICK)).toBe(null);
  });

  it("waits IDENTITY_TIMEOUT_MS for an answer when no timeout is given", async () => {
    vi.useFakeTimers();
    const { fetch } = fleetFetch({ 4939: "hang", 5000: "hang" });

    const detection = detectLocalRunner([HERE, THERE], fetch);
    await vi.advanceTimersByTimeAsync(IDENTITY_TIMEOUT_MS);

    expect(IDENTITY_TIMEOUT_MS).toBeGreaterThan(0);
    expect(await detection).toBe(null);
  });

  it("returns null when the answer names a runner the fleet does not have", async () => {
    const { fetch } = fleetFetch({ 4939: identityOf("r_stranger"), 5000: "refuse" });

    expect(await detectLocalRunner([HERE, THERE], fetch, QUICK)).toBe(null);
  });

  it("returns null when the answer names a runner that is not online", async () => {
    const offline = runner("r_offline", 4939, "offline");
    const { fetch } = fleetFetch({ 4939: identityOf(offline.id), 5000: "refuse" });

    // The machine has a runner on it, but it is not one work can be placed on,
    // so "local" has nothing to resolve to.
    expect(await detectLocalRunner([offline, THERE], fetch, QUICK)).toBe(null);
  });
});

describe("what it will not take for an answer", () => {
  it("does not believe a port that names a runner other than the one that reported it", async () => {
    // Two machines with runners, and something on this one's port answering
    // with the other's id. Believing it would place the user's next session on
    // a machine they are not sitting at.
    const { fetch } = fleetFetch({ 4939: identityOf(THERE.id), 5000: "refuse" });

    expect(await detectLocalRunner([HERE, THERE], fetch, QUICK)).toBe(null);
  });

  it("does not read a refusal as an answer", async () => {
    const { fetch } = fleetFetch({
      4939: new Response("no", { status: 500 }),
      5000: "refuse",
    });

    expect(await detectLocalRunner([HERE, THERE], fetch, QUICK)).toBe(null);
  });

  it("does not read something that is not a runner as an answer", async () => {
    // 4939 is an ordinary port number; anything at all may be sitting on it.
    const { fetch } = fleetFetch({
      4939: new Response(JSON.stringify({ version: "2.1" }), { status: 200 }),
      5000: "refuse",
    });

    expect(await detectLocalRunner([HERE, THERE], fetch, QUICK)).toBe(null);
  });

  it("asks nothing of a runner that has reported no port", async () => {
    const silent: Runner = { ...HERE, facts: null };
    const { fetch, asked } = fleetFetch({ 5000: identityOf(THERE.id) });

    expect(await detectLocalRunner([silent, THERE], fetch, QUICK)).toBe(THERE.id);
    expect(asked).toEqual(["http://127.0.0.1:5000/identity"]);
  });
});
