/**
 * Tests when the runner serves its copy of a GitHub token and when it asks the
 * controller instead. What matters:
 *
 * - a copy is trusted for 5 minutes, and never when it expires within 10;
 * - a deleted or disconnected Connection stops reaching its sessions: a
 *   refusal drops the copy, and so does releasing the last session;
 * - a controller that cannot be reached never hides an unexpired token, and
 *   never serves an expired one.
 */
import { describe, expect, it } from "vitest";
import type { GithubTokenAnswer } from "@hercule/protocol";
import { makeGithubTokenCopies } from "./github-tokens";

/** What a test has the controller answer: a token, or a reason there is none. */
type Reply = { readonly token: string; readonly expiresAt?: string } | { readonly reason: string };

const MINUTE = 60 * 1000;
const START = Date.parse("2026-10-26T10:00:00.000Z");

const isoAfter = (minutes: number): string => new Date(START + minutes * MINUTE).toISOString();

/** A runner with a controllable clock and a controller whose answers the test decides. */
const setUp = () => {
  let time = START;
  const asked: Array<string> = [];
  const waiting: Array<{
    resolve: (answer: GithubTokenAnswer) => void;
    reject: (why: Error) => void;
  }> = [];
  const tokens = makeGithubTokenCopies({
    now: () => time,
    ask: (sessionToken) => {
      asked.push(sessionToken);
      return new Promise((resolve, reject) => {
        waiting.push({ resolve, reject });
      });
    },
  });
  return {
    tokens,
    asked,
    advance: (minutes: number) => {
      time += minutes * MINUTE;
    },
    /** Lets the next pending ask of the controller answer. */
    answer: (reply: Reply) =>
      waiting.shift()!.resolve({ _tag: "githubTokenAnswer", requestId: "request-1", ...reply }),
    failToAnswer: () => waiting.shift()!.reject(new Error("no controller connection")),
  };
};

const startSession = (
  runner: ReturnType<typeof setUp>,
  overrides: Partial<{
    sessionToken: string;
    connectionId: string;
    githubToken: string;
    expiresAt: string;
  }> = {},
) =>
  runner.tokens.hold({
    sessionToken: "session-1",
    connectionId: "connection-1",
    githubToken: "start-token",
    ...overrides,
  });

