/**
 * Tests the probe of an Antigravity account through `makeProbe`: what it
 * reports for a signed-in account, a signed-out one and every failure, and
 * that it leaves nothing of its own behind in the Harness Home. A fake `agy`
 * answers from the recording of a signed-in account and writes the files a
 * real one writes, so the tests see the files appear and disappear. The real
 * `agy` is never started.
 */
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { TestClock } from "effect/testing";
import { answerWith } from "@hercule/acp/testing";
import type { ProbeResult } from "@hercule/protocol";
import { PROBE_DEADLINE } from "../probe";
import { cleanupHomes, createScratchHome, waitUntil } from "../testing";
import { APP_DATA_DIR } from "./harness-home";
import {
  AGY_VERSION,
  BINARY,
  CONVERSATION,
  PLAN_LABEL,
  SIGNED_IN_EMAIL,
  answerNewSession,
  buildContext,
  buildFakeAgy,
  createConversationFiles,
  createSignedInHome,
  listHomeFiles,
  noAnswer,
  refuse,
  writeToken,
  type FakeAgy,
} from "./fake-agy.testing";
import { makeProbe } from "./probe";

afterEach(() => {
  cleanupHomes();
});

const isRoot = process.getuid?.() === 0;

const OTHER_CONVERSATION = "11111111-2222-4333-8444-555555555555";

const probeAccount = (home: string, fake: FakeAgy): Promise<ProbeResult> =>
  Effect.runPromise(makeProbe(fake)(buildContext(home), BINARY));

/**
 * Runs the probe on the test clock. Starts it, waits until the fake `agy` has
 * received `method`, runs `whenWaiting` there, and returns the probe's result.
 */
const probeUntilWaiting = (
  home: string,
  fake: FakeAgy,
  method: string,
  whenWaiting: Effect.Effect<void>,
): Promise<ProbeResult> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const probing = yield* Effect.forkChild(makeProbe(fake)(buildContext(home), BINARY));
      yield* Effect.promise(() =>
        waitUntil(
          `received ${method}`,
          () =>
            fake.spawns[0]?.harness.received.some((message) => message.method === method) === true,
        ),
      );
      yield* whenWaiting;
      return yield* Fiber.join(probing);
    }).pipe(Effect.provide(TestClock.layer())),
  );

const receivedMethods = (fake: FakeAgy): ReadonlyArray<string | undefined> =>
  fake.spawns[0]!.harness.received.map((message) => message.method);

const conversationFiles = (home: string): ReadonlyArray<string> => [
  join(home, APP_DATA_DIR, "conversations", `${CONVERSATION}.db`),
  join(home, APP_DATA_DIR, "brain", CONVERSATION),
];

