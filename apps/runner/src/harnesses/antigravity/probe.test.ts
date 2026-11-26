/**
 * Tests the probe of an Antigravity account through `makeProbe`: what it
 * reports for a signed-in account, a signed-out one, an account Google holds
 * and every failure, and that it keeps one conversation per Harness Home and
 * resumes it instead of making a new one each time. A fake `agy` answers from
 * the recording of a signed-in account and writes the files a real one writes.
 * The real `agy` is never started.
 */
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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

const OTHER_CONVERSATION = "11111111-2222-4333-8444-555555555555";

const NO_MODELS =
  "Antigravity listed no models for this account. The runner may be offline, or Google may have refused the sign-in.";

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
        waitUntil(`received ${method}`, () => receivedMethods(fake).includes(method)),
      );
      yield* whenWaiting;
      return yield* Fiber.join(probing);
    }).pipe(Effect.provide(TestClock.layer())),
  );

/** Returns the methods the first process of the fake received, in order. */
const receivedMethods = (fake: FakeAgy): ReadonlyArray<string | undefined> =>
  fake.spawns[0]?.harness.received.map((message) => message.method) ?? [];

const storedIdPath = (home: string): string => join(home, "hercule-probe-conversation");

const readStoredId = (home: string): string => readFileSync(storedIdPath(home), "utf8");

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

  it("makes one conversation, stores its id, and keeps it", async () => {
    const home = createSignedInHome();
    const fake = buildFakeAgy(home);

    await probeAccount(home, fake);

    expect(receivedMethods(fake)).toEqual(
      expect.arrayContaining(["initialize", "authenticate", "session/new", "session/close"]),
    );
    expect(receivedMethods(fake)).not.toContain("session/resume");
    expect(readStoredId(home)).toBe(`${CONVERSATION}\n`);
    for (const path of conversationFiles(home)) expect(existsSync(path)).toBe(true);
    expect(fake.spawns[0]!.hasExited).toBe(true);
  });

  it("runs the conversation in one fixed folder that only the user can enter, and sends no prompt", async () => {
    const home = createSignedInHome();
    const fake = buildFakeAgy(home);

    await probeAccount(home, fake);

    const folder = join(home, "hercule-probe");
    expect(fake.spawns[0]!.cwd).toBe(folder);
    expect(statSync(folder).mode & 0o777).toBe(0o700);
    expect(receivedMethods(fake)).not.toContain("session/prompt");
    const newSession = fake.spawns[0]!.harness.received.find(
      (message) => message.method === "session/new",
    );
    expect(newSession?.params).toMatchObject({ cwd: folder, mcpServers: [] });
  });

  it("resumes the kept conversation the next time, and adds nothing to the Harness Home", async () => {
    const home = createSignedInHome();
    await probeAccount(home, buildFakeAgy(home));
    const afterFirst = listHomeFiles(home);
    const second = buildFakeAgy(home);

    const result = await probeAccount(home, second);

    expect(receivedMethods(second)).toContain("session/resume");
    expect(receivedMethods(second)).not.toContain("session/new");
    expect(
      second.spawns[0]!.harness.received.find((m) => m.method === "session/resume")?.params,
    ).toMatchObject({ sessionId: CONVERSATION, cwd: join(home, "hercule-probe") });
    expect(result.auth.status).toBe("ok");
    expect(result.models).toHaveLength(5);
    expect(listHomeFiles(home)).toEqual(afterFirst);
    expect(listHomeFiles(home).some((name) => name.startsWith("hercule-scratch-"))).toBe(false);
  });

  it("makes a new conversation and replaces the stored id when the stored one cannot be resumed", async () => {
    const home = createSignedInHome();
    writeFileSync(storedIdPath(home), `${OTHER_CONVERSATION}\n`);
    const fake = buildFakeAgy(home);

    const result = await probeAccount(home, fake);

    expect(receivedMethods(fake)).toEqual(
      expect.arrayContaining(["session/resume", "session/new"]),
    );
    expect(result.auth.status).toBe("ok");
    expect(readStoredId(home)).toBe(`${CONVERSATION}\n`);
  });

  it.each([
    ["text that is not a UUID", "not-a-uuid\n"],
    ["an empty file", ""],
    ["a UUID followed by more", `${OTHER_CONVERSATION}\n${"x".repeat(500)}`],
  ])("treats a stored file with %s as no conversation", async (_what, content) => {
    const home = createSignedInHome();
    writeFileSync(storedIdPath(home), content);
    const fake = buildFakeAgy(home);

    const result = await probeAccount(home, fake);

    expect(receivedMethods(fake)).not.toContain("session/resume");
    expect(receivedMethods(fake)).toContain("session/new");
    expect(result.auth.status).toBe("ok");
    expect(readStoredId(home)).toBe(`${CONVERSATION}\n`);
  });

  it("keeps the files of other conversations as they are", async () => {
    const home = createSignedInHome();
    createConversationFiles(home, OTHER_CONVERSATION);
    writeFileSync(join(home, APP_DATA_DIR, "conversation_summaries.db"), "summaries");
    const before = listHomeFiles(home);

    await probeAccount(home, buildFakeAgy(home));

    const after = listHomeFiles(home);
    for (const file of before) expect(after).toContain(file);
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

  it("is unauthenticated when session/resume answers -32000, and makes no new conversation", async () => {
    const home = createSignedInHome();
    writeFileSync(storedIdPath(home), `${CONVERSATION}\n`);
    const fake = buildFakeAgy(home, {
      scripts: { "session/resume": refuse(-32000, "Authentication required") },
    });

    const result = await probeAccount(home, fake);

    expect(result.auth).toEqual({ status: "unauthenticated" });
    expect(receivedMethods(fake)).not.toContain("session/new");
    expect(readStoredId(home)).toBe(`${CONVERSATION}\n`);
  });
});