describe("serving the copy", () => {
  it("serves a fresh copy without asking the controller", async () => {
    const runner = setUp();
    startSession(runner, { expiresAt: isoAfter(8 * 60) });
    runner.advance(4);

    expect(await runner.tokens.read("session-1")).toEqual({ token: "start-token" });
    expect(runner.asked).toEqual([]);
  });

  it("asks again once the copy is 5 minutes old", async () => {
    const runner = setUp();
    startSession(runner);
    runner.advance(5);

    const read = runner.tokens.read("session-1");
    expect(runner.asked).toEqual(["session-1"]);
    runner.answer({ token: "second-token" });
    expect(await read).toEqual({ token: "second-token" });

    // The answer is the new copy, so the next read is served from it.
    expect(await runner.tokens.read("session-1")).toEqual({ token: "second-token" });
    expect(runner.asked).toHaveLength(1);
  });

  it("asks when the copy expires within 10 minutes, even though it is new", async () => {
    const runner = setUp();
    startSession(runner, { expiresAt: isoAfter(10) });

    const read = runner.tokens.read("session-1");
    expect(runner.asked).toEqual(["session-1"]);
    runner.answer({ token: "refreshed", expiresAt: isoAfter(8 * 60) });
    expect(await read).toEqual({ token: "refreshed" });
  });

  it("keeps the expiry of an answer, so the next copy is judged by it", async () => {
    const runner = setUp();
    startSession(runner);
    runner.advance(5);
    const read = runner.tokens.read("session-1");
    runner.answer({ token: "short-lived", expiresAt: isoAfter(5 + 12) });
    await read;

    runner.advance(3);
    // Still 9 minutes from its expiry: inside the margin, so it is asked for again.
    void runner.tokens.read("session-1");
    expect(runner.asked).toHaveLength(2);
  });

  it("shares one ask between concurrent reads of the same Connection", async () => {
    const runner = setUp();
    startSession(runner);
    runner.tokens.hold({
      sessionToken: "session-2",
      connectionId: "connection-1",
      githubToken: "start-token",
    });
    runner.advance(6);

    const first = runner.tokens.read("session-1");
    const second = runner.tokens.read("session-2");
    runner.answer({ token: "shared" });

    expect(await first).toEqual({ token: "shared" });
    expect(await second).toEqual({ token: "shared" });
    expect(runner.asked).toHaveLength(1);
  });

  it("asks the controller for a session held without a start token", async () => {
    const runner = setUp();
    runner.tokens.hold({ sessionToken: "session-1", connectionId: "connection-1" });

    const read = runner.tokens.read("session-1");
    expect(runner.asked).toEqual(["session-1"]);
    runner.answer({ token: "asked-token" });
    expect(await read).toEqual({ token: "asked-token" });
  });

  it("does not let a session held without a start token drop the copy another session seeded", async () => {
    const runner = setUp();
    startSession(runner, { expiresAt: isoAfter(8 * 60) });
    runner.tokens.hold({ sessionToken: "session-2", connectionId: "connection-1" });

    expect(await runner.tokens.read("session-2")).toEqual({ token: "start-token" });
    expect(runner.asked).toEqual([]);
  });

  it("asks separately for separate Connections", () => {
    const runner = setUp();
    startSession(runner);
    startSession(runner, { sessionToken: "session-2", connectionId: "connection-2" });
    runner.advance(6);

    void runner.tokens.read("session-1");
    void runner.tokens.read("session-2");

    expect(runner.asked).toEqual(["session-1", "session-2"]);
  });

  it("replaces the copy with a start token that expires later, for every session of the Connection", async () => {
    const runner = setUp();
    startSession(runner, { expiresAt: isoAfter(60) });
    runner.advance(4);
    // The controller refreshed the token between the two starts.
    startSession(runner, {
      sessionToken: "session-2",
      githubToken: "newer-start-token",
      expiresAt: isoAfter(120),
    });

    expect(await runner.tokens.read("session-2")).toEqual({ token: "newer-start-token" });
    expect(await runner.tokens.read("session-1")).toEqual({ token: "newer-start-token" });
    expect(runner.asked).toEqual([]);
  });

  it("keeps a newer copy when a session whose preparation was slow holds an older start token", async () => {
    const runner = setUp();
    startSession(runner, { githubToken: "newer-token", expiresAt: isoAfter(120) });
    runner.advance(4);
    startSession(runner, {
      sessionToken: "session-2",
      githubToken: "older-token",
      expiresAt: isoAfter(60),
    });

    expect(await runner.tokens.read("session-2")).toEqual({ token: "newer-token" });
    // The kept copy is still 4 minutes old, not renewed by the start.
    runner.advance(1.5);
    const asking = runner.tokens.read("session-1");
    runner.answer({ token: "asked-token", expiresAt: isoAfter(180) });
    expect(await asking).toEqual({ token: "asked-token" });
  });

  it("does not let a late answer overwrite a copy seeded with a later-expiring start token", async () => {
    const runner = setUp();
    startSession(runner, { expiresAt: isoAfter(60) });
    runner.advance(6);
    const ask = runner.tokens.read("session-1");
    // While the ask is in flight, a session starts with a newer token.
    startSession(runner, {
      sessionToken: "session-2",
      githubToken: "newer-start-token",
      expiresAt: isoAfter(120),
    });
    runner.answer({ token: "older-answer", expiresAt: isoAfter(90) });

    expect(await ask).toEqual({ token: "older-answer" });
    expect(await runner.tokens.read("session-2")).toEqual({ token: "newer-start-token" });
  });

  it("never replaces a copy with a start token that has no expiry", async () => {
    const runner = setUp();
    startSession(runner, { expiresAt: isoAfter(60) });
    startSession(runner, { sessionToken: "session-2", githubToken: "pasted-token" });

    expect(await runner.tokens.read("session-2")).toEqual({ token: "start-token" });
  });

  it("refuses a session token it does not know", async () => {
    const runner = setUp();
    startSession(runner);

    expect(await runner.tokens.read("someone-else")).toEqual({
      reason: "this runner holds no GitHub token for this session",
    });
    expect(runner.asked).toEqual([]);
  });
});

