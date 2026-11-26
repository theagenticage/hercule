/**
 * Tests the probe of an Antigravity account through the Harness Adapter: what
 * it reports for a signed-in account, a signed-out one, an account it cannot
 * trust and every failure, and that it keeps one conversation per Harness Home
 * and resumes it instead of making a new one each time. The messages of the
 * account checks, how the `agy` process is opened and the rest of the
 * sign-in are tested with `agy.ts`. A fake `agy` answers from the recording of
 * a signed-in account and writes the files and worker logs a real one writes.
 * The real `agy` is never started.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import { TestClock } from "effect/testing";
import { answerWith, type HarnessScript } from "@hercule/acp/testing";
import type { ProbeResult } from "@hercule/protocol";
import { PROBE_DEADLINE } from "../probe";
import { cleanupHomes, createScratchHome, waitUntil } from "../testing";
import { makeAntigravityAdapter } from "./adapter";
import { APP_DATA_DIR } from "./harness-home";
import {
  AGY_VERSION,
  CONVERSATION,
  HELD_BY_GOOGLE_LINE,
  FILE_STORAGE_LINE,
  KEYRING_LINE,
  PLAN_LABEL,
  SIGNED_IN_EMAIL,
  answerNewSession,
  buildContext,
  buildFakeAgy,
  createSignedInHome,
  listHomeFiles,
  noAnswer,
  refuse,
  writeToken,
  type FakeAgy,
  type FakeAgyOptions,
} from "./fake-agy.testing";

afterEach(() => {
  cleanupHomes();
});

const OTHER_CONVERSATION = "11111111-2222-4333-8444-555555555555";

const probeWith = (home: string, fake: FakeAgy): Effect.Effect<ProbeResult> =>
  makeAntigravityAdapter(fake).probe(buildContext(home), { readUsage: false });

const probeAccount = (home: string, fake: FakeAgy): Promise<ProbeResult> =>
  Effect.runPromise(probeWith(home, fake));

const isRoot = process.getuid?.() === 0;

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
      const probing = yield* Effect.forkChild(probeWith(home, fake));
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

/** Makes a fake `agy` for a new signed-in Harness Home, and returns the home too. */
const setUp = (options: FakeAgyOptions = {}): { readonly home: string; readonly fake: FakeAgy } => {
  const home = createSignedInHome();
  return { home, fake: buildFakeAgy(home, options) };
};