describe("a signed-in account", () => {
  it("reports who is signed in, the plan, the models and the version", async () => {
    const home = createSignedInHome();

    const result = await probeAccount(home, buildFakeAgy(home));

    expect(result.harnessVersion).toBe(AGY_VERSION);
    expect(result.auth).toEqual({ status: "ok", identity: SIGNED_IN_EMAIL, planLabel: PLAN_LABEL });
    expect(result.models.map((model) => model.slug)).toEqual([
      "gemini-4-hydrogen",
      "gemini-3.8-flash",
      "claude-sonnet-4-6",
      "claude-opus-4-6-thinking",
      "gpt-oss-120b-medium",
    ]);
    expect(result.models.find((model) => model.isDefault)?.slug).toBe("gemini-4-hydrogen");
    expect(result.usage).toBeNull();
  });

  it("leaves nothing new in the Harness Home, and keeps the files of other conversations", async () => {
    const home = createSignedInHome();
    createConversationFiles(home, OTHER_CONVERSATION);
    writeFileSync(join(home, APP_DATA_DIR, "conversation_summaries.db"), "summaries");
    const before = listHomeFiles(home);
    const fake = buildFakeAgy(home);

    await probeAccount(home, fake);

    // The conversation was there while the process ran, and it is gone now.
    expect(fake.spawns).toHaveLength(1);
    expect(fake.spawns[0]!.filesAtExit).toContain(
      `${APP_DATA_DIR}/conversations/${CONVERSATION}.db`,
    );
    expect(fake.spawns[0]!.hasExited).toBe(true);
    expect(listHomeFiles(home)).toEqual(before);
  });

  it("deletes the conversation's files only after the process has exited", async () => {
    const home = createSignedInHome();
    const fake = buildFakeAgy(home);

    await probeAccount(home, fake);

    const atExit = fake.spawns[0]!.filesAtExit!;
    expect(atExit).toContain(`${APP_DATA_DIR}/conversations/${CONVERSATION}.db`);
    expect(atExit).toContain(`${APP_DATA_DIR}/brain/${CONVERSATION}`);
    for (const path of conversationFiles(home)) expect(existsSync(path)).toBe(false);
  });

  it("opens a conversation in a scratch folder, closes it and sends no prompt", async () => {
    const home = createSignedInHome();
    const fake = buildFakeAgy(home);

    await probeAccount(home, fake);

    const methods = receivedMethods(fake);
    expect(methods).toEqual(
      expect.arrayContaining(["initialize", "authenticate", "session/new", "session/close"]),
    );
    expect(methods).not.toContain("session/prompt");
    const newSession = fake.spawns[0]!.harness.received.find(
      (message) => message.method === "session/new",
    );
    expect(newSession?.params).toMatchObject({ mcpServers: [] });
    expect(fake.spawns[0]!.cwd.startsWith(join(home, "hercule-scratch-"))).toBe(true);
  });

  it("still reports the models when the process never answers session/close", async () => {
    const home = createSignedInHome();
    const fake = buildFakeAgy(home, { scripts: { "session/close": noAnswer } });

    const result = await probeUntilWaiting(
      home,
      fake,
      "session/close",
      TestClock.adjust(Duration.seconds(2)),
    );

    expect(result.auth.status).toBe("ok");
    expect(result.models).not.toEqual([]);
    for (const path of conversationFiles(home)) expect(existsSync(path)).toBe(false);
  });
});

describe("an account that is not signed in", () => {
  it("is unauthenticated and still reports the version, with no process started", async () => {
    const home = createScratchHome("agy-probe");
    const fake = buildFakeAgy(home);

    const result = await probeAccount(home, fake);

    expect(result).toEqual({
      harnessVersion: AGY_VERSION,
      auth: { status: "unauthenticated" },
      models: [],
      usage: null,
    });
    expect(fake.spawns).toHaveLength(0);
  });

  it("is unauthenticated when session/new answers -32000, and the process is stopped", async () => {
    const home = createSignedInHome();
    const fake = buildFakeAgy(home, {
      scripts: { "session/new": refuse(-32000, "Authentication required") },
    });

    const result = await probeAccount(home, fake);

    expect(result.auth).toEqual({ status: "unauthenticated" });
    expect(result.harnessVersion).toBe(AGY_VERSION);
    expect(fake.spawns[0]!.hasExited).toBe(true);
  });
});

