import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Connection } from "@hercule/contract";
import { buildErrorBody, createApiStub, type Answer, type Handler } from "./api-stub";
import { createClient } from "./client";
import {
  decideDeviceFlowStep,
  describeDeviceFlowWait,
  DEVICE_CODE_EXPIRED,
  describeSignInEnding,
  describeSignInFailure,
  waitForDeviceFlow,
  type DeviceFlowStep,
} from "./connection-device-flow";
import { readErrorMessage } from "./errors";

describe("decideDeviceFlowStep", () => {
  const deviceStart = {
    setupId: "s-1",
    userCode: "WDJB-MJHT",
    verificationUri: "https://example.test/device",
    expiresAt: "2026-10-02T12:15:00.000Z",
    interval: 5,
  };
  // Five minutes before the code expires.
  const NOW = Date.parse("2026-10-02T12:10:00.000Z");

  it("waits the start's interval before the first poll", () => {
    expect(decideDeviceFlowStep(deviceStart, undefined, NOW)).toEqual({
      kind: "waiting",
      status: "pending",
      delay: 5000,
    });
  });

  it("waits the interval the last reply returned while the flow is open", () => {
    expect(decideDeviceFlowStep(deviceStart, { status: "pending", interval: 5 }, NOW)).toEqual({
      kind: "waiting",
      status: "pending",
      delay: 5000,
    });
    expect(decideDeviceFlowStep(deviceStart, { status: "slow-down", interval: 10 }, NOW)).toEqual({
      kind: "waiting",
      status: "slow-down",
      delay: 10_000,
    });
    expect(decideDeviceFlowStep(deviceStart, { status: "unreachable", interval: 5 }, NOW)).toEqual({
      kind: "waiting",
      status: "unreachable",
      delay: 5000,
    });
  });

  it("ends the flow with the controller's reason", () => {
    for (const status of ["expired", "denied", "failed"] as const) {
      const message = "the code expired before it was approved";
      expect(decideDeviceFlowStep(deviceStart, { status, message }, NOW)).toEqual({
        kind: "ended",
        status,
        message,
      });
    }
  });

  it("never waits past the moment the code expires", () => {
    const threeSecondsLeft = Date.parse(deviceStart.expiresAt) - 3000;
    expect(decideDeviceFlowStep(deviceStart, undefined, threeSecondsLeft)).toEqual({
      kind: "waiting",
      status: "pending",
      delay: 3000,
    });
    expect(
      decideDeviceFlowStep(deviceStart, { status: "slow-down", interval: 10 }, threeSecondsLeft),
    ).toEqual({ kind: "waiting", status: "slow-down", delay: 3000 });
  });

  it("ends the flow as expired once the code's expiry has passed, whatever the last reply", () => {
    const expiry = Date.parse(deviceStart.expiresAt);
    const ending = { kind: "ended", status: "expired", message: DEVICE_CODE_EXPIRED };
    expect(decideDeviceFlowStep(deviceStart, undefined, expiry)).toEqual(ending);
    for (const status of ["pending", "slow-down", "unreachable"] as const) {
      expect(decideDeviceFlowStep(deviceStart, { status, interval: 5 }, expiry + 1)).toEqual(
        ending,
      );
    }
  });

  it("still returns a reply that ended the flow after the code's expiry", () => {
    const connection = {} as Connection;
    const late = Date.parse(deviceStart.expiresAt) + 60_000;
    expect(decideDeviceFlowStep(deviceStart, { status: "done", connection }, late)).toEqual({
      kind: "done",
      connection,
    });
  });

  it("returns the new connection once the flow is done", () => {
    // The connection is passed through untouched, so any record will do.
    const connection = {} as Connection;
    expect(decideDeviceFlowStep(deviceStart, { status: "done", connection }, NOW)).toEqual({
      kind: "done",
      connection,
    });
  });
});