describe("an account Antigravity cannot use", () => {
  it("is an error that says Google holds the account when it lists models but gives no plan", async () => {
    const home = createSignedInHome();
    const fake = buildFakeAgy(home, { scripts: { authenticate: answerWith({}) } });

    const result = await probeAccount(home, fake);

    expect(result.auth.status).toBe("error");
    expect(result.auth.message).toContain("Google is holding this account until it is verified");
    expect(result.auth.message).toContain("need not be repeated");
    expect(result.models).toEqual([]);
    expect(result.harnessVersion).toBe(AGY_VERSION);
  });

  it("is an error that says the runner may be offline when no model is listed", async () => {
    const home = createSignedInHome();
    const fake = buildFakeAgy(home, {
      scripts: {
        "session/new": (call, harness) => answerWith({ sessionId: CONVERSATION })(call, harness),
      },
    });

    const result = await probeAccount(home, fake);

    expect(result.auth).toEqual({ status: "error", message: NO_MODELS });
    expect(result.models).toEqual([]);
    expect(result.harnessVersion).toBe(AGY_VERSION);
  });
});

describe("a probe that cannot trust what it found", () => {
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

  it("is an error that says why when the conversation's id cannot be stored", async () => {
    const home = createSignedInHome();
    // A folder in the place of the file: the rename onto it fails.
    mkdirSync(join(storedIdPath(home), "inside"), { recursive: true });

    const result = await probeAccount(home, buildFakeAgy(home));

    expect(result.auth.status).toBe("error");
    expect(result.auth.message).toMatch(
      /^Could not remember the conversation of the Antigravity check on this runner: .+\.$/,
    );
  });

  it("is an error when the probe's working folder is a link", async () => {
    const home = createSignedInHome();
    symlinkSync(createScratchHome("agy-elsewhere"), join(home, "hercule-probe"));
    const fake = buildFakeAgy(home);

    const result = await probeAccount(home, fake);

    expect(result.auth.status).toBe("error");
    expect(result.auth.message).toMatch(
      /^Could not make the working folder for the Antigravity check on this runner: /,
    );
    expect(fake.spawns).toHaveLength(0);
  });
});

describe("a probe that takes too long", () => {
  it("is an error when session/new never answers, and stops the process", async () => {
    const home = createSignedInHome();
    const fake = buildFakeAgy(home, { scripts: { "session/new": noAnswer } });

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
    expect(existsSync(storedIdPath(home))).toBe(false);
  });
});