describe("when the controller refuses", () => {
  it("drops the copy and returns the reason, and the session asks again next time", async () => {
    const runner = setUp();
    startSession(runner);
    runner.advance(6);

    const refused = runner.tokens.read("session-1");
    runner.answer({ reason: "the session's GitHub Connection no longer exists" });
    expect(await refused).toEqual({ reason: "the session's GitHub Connection no longer exists" });

    // No copy is left to fall back on, and the session is still bound.
    const again = runner.tokens.read("session-1");
    expect(runner.asked).toHaveLength(2);
    runner.failToAnswer();
    expect(await again).toEqual({
      reason:
        "the controller could not be reached, and this runner's copy of the token has expired",
    });
  });
});

describe("when the controller cannot be reached", () => {
  it("serves a copy that has not expired yet, even inside the 10 minute margin", async () => {
    const runner = setUp();
    startSession(runner, { expiresAt: isoAfter(30) });
    runner.advance(25);

    const read = runner.tokens.read("session-1");
    runner.failToAnswer();

    expect(await read).toEqual({ token: "start-token" });
  });

  it("returns the unreachable reason once the copy has expired", async () => {
    const runner = setUp();
    startSession(runner, { expiresAt: isoAfter(30) });
    runner.advance(31);

    const read = runner.tokens.read("session-1");
    runner.failToAnswer();

    expect(await read).toEqual({
      reason:
        "the controller could not be reached, and this runner's copy of the token has expired",
    });
  });

  it("serves a copy without an expiry, since it cannot have expired", async () => {
    const runner = setUp();
    startSession(runner);
    runner.advance(60);

    const read = runner.tokens.read("session-1");
    runner.failToAnswer();

    expect(await read).toEqual({ token: "start-token" });
  });
});

describe("releasing sessions", () => {
  it("keeps the copy while another session of the Connection runs", async () => {
    const runner = setUp();
    const release = startSession(runner);
    startSession(runner, { sessionToken: "session-2" });
    release();

    expect(await runner.tokens.read("session-2")).toEqual({ token: "start-token" });
    expect(await runner.tokens.read("session-1")).toEqual({
      reason: "this runner holds no GitHub token for this session",
    });
  });

  it("drops the copy with the last session, so a new session is seeded from its own start token", async () => {
    const runner = setUp();
    const release = startSession(runner);
    release();
    release();
    expect(await runner.tokens.read("session-1")).toEqual({
      reason: "this runner holds no GitHub token for this session",
    });

    startSession(runner, { sessionToken: "session-3", githubToken: "new-start-token" });
    expect(await runner.tokens.read("session-3")).toEqual({ token: "new-start-token" });
  });

  it("does not recreate the copy when an answer arrives after the last release", async () => {
    const runner = setUp();
    const release = startSession(runner);
    runner.advance(6);
    const late = runner.tokens.read("session-1");
    release();
    runner.answer({ token: "late-token" });
    await late;

    // A new session whose own start token is the only legitimate seed.
    startSession(runner, { sessionToken: "session-3", githubToken: "new-start-token" });
    expect(await runner.tokens.read("session-3")).toEqual({ token: "new-start-token" });
  });

  it("does not let an answer meant for a released Connection touch its replacement", async () => {
    const runner = setUp();
    const release = startSession(runner);
    runner.advance(6);
    const late = runner.tokens.read("session-1");
    release();
    startSession(runner, { sessionToken: "session-3", githubToken: "new-start-token" });
    runner.answer({ reason: "the session's GitHub Connection no longer exists" });
    await late;

    expect(await runner.tokens.read("session-3")).toEqual({ token: "new-start-token" });
  });
});