describe("a signed-in account", () => {
  it("reports who is signed in, the plan, the models and the version", async () => {
    const { home, fake } = setUp();

    const result = await probeAccount(home, fake);

    expect(result.harnessVersion).toBe(AGY_VERSION);
    expect(result.auth).toEqual({ status: "ok", identity: SIGNED_IN_EMAIL, planLabel: PLAN_LABEL });
    expect(result.models).toHaveLength(5);
    expect(result.models.find((model) => model.isDefault)?.slug).toBe("gemini-4-hydrogen");
    expect(result.usage).toBeNull();
  });

  it("makes one conversation in one fixed folder, stores its id, keeps it, and sends no prompt", async () => {
    const { home, fake } = setUp();

    await probeAccount(home, fake);

    const folder = join(home, "hercule-probe");
    expect(receivedMethods(fake)).toEqual(
      expect.arrayContaining(["initialize", "authenticate", "session/new", "session/close"]),
    );
    expect(receivedMethods(fake)).not.toContain("session/resume");
    expect(receivedMethods(fake)).not.toContain("session/prompt");
    expect(fake.spawns[0]!.cwd).toBe(folder);
    expect(
      fake.spawns[0]!.harness.received.find((message) => message.method === "session/new")?.params,
    ).toMatchObject({ cwd: folder, mcpServers: [] });
    expect(readStoredId(home)).toBe(`${CONVERSATION}\n`);
    expect(existsSync(join(home, APP_DATA_DIR, "conversations", `${CONVERSATION}.db`))).toBe(true);
    expect(fake.spawns[0]!.hasExited).toBe(true);
  });

  it("resumes the kept conversation the next time, and adds nothing to the Harness Home", async () => {
    const { home, fake } = setUp();
    await probeAccount(home, fake);
    const afterFirst = listHomeFiles(home);
    const second = buildFakeAgy(home);

    const result = await probeAccount(home, second);

    expect(receivedMethods(second)).toContain("session/resume");
    expect(receivedMethods(second)).not.toContain("session/new");
    expect(
      second.spawns[0]!.harness.received.find((message) => message.method === "session/resume")
        ?.params,
    ).toMatchObject({ sessionId: CONVERSATION, cwd: join(home, "hercule-probe") });
    expect(result.auth.status).toBe("ok");
    expect(result.models).toHaveLength(5);
    expect(listHomeFiles(home)).toEqual(afterFirst);
  });

  it("makes a new conversation and replaces the stored id when agy refuses to resume the stored one", async () => {
    const { home, fake } = setUp();
    writeFileSync(storedIdPath(home), `${OTHER_CONVERSATION}\n`);

    const result = await probeAccount(home, fake);

    expect(receivedMethods(fake)).toEqual(
      expect.arrayContaining(["session/resume", "session/new"]),
    );
    expect(result.auth.status).toBe("ok");
    expect(readStoredId(home)).toBe(`${CONVERSATION}\n`);
  });

  it("treats a stored file that is not a UUID as no conversation", async () => {
    const { home, fake } = setUp();
    writeFileSync(storedIdPath(home), "not-a-uuid\n");

    const result = await probeAccount(home, fake);

    expect(receivedMethods(fake)).not.toContain("session/resume");
    expect(result.auth.status).toBe("ok");
    expect(readStoredId(home)).toBe(`${CONVERSATION}\n`);
  });

  it("still reports the models when the process never answers session/close", async () => {
    const { home, fake } = setUp({ scripts: { "session/close": noAnswer } });

    const result = await probeUntilWaiting(
      home,
      fake,
      "session/close",
      TestClock.adjust(Duration.seconds(2)),
    );

    expect(result.auth.status).toBe("ok");
    expect(result.models).not.toEqual([]);
  });

  it("is ok with no version when agy --version fails", async () => {
    const { home, fake } = setUp({ version: null });

    const result = await probeAccount(home, fake);

    expect(result.harnessVersion).toBeNull();
    expect(result.auth.status).toBe("ok");
  });

  it("declines what agy asks while the account is checked, and logs it without the message's raw text", async () => {
    const warnings: Array<string> = [];
    const collecting = Logger.make<unknown, void>(({ logLevel, message }) => {
      if (logLevel === "Warn") warnings.push(String(message));
    });
    const { home, fake } = setUp({
      scripts: {
        "session/new": (call, harness) => [
          {
            jsonrpc: "2.0",
            id: 777,
            method: "session/request_permission",
            params: {
              sessionId: CONVERSATION,
              toolCall: { toolCallId: "call-1", title: "Run a command" },
              options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
            },
          },
          {
            jsonrpc: "2.0",
            method: "vendor/unknown_notice",
            params: { secret: "hunter2" },
          },
          ...answerNewSession(home)(call, harness),
        ],
      },
    });

    const result = await Effect.runPromise(
      probeWith(home, fake).pipe(Effect.provide(Logger.layer([collecting]))),
    );
    await waitUntil(
      "answered the request and logged the message",
      () =>
        fake.spawns[0]!.harness.received.some((message) => message.id === 777) &&
        warnings.length > 0,
    );

    expect(result.auth.status).toBe("ok");
    expect(fake.spawns[0]!.harness.received.find((message) => message.id === 777)?.result).toEqual({
      outcome: { outcome: "cancelled" },
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("vendor/unknown_notice");
    expect(warnings[0]).not.toContain("hunter2");
  });
});

describe("a stored conversation that cannot be resumed", () => {
  const storedConversation = (script: Parameters<typeof setUp>[0]) => {
    const { home, fake } = setUp(script);
    writeFileSync(storedIdPath(home), `${CONVERSATION}\n`);
    return { home, fake };
  };

  const unreadableResume: HarnessScript = answerWith({
    sessionId: CONVERSATION,
    configOptions: [{ id: "model", name: "Model", type: "not-a-type", currentValue: "x" }],
  });
  const closingResume: HarnessScript = (_call, harness) => {
    harness.end();
    return [];
  };

  it.each([
    ["is unreadable", unreadableResume],
    ["ends the connection", closingResume],
  ])("fails the probe, and keeps the stored id, when the resume %s", async (_what, script) => {
    const { home, fake } = storedConversation({ scripts: { "session/resume": script } });

    const result = await probeAccount(home, fake);

    expect(result.auth.status).toBe("error");
    expect(receivedMethods(fake)).not.toContain("session/new");
    expect(readStoredId(home)).toBe(`${CONVERSATION}\n`);
  });

  it("fails the probe, and keeps the stored id, when the resume takes too long", async () => {
    const { home, fake } = storedConversation({ scripts: { "session/resume": noAnswer } });

    const result = await probeUntilWaiting(
      home,
      fake,
      "session/resume",
      TestClock.adjust(PROBE_DEADLINE),
    );

    expect(result.auth.status).toBe("error");
    expect(receivedMethods(fake)).not.toContain("session/new");
    expect(readStoredId(home)).toBe(`${CONVERSATION}\n`);
  });

  it("is unauthenticated when the resume needs a sign-in, and makes no new conversation", async () => {
    const { home, fake } = storedConversation({
      scripts: { "session/resume": refuse(-32000, "Authentication required") },
    });

    const result = await probeAccount(home, fake);

    expect(result.auth).toEqual({ status: "unauthenticated" });
    expect(receivedMethods(fake)).not.toContain("session/new");
    expect(readStoredId(home)).toBe(`${CONVERSATION}\n`);
  });
});

describe("a signed-out account, and the failures that only look like one", () => {
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

  it.each([
    ["-32000 with 'Authentication required'", -32000, "Authentication required", "unauthenticated"],
    ["-32000 with other words", -32000, "Something else broke", "error"],
    ["-32603 with 'Authentication required'", -32603, "Authentication required", "error"],
    ["-32602", -32602, "Unknown model ID: x", "error"],
  ])("is decided at session/new for %s", async (_what, code, text, status) => {
    const { home, fake } = setUp({ scripts: { "session/new": refuse(code, text) } });

    const result = await probeAccount(home, fake);

    expect(result.auth.status).toBe(status);
    expect(result.harnessVersion).toBe(AGY_VERSION);
    expect(fake.spawns[0]!.hasExited).toBe(true);
  });

  it("is an error, not signed out, when agy cannot be started", async () => {
    const { home, fake } = setUp({
      throws: Object.assign(new Error("spawn failed"), { code: "ENOENT" }),
    });

    const result = await probeAccount(home, fake);

    expect(result.auth.status).toBe("error");
    expect(result.harnessVersion).toBe(AGY_VERSION);
  });
});

describe("an account the probe cannot trust", () => {
  it("is an error that says Google holds the account when there is no plan and the session's worker log shows it, and keeps the conversation", async () => {
    const { home, fake } = setUp({
      scripts: { authenticate: answerWith({}) },
      workerLogs: { "session/new": `${FILE_STORAGE_LINE}\n${HELD_BY_GOOGLE_LINE}` },
    });

    const result = await probeAccount(home, fake);

    expect(result.auth.status).toBe("error");
    expect(result.auth.message).toContain("Google is holding this account until it is verified");
    expect(result.models).toEqual([]);
    // Stored before the check, so a held account does not cost a conversation per probe.
    expect(readStoredId(home)).toBe(`${CONVERSATION}\n`);
  });

  it("is an error that says only what is known when there is no plan and no sign that Google holds the account", async () => {
    const { home, fake } = setUp({ scripts: { authenticate: answerWith({}) } });

    const result = await probeAccount(home, fake);

    expect(result.auth.status).toBe("error");
    expect(result.auth.message).toContain("reported no plan for this account");
    expect(result.models).toEqual([]);
  });

  it.each([
    ["no model option", []],
    [
      "a model option whose only choice has an empty value",
      [
        {
          id: "model",
          name: "Model",
          type: "select",
          currentValue: "",
          options: [{ value: "", name: "Nothing" }],
        },
      ],
    ],
  ])("is an error, never ok with no models, for %s", async (_what, configOptions) => {
    const { home, fake } = setUp({
      scripts: { "session/new": answerWith({ sessionId: CONVERSATION, configOptions }) },
    });

    const result = await probeAccount(home, fake);

    expect(result.auth.status).toBe("error");
    expect(result.auth.message).toContain("listed no models");
    expect(result.models).toEqual([]);
  });

  it("is an error when the token file names nobody", async () => {
    const home = createScratchHome("agy-probe");
    writeToken(home, undefined);

    const result = await probeAccount(home, buildFakeAgy(home));

    expect(result.auth).toEqual({
      status: "error",
      message: "Could not read who is signed in to Antigravity. Sign in again on this runner.",
    });
    expect(result.models).toEqual([]);
  });

  it("is an error when someone else signed in while the account was checked", async () => {
    const { home, fake } = setUp({
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

  it("is an error when the worker that session/new started does not use this account's login", async () => {
    const { home, fake } = setUp({ workerLogs: { "session/new": KEYRING_LINE } });

    const result = await probeAccount(home, fake);

    expect(result.auth.status).toBe("error");
    expect(result.models).toEqual([]);
  });
});

describe("a probe that cannot keep its conversation", () => {
  const expectFailedBeforeOpening = (result: ProbeResult, fake: FakeAgy, message: RegExp) => {
    expect(result.auth.status).toBe("error");
    expect(result.auth.message).toMatch(message);
    expect(fake.spawns).toHaveLength(0);
  };

  it.each([
    ["a folder", (path: string) => mkdirSync(path)],
    ["a link", (path: string) => symlinkSync(join(path, "..", "elsewhere"), path)],
  ])(
    "fails before it opens a conversation when %s is in the stored file's place",
    async (_what, prepare) => {
      const { home, fake } = setUp();
      writeFileSync(join(home, "elsewhere"), `${CONVERSATION}\n`);
      prepare(storedIdPath(home));

      const result = await probeAccount(home, fake);

      expectFailedBeforeOpening(
        result,
        fake,
        /^Could not read the conversation of the Antigravity check/,
      );
    },
  );

  it.skipIf(isRoot)(
    "fails before it opens a conversation when nobody may read the stored file",
    async () => {
      const { home, fake } = setUp();
      writeFileSync(storedIdPath(home), `${CONVERSATION}\n`);
      chmodSync(storedIdPath(home), 0o000);

      const result = await probeAccount(home, fake);

      chmodSync(storedIdPath(home), 0o600);
      expectFailedBeforeOpening(result, fake, /permission denied\.$/);
    },
  );

  it("fails before it opens a conversation when the working folder is a link", async () => {
    const { home, fake } = setUp();
    symlinkSync(createScratchHome("agy-elsewhere"), join(home, "hercule-probe"));

    const result = await probeAccount(home, fake);

    expectFailedBeforeOpening(
      result,
      fake,
      /^Could not make the working folder for the Antigravity check/,
    );
  });

  it("is an error, and stores nothing, when agy gives an id that is not a UUID", async () => {
    const { home, fake } = setUp({
      scripts: { "session/new": answerWith({ sessionId: "../brain/x" }) },
    });

    const result = await probeAccount(home, fake);

    expect(result.auth.status).toBe("error");
    expect(result.auth.message).toContain("not a UUID");
    expect(existsSync(storedIdPath(home))).toBe(false);
  });
});

describe("a probe that takes too long", () => {
  it("is an error when session/new never answers, and stops the process", async () => {
    const { home, fake } = setUp({ scripts: { "session/new": noAnswer } });

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