describe("describeDeviceFlowWait", () => {
  it("names the provider while the flow waits, and says a failed check is retried", () => {
    expect(describeDeviceFlowWait("pending", "GitHub")).toBe(
      "Waiting for you to approve Hercule on GitHub.",
    );
    expect(describeDeviceFlowWait("slow-down", "GitHub")).toBe(
      "GitHub asked for slower checks. Still waiting for you to approve the code.",
    );
    expect(describeDeviceFlowWait("unreachable", "GitHub")).toBe(
      "Cannot reach GitHub right now. Still trying.",
    );
    expect(describeDeviceFlowWait("request-failed", "GitHub")).toBe(
      "The last check did not go through. Still trying.",
    );
  });
});

describe("waitForDeviceFlow", () => {
  const POLL = "POST /api/v1/oauth/device/poll";
  const DEVICE_START = {
    setupId: "s-1",
    userCode: "WDJB-MJHT",
    verificationUri: "https://example.test/device",
    expiresAt: "2026-10-02T12:15:00.000Z",
    interval: 5,
  };
  const CONNECTION = {
    id: "0199c0ff-aaaa-7000-8000-000000000001",
    type: "github/github",
    label: "octocat",
    displayName: "octocat",
    status: "connected",
    labels: [],
    config: {},
    feedIntervals: {},
    credentials: [],
    createdAt: "2026-10-02T08:15:00.000Z",
    updatedAt: "2026-10-02T08:15:00.000Z",
  } satisfies Connection;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    // Fifteen minutes before the code expires.
    vi.setSystemTime("2026-10-02T12:00:00.000Z");
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Returns a handler that answers each poll with the next answer, then repeats the last. */
  const answerPolls = (...answers: readonly Answer[]): Handler => {
    let index = 0;
    return () => answers[Math.min(index++, answers.length - 1)]!;
  };

  /** Starts the wait on a stub controller, and records what it reports. */
  const startWait = (poll: Handler, deviceStart = DEVICE_START) => {
    const api = createApiStub({ [POLL]: poll });
    const client = createClient({ baseUrl: "http://127.0.0.1:4937", fetch: api.fetch });
    const stop = new AbortController();
    const steps: DeviceFlowStep[] = [];
    const failures: unknown[] = [];
    const last = waitForDeviceFlow(client, deviceStart, {
      signal: stop.signal,
      onStep: (step) => steps.push(step),
      onRequestFailure: (error) => failures.push(error),
    });
    const countPolls = () => api.calls.length;
    return { stop, steps, failures, last, countPolls };
  };

  it("polls at the start's interval, then at each reply's, until the flow is done", async () => {
    const wait = startWait(
      answerPolls(
        { body: { status: "pending", interval: 5 } },
        { body: { status: "slow-down", interval: 10 } },
        { body: { status: "done", connection: CONNECTION } },
      ),
    );

    await vi.advanceTimersByTimeAsync(4999);
    expect(wait.countPolls()).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(wait.countPolls()).toBe(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(wait.countPolls()).toBe(2);
    // The slow-down reply asked for ten seconds.
    await vi.advanceTimersByTimeAsync(9999);
    expect(wait.countPolls()).toBe(2);
    await vi.advanceTimersByTimeAsync(1);

    expect(await wait.last).toEqual({ kind: "done", connection: CONNECTION });
    expect(wait.steps.map((step) => step.kind)).toEqual(["waiting", "waiting", "done"]);
    expect(wait.countPolls()).toBe(3);
  });

  it("stops at the first reply that ends the flow", async () => {
    const message = "the code expired before it was approved";
    const wait = startWait(answerPolls({ body: { status: "expired", message } }));

    await vi.advanceTimersByTimeAsync(5000);

    expect(await wait.last).toEqual({ kind: "ended", status: "expired", message });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(wait.countPolls()).toBe(1);
  });

  it("keeps polling at the last interval after a poll request fails", async () => {
    const wait = startWait(
      answerPolls(
        { body: { status: "slow-down", interval: 10 } },
        { status: 500, body: buildErrorBody("internal", "the database is locked") },
        { body: { status: "done", connection: CONNECTION } },
      ),
    );

    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(wait.countPolls()).toBe(2);
    expect(wait.failures).toHaveLength(1);
    expect(readErrorMessage(wait.failures[0])).toBe("the database is locked");

    await vi.advanceTimersByTimeAsync(9999);
    expect(wait.countPolls()).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect((await wait.last).kind).toBe("done");
  });

  it("ends as expired when the code expires, without another poll", async () => {
    // The code expires 12 seconds from now: polls go out at 5 and 10 seconds.
    const wait = startWait(answerPolls({ body: { status: "pending", interval: 5 } }), {
      ...DEVICE_START,
      expiresAt: "2026-10-02T12:00:12.000Z",
    });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(wait.countPolls()).toBe(2);
    await vi.advanceTimersByTimeAsync(2000);

    const ending = { kind: "ended", status: "expired", message: DEVICE_CODE_EXPIRED };
    expect(await wait.last).toEqual(ending);
    expect(wait.steps.at(-1)).toEqual(ending);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(wait.countPolls()).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ends as expired when the code expires after a poll request failed", async () => {
    const wait = startWait(
      answerPolls(
        { body: { status: "pending", interval: 5 } },
        { status: 500, body: buildErrorBody("internal", "the database is locked") },
      ),
      { ...DEVICE_START, expiresAt: "2026-10-02T12:00:12.000Z" },
    );

    await vi.advanceTimersByTimeAsync(10_000);
    expect(wait.failures).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2000);

    expect(await wait.last).toMatchObject({ kind: "ended", status: "expired" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(wait.countPolls()).toBe(2);
  });

  it("reports a code that has expired already as expired, and never polls", async () => {
    const wait = startWait(answerPolls({ body: { status: "pending", interval: 5 } }), {
      ...DEVICE_START,
      expiresAt: "2026-10-02T11:59:00.000Z",
    });

    const ending = { kind: "ended", status: "expired", message: DEVICE_CODE_EXPIRED };
    expect(await wait.last).toEqual(ending);
    expect(wait.steps).toEqual([ending]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(wait.countPolls()).toBe(0);
  });

  it("stops polling and leaves no timer once the signal aborts", async () => {
    const wait = startWait(answerPolls({ body: { status: "pending", interval: 5 } }));

    wait.stop.abort();

    expect(await wait.last).toEqual({ kind: "waiting", status: "pending", delay: 5000 });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(wait.countPolls()).toBe(0);
  });

  it("reports no reply that arrives after the signal aborted, but returns it", async () => {
    let answer: (reply: Answer) => void = () => undefined;
    const wait = startWait(
      () =>
        new Promise<Answer>((resolve) => {
          answer = resolve;
        }),
    );
    await vi.advanceTimersByTimeAsync(5000);
    expect(wait.countPolls()).toBe(1);

    wait.stop.abort();
    answer({ body: { status: "done", connection: CONNECTION } });

    expect(await wait.last).toEqual({ kind: "done", connection: CONNECTION });
    expect(wait.steps).toEqual([]);
  });
});

describe("describeSignInEnding", () => {
  it("says how long a code lasts when it expired", () => {
    expect(
      describeSignInEnding({ kind: "ended", status: "expired", message: "" }, 15, "GitHub"),
    ).toEqual({
      kind: "ended",
      status: "expired",
      line: "The sign-in expired before it was approved.",
      next: "A code lasts 15 minutes. Start again for a new one.",
    });
  });

  it("says where the sign-in was declined", () => {
    expect(
      describeSignInEnding({ kind: "ended", status: "denied", message: "" }, 15, "GitHub").next,
    ).toBe("Hercule was declined on GitHub’s approval page. Start again if that was a mistake.");
  });

  it("passes on the controller's message when the sign-in failed", () => {
    expect(
      describeSignInEnding(
        { kind: "ended", status: "failed", message: "GitHub could not be reached." },
        15,
        "GitHub",
      ),
    ).toEqual(describeSignInFailure("GitHub could not be reached."));
  });
});

describe("describeSignInFailure", () => {
  it("says nothing changed, then gives the controller's reason", () => {
    expect(describeSignInFailure("GitHub could not be reached.")).toEqual({
      kind: "ended",
      status: "failed",
      line: "The sign-in did not finish, so nothing changed.",
      next: "GitHub could not be reached.",
    });
  });
});