describe("a probe that cannot trust what it found", () => {
  it("is an error when the account lists no models, and still removes the conversation", async () => {
    const home = createSignedInHome();
    const fake = buildFakeAgy(home, {
      scripts: {
        "session/new": (call, harness) => {
          createConversationFiles(home, CONVERSATION);
          return answerWith({ sessionId: CONVERSATION })(call, harness);
        },
      },
    });

    const result = await probeAccount(home, fake);

    expect(result.auth).toEqual({
      status: "error",
      message:
        "Antigravity listed no models for this account. The runner may be offline, or Google may have refused the sign-in.",
    });
    expect(result.models).toEqual([]);
    expect(result.harnessVersion).toBe(AGY_VERSION);
    for (const path of conversationFiles(home)) expect(existsSync(path)).toBe(false);
  });

  it("is an error when the token file names nobody", async () => {
    const home = createScratchHome("agy-probe");
    writeToken(home, undefined);

    const result = await probeAccount(home, buildFakeAgy(home));

    expect(result.auth).toEqual({
      status: "error",
      message: "Could not read who is signed in to Antigravity.",
    });
    expect(result.models).toEqual([]);
  });

  it("is an error when someone else signed in while the account was checked", async () => {
    const home = createSignedInHome();
    const fake = buildFakeAgy(home, {
      scripts: {
        "session/close": (call, harness) => {
          writeToken(home, "bob@example.com");
          return answerWith({})(call, harness);
        },
      },
    });

    const result = await probeAccount(home, fake);

    expect(result.auth).toEqual({
      status: "error",
      message: "Someone signed in to Antigravity while the account was checked. Check it again.",
    });
    expect(result.models).toEqual([]);
    for (const path of conversationFiles(home)) expect(existsSync(path)).toBe(false);
  });

  it("is an error, not signed out, for a failure it does not know", async () => {
    const home = createSignedInHome();
    const fake = buildFakeAgy(home, {
      scripts: { "session/new": refuse(-32603, "the model service fell over") },
    });

    const result = await probeAccount(home, fake);

    expect(result.auth.status).toBe("error");
    expect(result.auth.message).toContain("the model service fell over");
    expect(result.harnessVersion).toBe(AGY_VERSION);
  });
});

describe("a probe that takes too long", () => {
  it("is an error when session/new never answers, stops the process and deletes nothing", async () => {
    const home = createSignedInHome();
    const fake = buildFakeAgy(home, {
      scripts: {
        // The files exist, but the probe never learned whose they are.
        "session/new": (call, harness) => {
          createConversationFiles(home, CONVERSATION);
          return noAnswer(call, harness);
        },
      },
    });

    const result = await probeUntilWaiting(
      home,
      fake,
      "session/new",
      TestClock.adjust(PROBE_DEADLINE),
    );

    expect(result.auth).toEqual({
      status: "error",
      message: "Antigravity did not answer within 15 seconds.",
    });
    expect(result.harnessVersion).toBe(AGY_VERSION);
    expect(fake.spawns[0]!.hasExited).toBe(true);
    for (const path of conversationFiles(home)) expect(existsSync(path)).toBe(true);
    expect(listHomeFiles(home).some((name) => name.startsWith("hercule-scratch-"))).toBe(false);
  });
});

describe("a probe that is interrupted", () => {
  it("still stops the process and deletes the conversation it opened", async () => {
    const home = createSignedInHome();
    const fake = buildFakeAgy(home, { scripts: { "session/close": noAnswer } });

    await Effect.runPromise(
      Effect.gen(function* () {
        const probing = yield* Effect.forkChild(makeProbe(fake)(buildContext(home), BINARY));
        yield* Effect.promise(() =>
          waitUntil(
            "received session/close",
            () =>
              fake.spawns[0]?.harness.received.some(
                (message) => message.method === "session/close",
              ) === true,
          ),
        );
        yield* Fiber.interrupt(probing);
      }),
    );

    expect(fake.spawns[0]!.hasExited).toBe(true);
    for (const path of conversationFiles(home)) expect(existsSync(path)).toBe(false);
    expect(listHomeFiles(home).some((name) => name.startsWith("hercule-scratch-"))).toBe(false);
  });
});

describe.skipIf(isRoot)("a conversation whose files cannot be removed", () => {
  it("is an error that says why", async () => {
    const home = createSignedInHome();
    const conversations = join(home, APP_DATA_DIR, "conversations");
    const fake = buildFakeAgy(home, {
      scripts: {
        "session/new": (call, harness) => {
          const reply = answerNewSession(home)(call, harness);
          // A folder nobody may write to: the files stay.
          chmodSync(conversations, 0o500);
          return reply;
        },
      },
    });

    try {
      const result = await probeAccount(home, fake);

      expect(result.auth.status).toBe("error");
      expect(result.auth.message).toMatch(
        /^Could not remove the files of the Antigravity check: .*permission denied/i,
      );
      expect(result.models).toEqual([]);
      expect(result.harnessVersion).toBe(AGY_VERSION);
    } finally {
      mkdirSync(conversations, { recursive: true });
      chmodSync(conversations, 0o700);
    }
  });
});
