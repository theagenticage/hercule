/**
 * Tests Antigravity sessions through the `HarnessAdapter` interface. A fake
 * `agy` plays the recordings in `packages/acp/src/recordings` over the pipes of
 * a real process. Where a test needs a message no recording has (an orphaned
 * request, a mode change, a process that does not answer), it starts from the
 * recording's handshake only and writes the messages itself. Time runs on a
 * `TestClock`.
 */
import { lstatSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import type { HarnessScript, JsonRpcMessage } from "@hercule/acp/testing";
import type { HarnessEvent, SessionSpec } from "@hercule/protocol";
import { buildLoadedSkills, resolveSkillReferences } from "../../skills";
import type { AdapterTurnInput, SessionStartContext } from "../index";
import {
  cleanupHomes,
  createScratchHome,
  CWD,
  NO_USER_MATERIAL,
  settle,
  waitUntil,
  writeTestImage,
} from "../testing";
import { makeAntigravityAdapter } from "./adapter";
import {
  answerConfigChange,
  answerNewSession,
  answerResume,
  buildContext,
  buildFakeAgy,
  buildStartContext,
  CONVERSATION,
  createConversationFiles,
  createSignedInHome,
  GATEWAY_ENTRY,
  noAnswer,
  readRecordedSetup,
  refuse,
  type FakeAgyOptions,
} from "./fake-agy.testing";

afterEach(() => {
  cleanupHomes();
  configCalls = 0;
});

const SESSION = "0199e0e7-0000-7000-8000-0000000000ff";
const ACCOUNT = "0199e0e7-0000-7000-8000-00000000000a";

/** The model and level the recordings' `session/new` replies already hold. */
const SPEC: SessionSpec = {
  providerAccountId: ACCOUNT,
  workspaceId: null,
  modelSelection: { model: "gemini-4-hydrogen", options: { effort: "high" } },
  accessMode: "approval-required",
  timeouts: { inactivityMs: 1_800_000, absoluteMs: 28_800_000 },
};

const buildInput = (text: string = "Do it.", extra: Partial<AdapterTurnInput> = {}) => ({
  text,
  ...extra,
});

interface HarnessOptions {
  /** The fake's options, which may depend on the Harness Home the test gets. */
  readonly fake?: FakeAgyOptions | ((home: string) => FakeAgyOptions);
  readonly orientation?: string;
  /** The skill text of the Hercule tool. */
  readonly skill?: string;
  /** What every start of the test changes in the runner's context, which may depend on the Harness Home. */
  readonly context?: (home: string) => Partial<SessionStartContext>;
  /** The folder the session works in. Defaults to `CWD`, which does not exist. */
  readonly cwd?: string;
  /** The MCP servers the runner resolved for the session. */
  readonly mcpServers?: ReadonlyArray<{ readonly name: string; readonly url: string }>;
  /** The environment of the session's process. Defaults to one with the session token. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** What every start of the test changes in `SPEC`. */
  readonly spec?: Partial<SessionSpec>;
  /**
   * Holds the acknowledgement of a write: `agy` gets the line at once, and the
   * write call returns only when the promise this returns settles. Returning
   * undefined acknowledges at once.
   */
  readonly holdAcknowledgement?: (message: JsonRpcMessage) => Promise<void> | undefined;
}

const buildHarness = (options: HarnessOptions = {}) =>
  Effect.gen(function* () {
    const home = createSignedInHome();
    const fake = buildFakeAgy(
      home,
      typeof options.fake === "function" ? options.fake(home) : options.fake,
    );
    const hold = options.holdAcknowledgement;
    const adapter = makeAntigravityAdapter(
      hold === undefined
        ? fake
        : {
            ...fake,
            spawn: (...args) => {
              const child = fake.spawn(...args);
              return {
                ...child,
                write: async (line) => {
                  await child.write(line);
                  await hold(JSON.parse(line) as JsonRpcMessage);
                },
              };
            },
          },
    );
    const seen: Array<HarnessEvent> = [];
    yield* Effect.forkScoped(
      Stream.runForEach(adapter.events, (event) =>
        Effect.sync(() => {
          seen.push(event);
        }),
      ),
    );
    yield* Effect.promise(settle);
    yield* Effect.addFinalizer(() => adapter.stopSession(SESSION, "stopped"));
    const ctx = {
      ...buildStartContext(home, options.cwd ?? CWD),
      ...(options.env === undefined ? {} : { env: options.env }),
      mcpServers: options.mcpServers ?? [GATEWAY_ENTRY],
      herculeTool: {
        ...buildContext(home).herculeTool,
        orientation: options.orientation ?? "",
        skill: options.skill ?? "",
      },
      ...options.context?.(home),
    };
    const tags = <Tag extends HarnessEvent["_tag"]>(tag: Tag) =>
      seen.filter((event): event is Extract<HarnessEvent, { _tag: Tag }> => event._tag === tag);
    return {
      home,
      fake,
      adapter,
      seen,
      tags,
      start: (spec: Partial<SessionSpec> = {}) =>
        adapter.startSession(SESSION, { ...SPEC, ...options.spec, ...spec }, ctx),
      /** The messages the first `agy` process received, by method. */
      received: (method: string): ReadonlyArray<JsonRpcMessage> =>
        (fake.spawns[0]?.harness.received ?? []).filter((message) => message.method === method),
      /** Waits until the process received a message with `method`, `count` times. */
      untilReceived: (method: string, count = 1) =>
        Effect.promise(() =>
          waitUntil(
            `received ${method}`,
            () =>
              (fake.spawns[0]?.harness.received ?? []).filter((m) => m.method === method).length >=
              count,
          ),
        ),
      until: (what: string, ready: () => boolean) => Effect.promise(() => waitUntil(what, ready)),
      harness: () => fake.spawns[0]!.harness,
    };
  });

type Harness = Effect.Success<ReturnType<typeof buildHarness>>;

const run = (
  test: (harness: Harness) => Effect.Effect<void, unknown, Scope.Scope>,
  options: HarnessOptions = {},
) =>
  Effect.runPromise(
    buildHarness(options).pipe(
      Effect.flatMap(test),
      Effect.scoped,
      Effect.provide(TestClock.layer()),
    ),
  );

/** A `session/update` the way `agy` writes it, for the conversation `id`. */
const buildUpdate = (
  update: Record<string, unknown>,
  id: string = CONVERSATION,
): JsonRpcMessage => ({
  jsonrpc: "2.0",
  method: "session/update",
  params: { sessionId: id, update },
});

const buildModeUpdate = (modeId: string) =>
  buildUpdate({ sessionUpdate: "current_mode_update", currentModeId: modeId });

/** Returns a script for `session/new` whose reply is the default one after `change` edited its result. */
const changeNewSession =
  (home: string, change: (result: Record<string, unknown>) => void): HarnessScript =>
  (call, harness) => {
    const lines = answerNewSession(home)(call, harness);
    change((lines[0] as { result: Record<string, unknown> }).result);
    return lines;
  };

/** Returns a script for `session/set_mode` that confirms `modeId` the way `agy` does, with an update after the reply. */
const confirmMode =
  (modeId: string): HarnessScript =>
  ({ id }) => [{ jsonrpc: "2.0", id, result: {} }, buildModeUpdate(modeId)];

/**
 * The `cancel` recording ends its turn with a mode update to `auto`. A session
 * in `full-access` has no mode to guard, so it takes that update without
 * stopping.
 */
const CANCEL_RECORDING: FakeAgyOptions = { recording: "cancel" };

/** How many `session/set_config_option` calls the test that counts them has seen. */
let configCalls = 0;

/** Runs a start in a fiber, so a test can move the clock while it waits. */
const startInFiber = (h: Harness, spec: Partial<SessionSpec> = {}) =>
  Effect.forkChild(Effect.flip(h.start(spec)));

describe("starting a session", () => {
  it("opens a new conversation and reports it", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          const binding = yield* h.start({
            systemPrompt: "Persona.",
            coordination: "Coordination.",
            memory: "Memory.",
          });

          expect(binding).toEqual({
            sessionId: SESSION,
            nativeSessionId: CONVERSATION,
            providerAccountId: ACCOUNT,
          });
          expect(h.tags("session.started")).toMatchObject([
            { sessionId: SESSION, harnessRefs: { nativeSessionId: CONVERSATION } },
          ]);
          expect(h.fake.spawns[0]?.cwd).toBe(CWD);
          expect(h.fake.spawns[0]?.command).not.toContain("--dangerously-skip-permissions");
          // The conversation already holds this model, level and mode: nothing is set.
          expect(h.harness().received.map((message) => message.method)).toEqual([
            "initialize",
            "authenticate",
            "session/new",
          ]);
          expect(h.received("session/new")[0]?.params).toMatchObject({
            cwd: CWD,
            mcpServers: [expect.objectContaining({ name: "tools" })],
            _meta: {
              antigravity: {
                systemPrompt: { append: "Orientation.\n\nPersona.\n\nCoordination.\n\nMemory." },
              },
            },
          });
          expect(yield* h.adapter.listSessions).toEqual([binding]);
        }),
      { orientation: "Orientation." },
    ));

  it("resumes a conversation, and draws nothing of its replay", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          const binding = yield* h.start({
            continue: { nativeSessionId: CONVERSATION, mode: "resume" },
          });

          expect(binding.nativeSessionId).toBe(CONVERSATION);
          expect(h.received("session/resume")[0]?.params).toMatchObject({
            sessionId: CONVERSATION,
          });
          expect(h.received("session/new")).toHaveLength(0);
          expect(h.seen.map((event) => event._tag)).toEqual(["session.started"]);
        }),
      {
        fake: (home) => {
          createConversationFiles(home, CONVERSATION);
          return {
            scripts: {
              "session/resume": (call, harness) => [
                buildUpdate({
                  sessionUpdate: "agent_message_chunk",
                  content: { type: "text", text: "An old answer." },
                }),
                ...answerResume(home)(call, harness),
              ],
            },
          };
        },
      },
    ));

  it("draws an update that follows the reply of a resume, and drops the replay before it", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* h.start({ continue: { nativeSessionId: CONVERSATION, mode: "resume" } });

          expect(h.tags("item.started").map((event) => event.kind)).toEqual(["assistant_message"]);
        }),
      {
        fake: (home) => {
          createConversationFiles(home, CONVERSATION);
          const chunk = (text: string) =>
            buildUpdate({
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text },
            });
          return {
            scripts: {
              "session/resume": (call, harness) => [
                chunk("Replayed."),
                ...answerResume(home)(call, harness),
                chunk("Live."),
              ],
            },
          };
        },
      },
    ));

  it("fails with ResumeTranscriptMissing when agy has no such conversation", () =>
    run((h) =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(
          h.start({ continue: { nativeSessionId: CONVERSATION, mode: "resume" } }),
        );

        expect(failure._tag).toBe("ResumeTranscriptMissing");
        expect(h.tags("session.started")).toHaveLength(0);
        expect(yield* h.adapter.listSessions).toEqual([]);
      }),
    ));

  it("fails with HarnessNotInstalled for a runner without agy, and starts nothing", () =>
    run((h) =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(
          h.adapter.startSession(SESSION, SPEC, {
            ...buildContext(h.home, undefined),
            binary: undefined,
            cwd: CWD,
            mcpServers: [],
          }),
        );

        expect(failure._tag).toBe("HarnessNotInstalled");
        expect(h.fake.spawns).toHaveLength(0);
      }),
    ));

  it("refuses an account that has no plan, and no session starts", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          const failure = yield* Effect.flip(h.start());

          expect(failure._tag).toBe("AdapterFailed");
          expect(failure.message).toContain("reported no plan");
          expect(h.tags("session.started")).toHaveLength(0);
          expect(h.received("session/set_config_option")).toHaveLength(0);
        }),
      { fake: { scripts: { authenticate: ({ id }) => [{ jsonrpc: "2.0", id, result: {} }] } } },
    ));

  it("starts agy with the permission flag in full-access, and sets and checks no mode", () =>
    run((h) =>
      Effect.gen(function* () {
        yield* h.start({ accessMode: "full-access" });

        expect(h.fake.spawns[0]?.command).toContain("--dangerously-skip-permissions");
        expect(h.received("session/set_mode")).toHaveLength(0);
        // A mode change is then nothing to guard.
        h.harness().sendLine(JSON.stringify(buildModeUpdate("plan")));
        yield* Effect.promise(settle);
        expect(h.tags("runtime.error")).toHaveLength(0);
        expect(h.tags("session.exited")).toHaveLength(0);
      }),
    ));
});

/**
 * Lays out the skills of a session as the runner does: the library skills in
 * `<sessionSkillsFolder>/skills/<name>`. A skill in `withoutFile` has no
 * `SKILL.md`. Returns the context fields that give them to a start, and a
 * builder of inputs whose Skill References name the library skills.
 */
const createSessionSkills = (options: {
  readonly library: ReadonlyArray<string>;
  readonly withoutFile?: ReadonlyArray<string>;
}) => {
  const sessionSkillsFolder = join(createScratchHome("agy-session-skills"), "session-skills");
  for (const name of options.library) {
    const folder = join(sessionSkillsFolder, "skills", name);
    mkdirSync(folder, { recursive: true });
    if (!options.withoutFile?.includes(name)) writeFileSync(join(folder, "SKILL.md"), "# skill\n");
  }
  const loaded = buildLoadedSkills({
    libraryFolder: sessionSkillsFolder,
    libraryNames: options.library,
    repositorySkills: [],
  });
  return {
    sessionSkillsFolder,
    context: { sessionSkillsFolder, librarySkillsFolder: sessionSkillsFolder },
    buildInput: (text: string): AdapterTurnInput => ({
      text,
      skillReferences: resolveSkillReferences(text, loaded),
    }),
  };
};

/** Returns a fake whose Harness Home already holds the conversation, so that a start can resume it. */
const withConversation = (home: string): FakeAgyOptions => {
  createConversationFiles(home, CONVERSATION);
  return {};
};

const RESUME = { continue: { nativeSessionId: CONVERSATION, mode: "resume" } } as const;

describe("the skills folder of a session", () => {
  it("is passed to a new conversation as an additional directory", () => {
    const skills = createSessionSkills({ library: ["review"] });
    return run(
      (h) =>
        Effect.gen(function* () {
          yield* h.start();

          expect(h.received("session/new")[0]?.params).toMatchObject({
            additionalDirectories: [skills.sessionSkillsFolder],
          });
        }),
      { context: () => skills.context },
    );
  });

  it("is told to the thread after session.started when a repository skill has the name of a library skill", () => {
    const skills = createSessionSkills({ library: ["release"] });
    const repository = join(skills.sessionSkillsFolder, "repositories", "webshop");
    mkdirSync(join(repository, "skills", "release"), { recursive: true });
    return run(
      (h) =>
        Effect.gen(function* () {
          yield* h.start();

          const tags = h.seen.map((event) => event._tag);
          const warnings = h.tags("runtime.warning");
          expect(warnings).toHaveLength(1);
          expect(warnings[0]?.message).toContain("$webshop:release (same name as $release)");
          expect(tags.indexOf("runtime.warning")).toBeGreaterThan(tags.indexOf("session.started"));
        }),
      {
        context: () => ({ ...skills.context, repositorySkillsFolders: [repository] }),
      },
    );
  });

  it("is not warned about when no two skills share a name", () => {
    const skills = createSessionSkills({ library: ["review"] });
    return run(
      (h) =>
        Effect.gen(function* () {
          yield* h.start();

          expect(h.tags("runtime.warning")).toEqual([]);
        }),
      { context: () => skills.context },
    );
  });

  it("is passed to a resumed conversation too", () => {
    const skills = createSessionSkills({ library: ["review"] });
    return run(
      (h) =>
        Effect.gen(function* () {
          yield* h.start(RESUME);

          expect(h.received("session/resume")[0]?.params).toMatchObject({
            additionalDirectories: [skills.sessionSkillsFolder],
          });
        }),
      { fake: withConversation, context: () => skills.context },
    );
  });

  it("is passed resolved when it is reached through a link, as the pointer lines name resolved paths", () => {
    const skills = createSessionSkills({ library: ["review"] });
    const link = join(createScratchHome("agy-session-link"), "linked");
    symlinkSync(skills.sessionSkillsFolder, link);
    return run(
      (h) =>
        Effect.gen(function* () {
          yield* h.start();

          expect(h.received("session/new")[0]?.params).toMatchObject({
            additionalDirectories: [realpathSync(skills.sessionSkillsFolder)],
          });
        }),
      { context: () => ({ sessionSkillsFolder: link, librarySkillsFolder: link }) },
    );
  });

  it("fails the start, and spawns nothing, when agy does not take additional directories", () => {
    const skills = createSessionSkills({ library: ["review"] });
    return run(
      (h) =>
        Effect.gen(function* () {
          const failure = yield* Effect.flip(h.start());

          expect(failure._tag).toBe("AdapterFailed");
          expect(failure.message).toContain("additionalDirectories");
          expect(h.received("session/new")).toHaveLength(0);
          expect(h.tags("session.started")).toHaveLength(0);
        }),
      {
        fake: { withoutAdditionalDirectoriesCapability: true },
        context: () => skills.context,
      },
    );
  });

  it("fails the start with the staging error, and spawns nothing, when the .git file cannot be written", () => {
    const skills = createSessionSkills({ library: ["review"] });
    writeFileSync(join(skills.sessionSkillsFolder, ".git"), "");
    return run(
      (h) =>
        Effect.gen(function* () {
          const failure = yield* Effect.flip(h.start());

          expect(failure._tag).toBe("AdapterFailed");
          expect(failure.message).toContain("could not prepare the session's skills folder");
          expect(h.fake.spawns).toHaveLength(0);
        }),
      { context: () => skills.context },
    );
  });

  it("is left out of a start with no skills, which needs no additional directories capability", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* h.start();

          expect(h.tags("session.started")).toHaveLength(1);
          expect(h.received("session/new")[0]?.params).not.toHaveProperty("additionalDirectories");
        }),
      { fake: { withoutAdditionalDirectoriesCapability: true } },
    ));
});

describe("the instructions of a session", () => {
  const PARTS = {
    systemPrompt: "Persona.",
    coordination: "Coordination.",
    memory: "Memory.",
  };
  const ALL_PARTS = (user: string) =>
    `Orientation.\n\nPersona.\n\n${user}\n\nSkill.\n\nCoordination.\n\nMemory.`;
  const expectedMeta = (append: string) => ({ antigravity: { systemPrompt: { append } } });

  it.each(["new", "resume"] as const)(
    "hold the orientation, persona, user's instructions, skill, coordination and memory, in that order, on a %s start",
    (kind) =>
      run(
        (h) =>
          Effect.gen(function* () {
            yield* h.start(kind === "resume" ? { ...PARTS, ...RESUME } : PARTS);

            const method = kind === "resume" ? "session/resume" : "session/new";
            expect(h.received(method)[0]?.params).toMatchObject({
              _meta: expectedMeta(ALL_PARTS("User.")),
            });
          }),
        {
          orientation: "Orientation.",
          skill: "Skill.",
          fake: withConversation,
          context: () => ({ userMaterial: { ...NO_USER_MATERIAL, instructions: "User." } }),
        },
      ),
  );

  it("tells the thread after session.started what the user's instructions lost", () => {
    const warning = "Cut /Users/someone/.gemini/AGENTS.md in the Thread's instructions";
    return run(
      (h) =>
        Effect.gen(function* () {
          yield* h.start(PARTS);

          const tags = h.seen.map((event) => event._tag);
          expect(h.tags("runtime.warning")).toMatchObject([{ message: warning }]);
          expect(tags.indexOf("runtime.warning")).toBeGreaterThan(tags.indexOf("session.started"));
        }),
      { context: () => ({ userMaterial: { ...NO_USER_MATERIAL, warnings: [warning] } }) },
    );
  });

  it("hold nothing of the user's own files when the session has no User Material", () => {
    const userHome = createScratchHome("agy-user-home");
    mkdirSync(join(userHome, ".gemini"));
    writeFileSync(join(userHome, ".gemini", "GEMINI.md"), "The user's marker.");
    return run(
      (h) =>
        Effect.gen(function* () {
          yield* h.start(PARTS);

          const params = JSON.stringify(h.received("session/new")[0]?.params);
          expect(params).toContain("Persona.");
          expect(params).not.toContain("The user's marker.");
        }),
      { context: (home) => ({ env: { ...buildContext(home).env, HOME: userHome } }) },
    );
  });
});

describe("an input with Skill References", () => {
  /** Returns the `detail` of the `user_message` the session reported. */
  const readUserMessageDetail = (h: Harness) =>
    h.tags("item.started").find((event) => event.kind === "user_message")?.detail;

  it("sends a pointer line for each skill with a file, records only those, and warns about the rest after the user message", () => {
    const skills = createSessionSkills({ library: ["review", "gone"], withoutFile: ["gone"] });
    return run(
      (h) =>
        Effect.gen(function* () {
          yield* h.start();
          const file = join(skills.sessionSkillsFolder, "skills", "review", "SKILL.md");

          const sent = yield* h.adapter.sendInput(
            SESSION,
            skills.buildInput("do $gone and $review"),
          );
          yield* h.untilReceived("session/prompt");

          const prompt = h.received("session/prompt")[0]?.params as {
            prompt: ReadonlyArray<{ text: string }>;
          };
          expect(prompt.prompt[0]?.text).toContain(JSON.stringify(file));
          // Only the skill that got a line is recorded, because a client draws a chip for each one.
          expect(readUserMessageDetail(h)).toMatchObject({ skills: ["review"] });
          yield* h.until("reported the warning", () => h.tags("runtime.warning").length > 0);
          const warnings = h.tags("runtime.warning");
          expect(warnings.map(({ turnId, message }) => ({ turnId, message }))).toEqual([
            {
              turnId: sent.turnId,
              message:
                "Hercule could not give Antigravity the skill $gone: its SKILL.md is missing, is not a regular file, or leads outside the skill's folder. The message was sent without it. Check the skill's folder, then send the message again.",
            },
          ]);
          const tags = h.seen.map((event) => event._tag);
          expect(tags.indexOf("runtime.warning")).toBeGreaterThan(tags.indexOf("item.completed"));
        }),
      { fake: { recording: "bad-model" }, context: () => skills.context },
    );
  });
});

describe("the MCP servers of a session", () => {
  const TOKEN = "sess-tok-7f3a91c2e8";
  const GATEWAY = { name: "tools", url: "http://127.0.0.1:4000/mcp" };
  const ENTRY = {
    name: "tools",
    url: GATEWAY.url,
    type: "http",
    headers: [{ name: "Authorization", value: `Bearer ${TOKEN}` }],
  };
  const withGateway: HarnessOptions = {
    mcpServers: [GATEWAY],
    env: { PATH: "/usr/bin", HERCULE_TOKEN: TOKEN },
  };

  it("are given to agy with the session's token in a new conversation, and again in a resume", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* h.start();
          expect(h.received("session/new")[0]?.params).toMatchObject({ mcpServers: [ENTRY] });
        }),
      withGateway,
    ).then(() =>
      run(
        (h) =>
          Effect.gen(function* () {
            yield* h.start({ continue: { nativeSessionId: CONVERSATION, mode: "resume" } });
            expect(h.received("session/resume")[0]?.params).toMatchObject({
              mcpServers: [ENTRY],
            });
          }),
        {
          ...withGateway,
          fake: (home) => {
            createConversationFiles(home, CONVERSATION);
            return {};
          },
        },
      ),
    ));

  it("fail the start, and spawn nothing, when the session has no token", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          const failure = yield* Effect.flip(h.start());

          expect(failure._tag).toBe("AdapterFailed");
          expect(failure.message).toContain("no session token");
          expect(h.fake.spawns).toHaveLength(0);
        }),
      { mcpServers: [GATEWAY], env: { PATH: "/usr/bin" } },
    ));

  it.each([
    ["none", [], "none"],
    ["one that has another name", [{ name: "other", url: GATEWAY.url }], '"other"'],
    [
      "the Hercule tools and another server",
      [GATEWAY, { name: "other", url: GATEWAY.url }],
      '"tools", "other"',
    ],
    ["the Hercule tools twice", [GATEWAY, GATEWAY], '"tools", "tools"'],
  ])("fail the start, and spawn nothing, when the session was given %s", (_name, servers, given) =>
    run(
      (h) =>
        Effect.gen(function* () {
          const failure = yield* Effect.flip(h.start());

          expect(failure._tag).toBe("AdapterFailed");
          expect(failure.message).toContain(`it was given ${given}`);
          expect(h.fake.spawns).toHaveLength(0);
        }),
      { mcpServers: servers, env: { PATH: "/usr/bin", HERCULE_TOKEN: TOKEN } },
    ),
  );

  it("fail the start when agy takes no MCP server over HTTP", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          const failure = yield* Effect.flip(h.start());

          expect(failure._tag).toBe("AdapterFailed");
          expect(failure.message).toContain("MCP servers over HTTP");
          expect(h.received("authenticate")).toHaveLength(0);
        }),
      { ...withGateway, fake: { withoutHttpMcpCapability: true } },
    ));

  it("never publish the token, wherever agy echoes it", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* h.start();
          const send = (message: JsonRpcMessage) => h.harness().sendLine(JSON.stringify(message));
          const echo = `echo ${TOKEN} end`;
          send(
            buildUpdate({
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: echo },
            }),
          );
          send(
            buildUpdate({
              sessionUpdate: "agent_thought_chunk",
              content: { type: "text", text: echo },
            }),
          );
          send(
            buildUpdate({
              sessionUpdate: "tool_call",
              toolCallId: "call-1",
              name: "run_command",
              status: "in_progress",
              kind: "execute",
              title: echo,
              rawInput: { CommandLine: `curl -H "Authorization: Bearer ${TOKEN}"` },
            }),
          );
          send(
            buildUpdate({
              sessionUpdate: "tool_call_update",
              toolCallId: "call-1",
              name: "run_command",
              status: "completed",
              rawInput: { CommandLine: `curl -H "Authorization: Bearer ${TOKEN}"` },
              rawOutput: echo,
              content: [{ type: "content", content: { type: "text", text: echo } }],
            }),
          );
          send(
            buildUpdate({
              sessionUpdate: `mystery_${TOKEN}`,
              detail: echo,
            }),
          );
          send({ jsonrpc: "2.0", method: `x/${TOKEN}`, params: { text: echo } });
          send({
            jsonrpc: "2.0",
            id: "jetski-acp-front:9",
            method: "session/request_permission",
            params: {
              sessionId: CONVERSATION,
              toolCall: { toolCallId: "call-unknown", name: "run_command", title: echo },
              options: [{ optionId: "deny", name: echo, kind: "reject_once" }],
            },
          });
          send(buildModeUpdate(`mode-${TOKEN}`));
          yield* h.until("the session exited", () => h.tags("session.exited").length === 1);

          const published = JSON.stringify(h.seen);
          expect(published).not.toContain(TOKEN);
          expect(published).toContain("echo [hidden] end");
          expect(h.tags("runtime.error")).toHaveLength(1);
          expect(h.tags("item.completed").length).toBeGreaterThan(1);
        }),
      { ...withGateway, fake: { recording: readRecordedSetup("cancel") } },
    ));
});

describe("a token that agy streams in pieces", () => {
  const TOKEN = "sess-tok-7f3a91c2e8";

  it("is hidden when it is split over two text events, and a held start is released at the end of the session", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* h.start();
          const send = (text: string) =>
            h.harness().sendLine(
              JSON.stringify(
                buildUpdate({
                  sessionUpdate: "agent_message_chunk",
                  content: { type: "text", text },
                }),
              ),
            );
          send(`echo ${TOKEN.slice(0, 9)}`);
          send(`${TOKEN.slice(9)} end ${TOKEN.slice(0, 4)}`);
          yield* h.until("the second chunk was read", () =>
            h.tags("content.delta").some((event) => event.delta.includes("[hidden]")),
          );
          yield* h.adapter.stopSession(SESSION, "stopped");

          const text = h
            .tags("content.delta")
            .map((event) => event.delta)
            .join("");
          expect(text).toBe(`echo [hidden] end ${TOKEN.slice(0, 4)}`);
          expect(JSON.stringify(h.seen)).not.toContain(TOKEN);
          // The held start went out before the session ended.
          const tags = h.seen.map((event) => event._tag);
          expect(tags.lastIndexOf("content.delta")).toBeLessThan(tags.indexOf("session.exited"));
        }),
      {
        env: { PATH: "/usr/bin", HERCULE_TOKEN: TOKEN },
        fake: { recording: readRecordedSetup("cancel") },
      },
    ));
});

describe("the temporary folder of a process", () => {
  it("is private, directly in the system's temporary folder, the process's TMPDIR, and removed when the session ends", () =>
    run((h) =>
      Effect.gen(function* () {
        yield* h.start();
        const folder = h.fake.spawns[0]?.env["TMPDIR"];

        expect(dirname(folder!)).toBe(tmpdir());
        expect(basename(folder!).startsWith("hercule-agy-")).toBe(true);
        expect(lstatSync(folder!).mode & 0o777).toBe(0o700);

        yield* h.adapter.stopSession(SESSION, "stopped");
        expect(() => lstatSync(folder!)).toThrow();
      }),
    ));

  it("is new for every process", () =>
    run((h) =>
      Effect.gen(function* () {
        yield* h.start();
        yield* h.adapter.stopSession(SESSION, "stopped");
        yield* h.start();

        const [first, second] = h.fake.spawns.map((spawned) => spawned.env["TMPDIR"]);
        expect(first).toBeDefined();
        expect(second).toBeDefined();
        expect(first).not.toBe(second);
      }),
    ));
});

describe("the model and level of a start", () => {
  it("are set when the conversation holds others", () =>
    run((h) =>
      Effect.gen(function* () {
        yield* h.start({
          modelSelection: { model: "gemini-3.8-flash", options: { effort: "low" } },
        });

        expect(
          h.received("session/set_config_option").map((message) => message.params),
        ).toMatchObject([
          { configId: "model", value: "gemini-3.8-flash" },
          { configId: "thought_level", value: "low" },
        ]);
      }),
    ));

  it("fail the start, naming the model, when agy refuses the model", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          const failure = yield* Effect.flip(
            h.start({ modelSelection: { model: "no-such-model", options: {} } }),
          );

          expect(failure._tag).toBe("AdapterFailed");
          expect(failure.message).toContain("the model no-such-model");
          expect(h.received("session/prompt")).toHaveLength(0);
          expect(h.tags("session.started")).toHaveLength(0);
          yield* h.until("the process was stopped", () => h.fake.spawns[0]?.hasExited === true);
        }),
      {
        fake: {
          scripts: {
            "session/set_config_option": refuse(-32602, "Unknown model ID: no-such-model"),
          },
        },
      },
    ));

  it("fail the start, naming the level, when agy refuses the level", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          const failure = yield* Effect.flip(
            h.start({
              modelSelection: { model: "gemini-4-hydrogen", options: { effort: "ultra" } },
            }),
          );

          expect(failure._tag).toBe("AdapterFailed");
          expect(failure.message).toContain("the level ultra");
          expect(h.tags("session.started")).toHaveLength(0);
        }),
      { fake: { scripts: { "session/set_config_option": refuse(-32602, "Unknown level") } } },
    ));

  it("fail the start when agy does not answer in time", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          const starting = yield* startInFiber(h, {
            modelSelection: { model: "gemini-3.8-flash", options: {} },
          });
          yield* h.untilReceived("session/set_config_option");
          yield* TestClock.adjust(Duration.seconds(3));

          const failed = yield* Fiber.join(starting);
          expect(failed._tag).toBe("AdapterFailed");
          expect(failed.message).toContain("did not answer");
        }),
      { fake: { scripts: { "session/set_config_option": noAnswer } } },
    ));
});

describe("the confirmation of a model or level", () => {
  /**
   * A script for `session/set_config_option` whose reply holds the value that
   * `changed` returns for the option that was set. Returning undefined leaves
   * the option out of the reply, so the reply names nothing for it.
   */
  const answerWith =
    (changed: (params: { configId: string; value: string }) => string | undefined): HarnessScript =>
    (call, harness) => {
      const params = call.params as { configId: string; value: string };
      const lines = answerConfigChange("cancel")(call, harness);
      const result = (
        lines[0] as {
          result: { configOptions: Array<{ id: string; currentValue?: string }> };
        }
      ).result;
      const value = changed(params);
      result.configOptions = result.configOptions.flatMap((option) => {
        if (option.id !== params.configId) return [option];
        return value === undefined ? [] : [{ ...option, currentValue: value }];
      });
      return lines;
    };
  const FLASH = { model: "gemini-3.8-flash", options: {} };

  it("fails a start whose reply names another model", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          const failure = yield* Effect.flip(h.start({ modelSelection: FLASH }));

          expect(failure._tag).toBe("AdapterFailed");
          expect(h.tags("session.started")).toHaveLength(0);
        }),
      { fake: { scripts: { "session/set_config_option": answerWith(() => "gemini-4-hydrogen") } } },
    ));

  it("fails a start whose reply names no model", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          const failure = yield* Effect.flip(h.start({ modelSelection: FLASH }));

          expect(failure).toMatchObject({ _tag: "AdapterFailed" });
          expect(failure.message).toContain("did not confirm");
        }),
      { fake: { scripts: { "session/set_config_option": answerWith(() => undefined) } } },
    ));

  it("does not take a config_option_update as the confirmation", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          const failure = yield* Effect.flip(h.start({ modelSelection: FLASH }));

          expect(failure).toMatchObject({ _tag: "AdapterFailed" });
          expect(failure.message).toContain("did not confirm");
        }),
      {
        fake: {
          scripts: {
            "session/set_config_option": (call, harness) => {
              const [reply] = answerWith(() => undefined)(call, harness);
              const { configId, value } = call.params as { configId: string; value: string };
              const configOptions = [
                { id: configId, name: configId, type: "select", currentValue: value, options: [] },
              ];
              return [
                buildUpdate({ sessionUpdate: "config_option_update", configOptions }),
                reply!,
              ];
            },
          },
        },
      },
    ));

  it("sets the model again when agy reports by itself that it holds another one", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* h.start();
          const sameModel = { modelSelection: SPEC.modelSelection };

          h.harness().sendLine(
            JSON.stringify(
              buildUpdate({
                sessionUpdate: "config_option_update",
                configOptions: [
                  {
                    id: "model",
                    name: "Model",
                    category: "model",
                    type: "select",
                    currentValue: FLASH.model,
                    options: [{ value: FLASH.model, name: "Flash" }],
                  },
                ],
              }),
            ),
          );
          yield* Effect.promise(settle);
          yield* Effect.exit(h.adapter.sendInput(SESSION, buildInput("b", sameModel)));

          expect(
            h
              .received("session/set_config_option")
              .map((message) => (message.params as { configId: string }).configId),
          ).toEqual(["model"]);
        }),
      {
        fake: {
          recording: readRecordedSetup("cancel"),
          scripts: {
            "session/set_config_option": answerWith(({ value }) => value),
            "session/prompt": noAnswer,
          },
        },
      },
    ));

  it("refuses an input whose reply names the old model", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* h.start();

          const failure = yield* Effect.flip(
            h.adapter.sendInput(SESSION, buildInput("Hi.", { modelSelection: FLASH })),
          );

          expect(failure._tag).toBe("ModelChangeRefused");
          expect(h.received("session/prompt")).toHaveLength(0);
          expect(h.tags("turn.started")).toHaveLength(0);
        }),
      { fake: { scripts: { "session/set_config_option": answerWith(() => "gemini-4-hydrogen") } } },
    ));

  it("does not open an input whose reply names no model, and sets the model again on the next input", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* h.start();

          const failure = yield* Effect.flip(
            h.adapter.sendInput(SESSION, buildInput("a", { modelSelection: FLASH })),
          );
          expect(failure).toMatchObject({ _tag: "HarnessProtocolError" });
          expect(failure.message).toContain("did not confirm");
          const second = yield* Effect.flip(
            h.adapter.sendInput(SESSION, buildInput("b", { modelSelection: FLASH })),
          );

          expect(second._tag).toBe("HarnessProtocolError");
          expect(h.received("session/set_config_option")).toHaveLength(2);
          expect(h.received("session/prompt")).toHaveLength(0);
        }),
      { fake: { scripts: { "session/set_config_option": answerWith(() => undefined) } } },
    ));

  it("keeps a confirmed model when its level is then refused", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* h.start();
          const selection = { model: "gemini-3.8-flash", options: { effort: "low" } };

          const failure = yield* Effect.flip(
            h.adapter.sendInput(SESSION, buildInput("a", { modelSelection: selection })),
          );
          expect(failure._tag).toBe("ModelChangeRefused");
          yield* Effect.flip(
            h.adapter.sendInput(SESSION, buildInput("b", { modelSelection: selection })),
          );

          // The second input sets the level again, and not the model.
          expect(
            h
              .received("session/set_config_option")
              .map((message) => (message.params as { configId: string }).configId),
          ).toEqual(["model", "thought_level", "thought_level"]);
        }),
      {
        fake: {
          scripts: {
            "session/set_config_option": answerWith(({ configId, value }) =>
              configId === "thought_level" ? "high" : value,
            ),
          },
        },
      },
    ));
});

describe("the mode of a start", () => {
  const ACCEPT_EDITS: Partial<SessionSpec> = { accessMode: "auto-accept-edits" };
  const inUpdateOrder = {
    "before the reply": true,
    "after the reply": false,
  } as const;

  for (const [when, updateFirst] of Object.entries(inUpdateOrder)) {
    it(`is confirmed by agy's update ${when} to session/set_mode`, () =>
      run(
        (h) =>
          Effect.gen(function* () {
            yield* h.start(ACCEPT_EDITS);

            expect(h.received("session/set_mode")[0]?.params).toMatchObject({
              modeId: "accept-edits",
            });
            expect(h.tags("session.started")).toHaveLength(1);
          }),
        {
          fake: {
            scripts: {
              "session/set_mode": ({ id }) => {
                const reply: JsonRpcMessage = { jsonrpc: "2.0", id, result: {} };
                return updateFirst
                  ? [buildModeUpdate("accept-edits"), reply]
                  : [reply, buildModeUpdate("accept-edits")];
              },
            },
          },
        },
      ));
  }

  it("fails the start when a contrary mode update follows the confirming one before the reply", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          const starting = yield* startInFiber(h, ACCEPT_EDITS);
          yield* h.untilReceived("session/set_mode");
          yield* TestClock.adjust(Duration.seconds(5));

          expect(yield* Fiber.join(starting)).toMatchObject({ _tag: "AdapterFailed" });
          expect(h.tags("session.started")).toHaveLength(0);
        }),
      {
        fake: {
          scripts: {
            "session/set_mode": ({ id }) => [
              buildModeUpdate("accept-edits"),
              buildModeUpdate("plan"),
              { jsonrpc: "2.0", id, result: {} },
            ],
          },
        },
      },
    ));

  it("stops the session when agy leaves the mode right after the start confirmed it", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* h.start(ACCEPT_EDITS);

          h.harness().sendLine(JSON.stringify(buildModeUpdate("plan")));

          yield* h.until("the session exited", () => h.tags("session.exited").length === 1);
          expect(h.tags("session.exited")).toMatchObject([{ reason: "crash" }]);
        }),
      { fake: { scripts: { "session/set_mode": confirmMode("accept-edits") } } },
    ));

  it("takes a mode update that comes before the reply that opens the conversation", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* h.start(ACCEPT_EDITS);

          expect(h.received("session/set_mode")).toHaveLength(0);
          expect(h.tags("session.started")).toHaveLength(1);
        }),
      {
        fake: (home) => ({
          scripts: {
            "session/new": (call, harness) => [
              buildModeUpdate("accept-edits"),
              ...answerNewSession(home)(call, harness),
            ],
          },
        }),
      },
    ));

  /** A resume whose reply names `replyMode`, after `before` lines that come ahead of the reply. */
  const resumeIn = (replyMode: string, before: ReadonlyArray<JsonRpcMessage> = []) => ({
    fake: (home: string) => {
      createConversationFiles(home, CONVERSATION);
      return {
        scripts: {
          "session/resume": (call, harness) => {
            const lines = answerResume(home)(call, harness);
            const result = (lines[0] as { result: { modes?: { currentModeId: string } } }).result;
            if (result.modes !== undefined) result.modes.currentModeId = replyMode;
            return [...before, ...lines];
          },
        } satisfies Record<string, HarnessScript>,
      };
    },
  });
  const RESUME_ACCEPT_EDITS: Partial<SessionSpec> = {
    ...ACCEPT_EDITS,
    continue: { nativeSessionId: CONVERSATION, mode: "resume" },
  };

  it("sets the mode on a resume whose reply already names it, and starts", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* h.start(RESUME_ACCEPT_EDITS);

          expect(h.received("session/set_mode")[0]?.params).toMatchObject({
            modeId: "accept-edits",
          });
          expect(h.tags("session.started")).toHaveLength(1);
        }),
      resumeIn("accept-edits"),
    ));

  it("takes the reply's mode over an update before it, so a resume sets the asked mode", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* h.start(RESUME_ACCEPT_EDITS);

          expect(h.received("session/set_mode")[0]?.params).toMatchObject({
            modeId: "accept-edits",
          });
          expect(h.tags("session.started")).toHaveLength(1);
        }),
      {
        fake: (home) => {
          const { scripts } = resumeIn("default", [buildModeUpdate("accept-edits")]).fake(home);
          return { scripts: { ...scripts, "session/set_mode": confirmMode("accept-edits") } };
        },
      },
    ));

  it("sets nothing when agy is already in the mode", () =>
    run((h) =>
      Effect.gen(function* () {
        yield* h.start();

        expect(h.received("session/set_mode")).toHaveLength(0);
      }),
    ));

  const NOT_SWITCHED = "Antigravity did not switch to Auto-accept edits. Pick another access mode.";

  it("fails the start when agy does not offer the mode, and sets nothing", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          const failure = yield* Effect.flip(h.start(ACCEPT_EDITS));

          expect(failure).toMatchObject({ _tag: "AdapterFailed", message: NOT_SWITCHED });
          expect(h.received("session/set_mode")).toHaveLength(0);
          expect(h.tags("session.started")).toHaveLength(0);
        }),
      {
        fake: (home) => ({
          scripts: {
            "session/new": changeNewSession(home, (result) => {
              const modes = result["modes"] as { availableModes: Array<{ id: string }> };
              modes.availableModes = modes.availableModes.filter(
                (mode) => mode.id !== "accept-edits",
              );
            }),
          },
        }),
      },
    ));

  it("fails the start when agy lists no modes at all", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          const failure = yield* Effect.flip(h.start(ACCEPT_EDITS));

          expect(failure).toMatchObject({ _tag: "AdapterFailed", message: NOT_SWITCHED });
          expect(h.received("session/set_mode")).toHaveLength(0);
        }),
      {
        fake: (home) => ({
          scripts: {
            "session/new": changeNewSession(home, (result) => {
              delete result["modes"];
            }),
          },
        }),
      },
    ));

  it("fails the start, and prompts nothing, when agy does not confirm the mode in 5 seconds", () =>
    run((h) =>
      Effect.gen(function* () {
        const starting = yield* startInFiber(h, ACCEPT_EDITS);
        yield* h.untilReceived("session/set_mode");
        yield* TestClock.adjust(Duration.millis(4999));
        expect(starting.pollUnsafe()).toBeUndefined();
        yield* TestClock.adjust(Duration.millis(1));

        expect(yield* Fiber.join(starting)).toMatchObject({
          _tag: "AdapterFailed",
          message: NOT_SWITCHED,
        });
        expect(h.received("session/prompt")).toHaveLength(0);
        expect(h.tags("session.started")).toHaveLength(0);
      }),
    ));
});

describe("a turn", () => {
  it("runs a prompt and reports the turn, then takes the next input", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* h.start();

          const sent = yield* h.adapter.sendInput(SESSION, buildInput("Say hi."));

          expect(sent.delivery).toBe("opened");
          yield* h.until("the turn completed", () => h.tags("turn.completed").length === 1);
          expect(h.tags("turn.started")).toMatchObject([{ turnId: sent.turnId }]);
          expect(h.tags("turn.completed")).toMatchObject([
            { turnId: sent.turnId, state: "completed" },
          ]);
          expect(h.received("session/prompt")[0]?.params).toMatchObject({
            prompt: [{ type: "text", text: "Say hi." }],
          });
          const items = h.tags("item.completed");
          expect(items.some((event) => event.kind === "user_message")).toBe(true);
          expect(items.some((event) => event.kind === "assistant_message")).toBe(true);
        }),
      { fake: { recording: "bad-model" } },
    ));

  it("sends the images of an input after its text", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* h.start();
          const image = writeTestImage();

          yield* h.adapter.sendInput(SESSION, buildInput("Look.", { attachments: [image] }));
          yield* h.untilReceived("session/prompt");

          const prompt = h.received("session/prompt")[0]?.params as {
            prompt: Array<{ type: string; mimeType?: string }>;
          };
          expect(prompt.prompt.map((block) => block.type)).toEqual(["text", "image"]);
          expect(prompt.prompt[1]?.mimeType).toBe("image/png");
        }),
      { fake: { recording: "bad-model" } },
    ));

  it("refuses an input while a turn runs with SteerRefused, and prompts nothing for it", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* h.start();
          yield* h.adapter.sendInput(SESSION, buildInput());
          yield* h.untilReceived("session/prompt");

          const refused = yield* Effect.flip(h.adapter.sendInput(SESSION, buildInput("More.")));

          expect(refused._tag).toBe("SteerRefused");
          expect(h.received("session/prompt")).toHaveLength(1);
          expect(h.tags("turn.started")).toHaveLength(1);
        }),
      { fake: CANCEL_RECORDING, spec: { accessMode: "full-access" } },
    ));

  it("is interrupted with session/cancel and ends interrupted, and the session goes on", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* h.start();
          yield* h.adapter.sendInput(SESSION, buildInput());
          yield* h.until("a call started", () =>
            h.tags("item.started").some((event) => event.kind !== "user_message"),
          );

          yield* h.adapter.interrupt(SESSION);

          yield* h.until("the turn completed", () => h.tags("turn.completed").length === 1);
          expect(h.tags("turn.completed")).toMatchObject([{ state: "interrupted" }]);
          expect(h.received("session/cancel")).toHaveLength(1);
          expect(h.tags("session.exited")).toHaveLength(0);
          expect(yield* h.adapter.listSessions).toHaveLength(1);
        }),
      { fake: CANCEL_RECORDING, spec: { accessMode: "full-access" } },
    ));

  it("sends no cancel for an interrupt when no turn runs", () =>
    run((h) =>
      Effect.gen(function* () {
        yield* h.start();

        yield* h.adapter.interrupt(SESSION);
        yield* h.adapter.interrupt(SESSION, "a-subagent");

        expect(h.received("session/cancel")).toHaveLength(0);
      }),
    ));

  it("ends agy's process when it does not answer an interrupt in 5 seconds", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* h.start();
          yield* h.adapter.sendInput(SESSION, buildInput());
          yield* h.untilReceived("session/prompt");

          const interrupting = yield* Effect.forkChild(h.adapter.interrupt(SESSION));
          yield* h.untilReceived("session/cancel");
          yield* TestClock.adjust(Duration.seconds(5));
          yield* Fiber.join(interrupting);
          yield* h.until("the session exited", () => h.tags("session.exited").length === 1);

          expect(h.tags("runtime.error")).toMatchObject([
            { message: "Antigravity did not stop, so Hercule ended its process." },
          ]);
          expect(h.tags("turn.completed")).toMatchObject([{ state: "interrupted" }]);
          expect(h.tags("session.exited")).toMatchObject([{ reason: "process_exit" }]);
          expect(h.fake.spawns[0]?.hasExited).toBe(true);
          // The session is gone, so the next input is refused.
          const next = yield* Effect.flip(h.adapter.sendInput(SESSION, buildInput()));
          expect(next._tag).toBe("SessionNotRunning");
        }),
      { fake: { recording: readRecordedSetup("cancel"), scripts: { "session/prompt": noAnswer } } },
    ));

  it("fails the input with ModelChangeRefused when agy refuses the new model, and the session goes on", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* h.start();

          const failure = yield* Effect.flip(
            h.adapter.sendInput(
              SESSION,
              buildInput("Hi.", {
                modelSelection: { model: "no-such-model", options: {} },
              }),
            ),
          );

          expect(failure._tag).toBe("ModelChangeRefused");
          expect(h.received("session/prompt")).toHaveLength(0);
          expect(h.tags("turn.started")).toHaveLength(0);
          // The model the session had is still the one asked for, so the next input needs no change.
          const sent = yield* h.adapter.sendInput(
            SESSION,
            buildInput("Hi.", {
              modelSelection: SPEC.modelSelection,
            }),
          );
          expect(sent.delivery).toBe("opened");
          expect(h.received("session/set_config_option")).toHaveLength(1);
        }),
      {
        fake: {
          recording: "bad-model",
          scripts: {
            "session/set_config_option": refuse(-32602, "Unknown model ID: no-such-model"),
          },
        },
      },
    ));

  it("sets the model again on the next input when agy did not answer the first change", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* h.start();
          const flash = { model: "gemini-3.8-flash", options: { effort: "low" } };

          const first = yield* Effect.forkChild(
            Effect.flip(h.adapter.sendInput(SESSION, buildInput("a", { modelSelection: flash }))),
          );
          yield* h.untilReceived("session/set_config_option");
          yield* TestClock.adjust(Duration.seconds(3));
          expect(yield* Fiber.join(first)).toMatchObject({ _tag: "HarnessProtocolError" });
          expect(h.tags("turn.started")).toHaveLength(0);
          expect(yield* h.adapter.listSessions).toHaveLength(1);

          // What agy holds is unknown now, so the next input sets the model again.
          const second = yield* h.adapter.sendInput(
            SESSION,
            buildInput("b", { modelSelection: flash }),
          );

          expect(second.delivery).toBe("opened");
          expect(
            h
              .received("session/set_config_option")
              .map((message) => (message.params as { configId: string }).configId),
          ).toEqual(["model", "model", "thought_level"]);
        }),
      {
        fake: {
          recording: "bad-model",
          scripts: {
            "session/set_config_option": (call, harness) =>
              ++configCalls === 1 ? [] : answerConfigChange("bad-model")(call, harness),
          },
        },
      },
    ));
});

describe("approvals and questions", () => {
  it("allows every call of a turn that asks four times", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* h.start();
          yield* h.adapter.sendInput(SESSION, buildInput());

          for (let asked = 1; asked <= 4; asked += 1) {
            yield* h.until("a request opened", () => h.tags("request.opened").length === asked);
            yield* h.adapter.respondToApprovalRequest(
              SESSION,
              h.tags("request.opened")[asked - 1]!.request.requestId,
              "allow",
            );
          }

          yield* h.until("the turn completed", () => h.tags("turn.completed").length === 1);
          expect(h.tags("turn.completed")).toMatchObject([{ state: "completed" }]);
          expect(
            h
              .tags("request.resolved")
              .map((event) => ("decision" in event ? event.decision : undefined)),
          ).toEqual(["allow", "allow", "allow", "allow"]);
        }),
      { fake: { recording: "edit-shell" } },
    ));

  it("tells the model when a call is denied, and the turn goes on", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* h.start();
          yield* h.adapter.sendInput(SESSION, buildInput());
          yield* h.until("a request opened", () => h.tags("request.opened").length === 1);

          yield* h.adapter.respondToApprovalRequest(
            SESSION,
            h.tags("request.opened")[0]!.request.requestId,
            "deny",
          );

          yield* h.until("the turn completed", () => h.tags("turn.completed").length === 1);
          expect(h.tags("request.resolved")).toMatchObject([{ decision: "deny" }]);
          expect(h.tags("turn.completed")).toMatchObject([{ state: "completed" }]);
          const prompts = h
            .received("session/prompt")
            .map(
              (message) => (message.params as { prompt: Array<{ text: string }> }).prompt[0]?.text,
            );
          expect(prompts).toHaveLength(2);
          expect(prompts[1]).toContain("The user denied your last tool call");
        }),
      { fake: { recording: "deny2", scripts: { "session/prompt": answerEndTurn } } },
    ));

  it("delivers the answer to a question", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* h.start();
          yield* h.adapter.sendInput(SESSION, buildInput());
          yield* h.until("a question opened", () => h.tags("request.opened").length === 1);
          const opened = h.tags("request.opened")[0]!.request;

          yield* h.adapter.respondToQuestion(
            SESSION,
            opened.requestId,
            { Question: "Green" },
            SPEC.modelSelection,
          );

          yield* h.until("the turn completed", () => h.tags("turn.completed").length === 1);
          expect(h.tags("request.resolved")).toMatchObject([{ answers: { Question: "Green" } }]);
          expect(h.tags("turn.completed")).toMatchObject([{ state: "completed" }]);
        }),
      { fake: { recording: "question-elicit" } },
    ));

  it("fails an answer when no question is open", () =>
    run((h) =>
      Effect.gen(function* () {
        yield* h.start();

        const failure = yield* Effect.flip(
          h.adapter.respondToQuestion(
            SESSION,
            "request-1",
            { Question: "Green" },
            SPEC.modelSelection,
          ),
        );

        expect(failure._tag).toBe("AnswerNotDelivered");
      }),
    ));

  it("cancels an approval that no running turn owns, and warns", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* h.start();

          h.harness().sendLine(
            JSON.stringify({
              jsonrpc: "2.0",
              id: "jetski-acp-front:9",
              method: "session/request_permission",
              params: {
                sessionId: CONVERSATION,
                toolCall: { toolCallId: "call-unknown", name: "run_command", status: "pending" },
                options: [
                  { optionId: "allow", name: "Allow", kind: "allow_once" },
                  { optionId: "deny", name: "Deny", kind: "reject_once" },
                ],
              },
            }),
          );

          yield* h.until("the request was answered", () =>
            h.harness().received.some((message) => message.id === "jetski-acp-front:9"),
          );
          expect(
            h.harness().received.find((message) => message.id === "jetski-acp-front:9")?.result,
          ).toEqual({ outcome: { outcome: "cancelled" } });
          expect(h.tags("request.opened")).toHaveLength(0);
          expect(h.tags("runtime.warning")).toHaveLength(1);
        }),
      { fake: { recording: readRecordedSetup("cancel") } },
    ));
});

describe("what agy sends that does not belong to the session", () => {
  it("drops an update of another conversation", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* h.start();

          h.harness().sendLine(
            JSON.stringify(
              buildUpdate(
                { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hi." } },
                "another-conversation",
              ),
            ),
          );
          yield* Effect.promise(settle);

          expect(h.seen.map((event) => event._tag)).toEqual(["session.started"]);
        }),
      { fake: { recording: readRecordedSetup("cancel") } },
    ));

  it("stops the session as crashed when agy changes its own mode", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* h.start();

          h.harness().sendLine(JSON.stringify(buildModeUpdate("auto")));

          yield* h.until("the session exited", () => h.tags("session.exited").length === 1);
          expect(h.tags("runtime.error")).toMatchObject([
            {
              message:
                "Antigravity changed its own permission mode from default to auto, so Hercule stopped it.",
            },
          ]);
          expect(h.tags("session.exited")).toMatchObject([{ reason: "crash" }]);
          expect(h.fake.spawns[0]?.hasExited).toBe(true);
          expect(yield* h.adapter.listSessions).toEqual([]);
        }),
      { fake: { recording: readRecordedSetup("cancel") } },
    ));
});

describe("the end of a session", () => {
  it("is reported with the reason of the stop, after the process is gone", () =>
    run((h) =>
      Effect.gen(function* () {
        yield* h.start();

        yield* h.adapter.stopSession(SESSION, "idle_unload");

        expect(h.tags("session.exited")).toMatchObject([
          { sessionId: SESSION, reason: "idle_unload" },
        ]);
        expect(h.fake.spawns[0]?.hasExited).toBe(true);
        expect(yield* h.adapter.listSessions).toEqual([]);
        // A second stop has nothing left to do, and the first reason stays.
        yield* h.adapter.stopSession(SESSION, "stopped");
        expect(h.tags("session.exited")).toHaveLength(1);
      }),
    ));

  it("ends the running turn as interrupted before it reports the exit", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* h.start();
          yield* h.adapter.sendInput(SESSION, buildInput());
          yield* h.until("a call started", () =>
            h.tags("item.started").some((event) => event.kind !== "user_message"),
          );

          yield* h.adapter.stopSession(SESSION, "stopped");

          const order = h.seen
            .filter((event) => event._tag === "turn.completed" || event._tag === "session.exited")
            .map((event) => event._tag);
          expect(order).toEqual(["turn.completed", "session.exited"]);
          expect(h.tags("turn.completed")).toMatchObject([{ state: "interrupted" }]);
          expect(h.received("session/cancel")).toHaveLength(0);
        }),
      { fake: CANCEL_RECORDING, spec: { accessMode: "full-access" } },
    ));

  it("is reported as a process exit when agy dies mid-turn, and the turn fails", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* h.start();
          yield* h.adapter.sendInput(SESSION, buildInput());
          yield* h.until("a call started", () =>
            h.tags("item.started").some((event) => event.kind !== "user_message"),
          );

          h.harness().kill();

          yield* h.until("the session exited", () => h.tags("session.exited").length === 1);
          expect(h.tags("turn.completed")).toMatchObject([{ state: "failed" }]);
          expect(h.tags("session.exited")).toMatchObject([{ reason: "process_exit" }]);
          // The call that never answered is closed too.
          expect(
            h.tags("item.completed").filter((event) => event.status === "failed"),
          ).toHaveLength(1);
          const next = yield* Effect.flip(h.adapter.sendInput(SESSION, buildInput()));
          expect(next._tag).toBe("SessionNotRunning");
        }),
      { fake: CANCEL_RECORDING, spec: { accessMode: "full-access" } },
    ));

  it("fails a start whose process dies before it is ready, with no event", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          const failure = yield* Effect.flip(h.start());

          expect(failure._tag).toBe("AdapterFailed");
          expect(h.seen).toEqual([]);
          expect(yield* h.adapter.listSessions).toEqual([]);
        }),
      {
        fake: {
          scripts: {
            "session/new": (_call, harness) => {
              harness.end();
              return [];
            },
          },
        },
      },
    ));
});

describe("an interrupt with no input running", () => {
  it("cancels and ends the synthetic turn of output that came with no prompt", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* h.start();
          h.harness().sendLine(
            JSON.stringify(
              buildUpdate({
                sessionUpdate: "tool_call",
                toolCallId: "call-bg",
                name: "run_command",
                kind: "execute",
                status: "in_progress",
                rawInput: { CommandLine: "sleep 90" },
              }),
            ),
          );
          yield* h.until("a synthetic turn opened", () => h.tags("turn.started").length === 1);

          yield* h.adapter.interrupt(SESSION);

          yield* h.untilReceived("session/cancel");
          expect(h.tags("turn.completed")).toMatchObject([{ state: "interrupted" }]);
        }),
      { fake: { recording: readRecordedSetup("cancel") } },
    ));
});

describe("a start that is interrupted", () => {
  it("does not hold the session id", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          const starting = yield* Effect.forkChild(h.start());
          yield* h.untilReceived("session/new");
          yield* Fiber.interrupt(starting);

          // The id is free again: a second start runs, instead of failing with SessionAlreadyRunning.
          const second = yield* Effect.forkChild(Effect.flip(h.start()));
          yield* h.until("a second process started", () => h.fake.spawns.length === 2);
          yield* Fiber.interrupt(second);
        }),
      { fake: { scripts: { "session/new": noAnswer } } },
    ));
});

describe("the sessions of the adapter", () => {
  it("lists live sessions only, and refuses a second start of the same session id", () =>
    run((h) =>
      Effect.gen(function* () {
        const binding = yield* h.start();

        const second = yield* Effect.flip(h.start());

        expect(second._tag).toBe("SessionAlreadyRunning");
        expect(h.fake.spawns).toHaveLength(1);
        expect(yield* h.adapter.listSessions).toEqual([binding]);
        yield* h.adapter.stopSession(SESSION, "stopped");
        expect(yield* h.adapter.listSessions).toEqual([]);
        // Once the session has exited, its id can start again.
        yield* h.start();
        expect(h.fake.spawns).toHaveLength(2);
      }),
    ));
});

// ---- Scripts these tests need besides the fake's defaults ----

/** Answers a follow-up prompt with the end of its turn. */
const answerEndTurn: HarnessScript = ({ id }) => [
  { jsonrpc: "2.0", id, result: { stopReason: "end_turn" } },
];

describe("a Request and the end of its turn", () => {
  const isAccept = (message: JsonRpcMessage) =>
    (message as { result?: { action?: string } }).result?.action === "accept";

  it("gives the first Request of a resumed session an id that differs from the earlier one", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          const binding = yield* h.start();
          yield* h.adapter.sendInput(SESSION, buildInput());
          yield* h.until("a question opened", () => h.tags("request.opened").length === 1);
          yield* h.adapter.stopSession(SESSION, "stopped");

          yield* h.start({
            continue: { nativeSessionId: binding.nativeSessionId, mode: "resume" },
          });
          yield* h.adapter.sendInput(SESSION, buildInput("Again."));
          yield* h.until("a second question opened", () => h.tags("request.opened").length === 2);

          const [first, second] = h.tags("request.opened");
          expect(first?.harnessRefs?.["acpRequestId"]).toBe(second?.harnessRefs?.["acpRequestId"]);
          expect(first?.request.requestId).not.toBe(second?.request.requestId);
        }),
      { fake: { recording: "question-elicit" } },
    ));

  it("refuses a new input until turn.completed was emitted, after request.resolved", () =>
    Effect.gen(function* () {
      const gate = Promise.withResolvers<void>();
      yield* Effect.promise(() =>
        run(
          (h) =>
            Effect.gen(function* () {
              yield* h.start();
              yield* h.adapter.sendInput(SESSION, buildInput());
              yield* h.until("a question opened", () => h.tags("request.opened").length === 1);
              const answering = yield* Effect.forkChild(
                h.adapter.respondToQuestion(
                  SESSION,
                  h.tags("request.opened")[0]!.request.requestId,
                  { Question: "Red" },
                  SPEC.modelSelection,
                ),
              );
              yield* h.until(
                "the prompt was answered",
                () => h.received("session/prompt").length === 1,
              );
              yield* Effect.promise(settle);

              const refused = yield* Effect.flip(h.adapter.sendInput(SESSION, buildInput("More.")));
              expect(refused._tag).toBe("SteerRefused");
              expect(h.tags("turn.started")).toHaveLength(1);

              gate.resolve();
              yield* Fiber.join(answering);
              yield* h.until("the turn completed", () => h.tags("turn.completed").length === 1);
              expect(h.tags("turn.completed")).toHaveLength(1);
              expect(
                h.seen
                  .filter((e) => e._tag === "request.resolved" || e._tag === "turn.completed")
                  .map((e) => e._tag),
              ).toEqual(["request.resolved", "turn.completed"]);
            }),
          {
            fake: { recording: "question-elicit" },
            holdAcknowledgement: (message) => (isAccept(message) ? gate.promise : undefined),
          },
        ),
      );
    }).pipe(Effect.runPromise));
});

describe("an input that is interrupted while it is prepared", () => {
  it("writes no config change when the interrupt came during the reading of an image", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* h.start();
          const image = writeTestImage();

          const sending = yield* Effect.forkChild(
            Effect.flip(
              h.adapter.sendInput(
                SESSION,
                buildInput("Look.", {
                  attachments: [image],
                  modelSelection: { model: "gemini-3.8-flash", options: {} },
                }),
              ),
            ),
          );
          yield* Effect.yieldNow;
          yield* h.adapter.interrupt(SESSION);

          expect((yield* Fiber.join(sending))._tag).toBe("InputNotDelivered");
          expect(h.received("session/set_config_option")).toHaveLength(0);
          expect(h.received("session/prompt")).toHaveLength(0);
        }),
      { fake: { recording: "bad-model" } },
    ));
});

describe("a session that cannot turn automatic compaction off", () => {
  const WARNING =
    "Antigravity compacts its context by itself, and Hercule cannot turn that off or see it.";

  it("warns once at its first start", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* h.start({ autoCompaction: false });

          expect(h.tags("runtime.warning")).toMatchObject([{ message: WARNING }]);
        }),
      { fake: { recording: readRecordedSetup("cancel") } },
    ));

  it("does not warn when the session is resumed", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* h.start({
            autoCompaction: false,
            continue: { nativeSessionId: CONVERSATION, mode: "resume" },
          });

          expect(h.tags("runtime.warning")).toEqual([]);
        }),
      {
        fake: (home) => {
          createConversationFiles(home, CONVERSATION);
          return { recording: readRecordedSetup("cancel") };
        },
      },
    ));

  it("does not warn a session that allows compaction", () =>
    run((h) =>
      Effect.gen(function* () {
        yield* h.start();

        expect(h.tags("runtime.warning")).toEqual([]);
      }),
    ));
});

describe("the write of the first prompt of an input", () => {
  const isPrompt = (message: JsonRpcMessage) => message.method === "session/prompt";

  it("fails the input with InputNotDelivered, and opens no turn, when the write failed", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* h.start();

          const failure = yield* Effect.flip(h.adapter.sendInput(SESSION, buildInput()));

          expect(failure._tag).toBe("InputNotDelivered");
          expect(h.tags("turn.started")).toEqual([]);
          expect(h.tags("turn.completed")).toEqual([]);
          // The place of the input is free again.
          const next = yield* Effect.flip(h.adapter.sendInput(SESSION, buildInput("Again.")));
          expect(next._tag).toBe("InputNotDelivered");
        }),
      {
        fake: { recording: readRecordedSetup("cancel"), scripts: { "session/prompt": noAnswer } },
        holdAcknowledgement: (message) =>
          isPrompt(message) ? Promise.reject(new Error("stdin is closed")) : undefined,
      },
    ));

  it("fails the input with HarnessProtocolError when the write is still pending after the budget, and ends the process so no second prompt follows", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* h.start();

          const sending = yield* Effect.forkChild(
            Effect.flip(h.adapter.sendInput(SESSION, buildInput())),
          );
          yield* h.untilReceived("session/prompt");
          yield* TestClock.adjust(Duration.seconds(8));

          expect(yield* Fiber.join(sending)).toMatchObject({ _tag: "HarnessProtocolError" });
          expect(h.tags("turn.started")).toEqual([]);
          yield* h.until("the session exited", () => h.tags("session.exited").length === 1);
          expect(h.tags("runtime.error")).toMatchObject([{ class: "delivery_unknown" }]);
          expect(h.tags("session.exited")).toMatchObject([{ reason: "crash" }]);
          const next = yield* Effect.flip(h.adapter.sendInput(SESSION, buildInput("Second.")));
          expect(next._tag).not.toBe("InputNotDelivered");
          expect(h.received("session/prompt")).toHaveLength(1);
        }),
      {
        fake: { recording: readRecordedSetup("cancel"), scripts: { "session/prompt": noAnswer } },
        holdAcknowledgement: (message) => (isPrompt(message) ? new Promise(() => {}) : undefined),
      },
    ));

  it("fails the input with HarnessProtocolError when the connection ends while the write is pending", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* h.start();

          const sending = yield* Effect.forkChild(
            Effect.flip(h.adapter.sendInput(SESSION, buildInput())),
          );
          yield* h.untilReceived("session/prompt");
          h.harness().end();

          expect(yield* Fiber.join(sending)).toMatchObject({ _tag: "HarnessProtocolError" });
        }),
      {
        fake: { recording: readRecordedSetup("cancel"), scripts: { "session/prompt": noAnswer } },
        holdAcknowledgement: (message) => (isPrompt(message) ? new Promise(() => {}) : undefined),
      },
    ));

  it("ends the process when the caller is interrupted while the write is pending, so no second prompt follows", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* h.start();

          const sending = yield* Effect.forkChild(h.adapter.sendInput(SESSION, buildInput()));
          yield* h.untilReceived("session/prompt");
          yield* Fiber.interrupt(sending);

          yield* h.until("the session exited", () => h.tags("session.exited").length === 1);
          yield* Effect.flip(h.adapter.sendInput(SESSION, buildInput("Second.")));
          expect(h.received("session/prompt")).toHaveLength(1);
        }),
      {
        fake: { recording: readRecordedSetup("cancel"), scripts: { "session/prompt": noAnswer } },
        holdAcknowledgement: (message) => (isPrompt(message) ? new Promise(() => {}) : undefined),
      },
    ));

  it("sends no prompt when an interrupt came while the level was changed", () => {
    let levelReply: ReturnType<HarnessScript>[number] | undefined;
    return run(
      (h) =>
        Effect.gen(function* () {
          yield* h.start();
          const sending = yield* Effect.forkChild(
            Effect.flip(
              h.adapter.sendInput(
                SESSION,
                buildInput("Work.", {
                  modelSelection: { model: SPEC.modelSelection.model, options: { effort: "low" } },
                }),
              ),
            ),
          );
          yield* h.until("the level change was received", () => levelReply !== undefined);
          yield* h.adapter.interrupt(SESSION);
          h.harness().sendLine(JSON.stringify(levelReply));

          expect((yield* Fiber.join(sending))._tag).toBe("InputNotDelivered");
          expect(h.received("session/prompt")).toHaveLength(0);
        }),
      {
        fake: {
          scripts: {
            // The reply is held back, so the test can interrupt before it arrives.
            "session/set_config_option": (call, harness) => {
              levelReply = answerConfigChange("cancel")(call, harness)[0];
              return [];
            },
          },
        },
      },
    );
  });
});

describe("a Request that comes while the prompt is handed over", () => {
  const isPrompt = (message: JsonRpcMessage) => message.method === "session/prompt";

  it("is presented in the Turn the input opens, after the turn's own start and message", () => {
    const acknowledged = Promise.withResolvers<void>();
    return run(
      (h) =>
        Effect.gen(function* () {
          yield* h.start();
          const sending = yield* Effect.forkChild(
            h.adapter.sendInput(SESSION, buildInput("Ask a question.")),
          );
          yield* h.untilReceived("session/prompt");
          yield* Effect.promise(settle);
          acknowledged.resolve();
          yield* Fiber.join(sending);
          yield* h.until("the question opened", () => h.tags("request.opened").length === 1);

          expect(h.tags("runtime.warning")).toEqual([]);
          const order = h.seen.map((event) => event._tag);
          expect(order.indexOf("request.opened")).toBeGreaterThan(order.indexOf("turn.started"));
          expect(h.received("elicitation/create")).toEqual([]);
        }),
      {
        fake: { recording: "question-elicit" },
        holdAcknowledgement: (message) => (isPrompt(message) ? acknowledged.promise : undefined),
      },
    );
  });

  it("is cancelled with a warning when the input is refused", () => {
    const acknowledged = Promise.withResolvers<void>();
    return run(
      (h) =>
        Effect.gen(function* () {
          yield* h.start();
          const sending = yield* Effect.forkChild(
            Effect.flip(h.adapter.sendInput(SESSION, buildInput("Ask a question."))),
          );
          yield* h.untilReceived("session/prompt");
          yield* Effect.promise(settle);
          acknowledged.reject(new Error("stdin is closed"));

          expect((yield* Fiber.join(sending))._tag).toBe("InputNotDelivered");
          yield* h.until("the warning", () => h.tags("runtime.warning").length === 1);
          expect(h.tags("request.opened")).toEqual([]);
        }),
      {
        fake: { recording: "question-elicit" },
        holdAcknowledgement: (message) => (isPrompt(message) ? acknowledged.promise : undefined),
      },
    );
  });
});

describe("an input whose prompt is handed over slowly", () => {
  const isPrompt = (message: JsonRpcMessage) => message.method === "session/prompt";

  it("draws the user's message before the output that came meanwhile", () => {
    const acknowledged = Promise.withResolvers<void>();
    return run(
      (h) =>
        Effect.gen(function* () {
          yield* h.start();
          const sending = yield* Effect.forkChild(h.adapter.sendInput(SESSION, buildInput("Hi.")));
          yield* h.untilReceived("session/prompt");
          yield* Effect.promise(settle);
          acknowledged.resolve();
          yield* Fiber.join(sending);

          expect(h.tags("item.started").map((event) => event.kind)).toEqual([
            "user_message",
            "assistant_message",
          ]);
        }),
      {
        fake: {
          recording: readRecordedSetup("cancel"),
          scripts: {
            "session/prompt": () => [
              buildUpdate({
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "Hello." },
              }),
            ],
          },
        },
        holdAcknowledgement: (message) => (isPrompt(message) ? acknowledged.promise : undefined),
      },
    );
  });

  it("opens the Turn, and ends it interrupted, when a stop comes while the handoff is proven", () => {
    const acknowledged = Promise.withResolvers<void>();
    return run(
      (h) =>
        Effect.gen(function* () {
          yield* h.start();
          const sending = yield* Effect.forkChild(h.adapter.sendInput(SESSION, buildInput("Hi.")));
          yield* h.untilReceived("session/prompt");
          yield* Effect.promise(settle);
          acknowledged.resolve();
          Effect.runFork(h.adapter.stopSession(SESSION, "stopped"));

          expect(yield* Fiber.join(sending)).toMatchObject({ delivery: "opened" });
          yield* h.until("the session exited", () => h.tags("session.exited").length === 1);
          const order = h.seen.map((event) => event._tag);
          expect(order.indexOf("turn.completed")).toBeLessThan(order.indexOf("session.exited"));
          expect(h.tags("turn.completed")).toMatchObject([{ state: "interrupted" }]);
        }),
      {
        fake: { recording: readRecordedSetup("cancel"), scripts: { "session/prompt": noAnswer } },
        holdAcknowledgement: (message) => (isPrompt(message) ? acknowledged.promise : undefined),
      },
    );
  });
});

describe("the output that comes while a prompt is handed over, with a synthetic turn open", () => {
  const isPrompt = (message: JsonRpcMessage) => message.method === "session/prompt";
  const buildCall = (toolCallId: string, status: string) =>
    JSON.stringify(
      buildUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId,
        name: "run_command",
        kind: "execute",
        status,
        rawInput: { CommandLine: "ls" },
      }),
    );

  it("holds a new call for the input's turn, and completes an earlier call in its own turn", () => {
    const acknowledged = Promise.withResolvers<void>();
    return run(
      (h) =>
        Effect.gen(function* () {
          yield* h.start();
          h.harness().sendLine(buildCall("call-early", "in_progress"));
          yield* h.until("a synthetic turn opened", () => h.tags("turn.started").length === 1);
          const syntheticTurnId = h.tags("turn.started")[0]!.turnId;

          const sending = yield* Effect.forkChild(h.adapter.sendInput(SESSION, buildInput("Hi.")));
          yield* h.untilReceived("session/prompt");
          h.harness().sendLine(buildCall("call-new", "in_progress"));
          h.harness().sendLine(buildCall("call-early", "completed"));
          yield* Effect.promise(settle);
          expect(h.tags("item.started"), "the new call waits for the input's turn").toHaveLength(1);
          acknowledged.resolve();
          const { turnId } = (yield* Fiber.join(sending)) as { turnId: string };

          const started = h.tags("item.started");
          expect(started.map((event) => [event.turnId, event.kind])).toEqual([
            [syntheticTurnId, "command_execution"],
            [turnId, "user_message"],
            [turnId, "command_execution"],
          ]);
          expect(
            h.tags("item.completed").filter((event) => event.kind === "command_execution"),
          ).toMatchObject([{ turnId: syntheticTurnId, itemId: started[0]!.itemId }]);
        }),
      {
        fake: { recording: readRecordedSetup("cancel"), scripts: { "session/prompt": noAnswer } },
        holdAcknowledgement: (message) => (isPrompt(message) ? acknowledged.promise : undefined),
      },
    );
  });
});

describe("the output that comes while an input is prepared", () => {
  it("is held for the input's turn, so no synthetic turn opens before the prompt is handed off", () => {
    let levelReply: ReturnType<HarnessScript>[number] | undefined;
    return run(
      (h) =>
        Effect.gen(function* () {
          yield* h.start();
          const sending = yield* Effect.forkChild(
            h.adapter.sendInput(
              SESSION,
              buildInput("Work.", {
                modelSelection: { model: SPEC.modelSelection.model, options: { effort: "low" } },
              }),
            ),
          );
          yield* h.until("the level change was received", () => levelReply !== undefined);
          h.harness().sendLine(
            JSON.stringify(
              buildUpdate({
                sessionUpdate: "tool_call_update",
                toolCallId: "call-new",
                name: "run_command",
                kind: "execute",
                status: "in_progress",
                rawInput: { CommandLine: "ls" },
              }),
            ),
          );
          yield* Effect.promise(settle);
          expect(h.tags("turn.started"), "no turn opens during the preparation").toHaveLength(0);

          h.harness().sendLine(JSON.stringify(levelReply));
          const { turnId } = (yield* Fiber.join(sending)) as { turnId: string };

          expect(h.tags("item.started").map((event) => [event.turnId, event.kind])).toEqual([
            [turnId, "user_message"],
            [turnId, "command_execution"],
          ]);
        }),
      {
        fake: {
          recording: readRecordedSetup("cancel"),
          scripts: {
            "session/prompt": noAnswer,
            "session/set_config_option": (call, harness) => {
              levelReply = answerConfigChange("cancel")(call, harness)[0];
              return [];
            },
          },
        },
      },
    );
  });
});

describe("a synthetic turn that agy leaves open", () => {
  const CHUNK = buildUpdate({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "Hello." },
  });

  it("completes after 10 seconds without an update, and each update starts the wait again", () =>
    run((h) =>
      Effect.gen(function* () {
        yield* h.start();
        h.harness().sendLine(JSON.stringify(CHUNK));
        yield* h.until("a synthetic turn opened", () => h.tags("turn.started").length === 1);

        yield* TestClock.adjust(Duration.seconds(9));
        h.harness().sendLine(JSON.stringify(CHUNK));
        yield* Effect.promise(settle);
        yield* TestClock.adjust(Duration.seconds(9));
        expect(h.tags("turn.completed"), "the second chunk started the wait again").toHaveLength(0);

        yield* TestClock.adjust(Duration.seconds(1));
        expect(h.tags("turn.completed")).toMatchObject([{ state: "completed" }]);
      }),
    ));
});

describe("the output that comes before a start is ready", () => {
  const CHUNK = buildUpdate({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "Startup output." },
  });
  const FLASH = { model: "gemini-3.8-flash", options: {} };

  it("is published nowhere when the start fails", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* Effect.flip(h.start({ modelSelection: FLASH }));
          yield* Effect.promise(settle);

          expect(h.seen).toEqual([]);
        }),
      {
        fake: {
          scripts: {
            "session/set_config_option": ({ id }) => [
              CHUNK,
              { jsonrpc: "2.0", id, error: { code: -32602, message: "Unknown model" } },
            ],
          },
        },
      },
    ));

  it("is published after session.started, as output with no input, when the start succeeds", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* h.start({ modelSelection: FLASH });
          yield* h.until("the output", () => h.tags("item.started").length === 1);

          expect(h.seen.map((event) => event._tag)[0]).toBe("session.started");
          expect(h.tags("item.started")).toMatchObject([{ kind: "assistant_message" }]);
        }),
      {
        fake: {
          scripts: {
            "session/set_config_option": (call, harness) => [
              CHUNK,
              ...answerConfigChange("cancel")(call, harness),
            ],
          },
        },
      },
    ));
});

describe("the mode that agy reports as a config option", () => {
  const buildModeOptionUpdate = (modeId: string) =>
    buildUpdate({
      sessionUpdate: "config_option_update",
      configOptions: [
        { id: "mode", name: "Mode", type: "select", currentValue: modeId, options: [] },
      ],
    });

  it("does not stop the session for a notification that names a stale mode", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* h.start();

          // As in modes.jsonl: the notification names the mode before the one just set.
          h.harness().sendLine(JSON.stringify(buildModeOptionUpdate("accept-edits")));
          h.harness().sendLine(JSON.stringify(buildModeUpdate("default")));
          yield* Effect.promise(settle);

          expect(h.tags("runtime.error")).toEqual([]);
          expect(h.tags("session.exited")).toEqual([]);
        }),
      { fake: { recording: readRecordedSetup("cancel") } },
    ));

  it("stops the session when the reply to a change of the model reports another mode", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* h.start();

          yield* Effect.exit(
            h.adapter.sendInput(
              SESSION,
              buildInput("Hi.", { modelSelection: { model: "gemini-3.8-flash", options: {} } }),
            ),
          );

          yield* h.until("the session exited", () => h.tags("session.exited").length === 1);
          expect(h.tags("runtime.error")).toMatchObject([{ class: "mode_changed" }]);
        }),
      {
        fake: {
          recording: readRecordedSetup("cancel"),
          scripts: {
            "session/set_config_option": (call, harness) => {
              const lines = answerConfigChange("cancel")(call, harness);
              const result = (lines[0] as { result: { configOptions: Array<{ id: string }> } })
                .result;
              result.configOptions = result.configOptions.map((option) =>
                option.id === "mode" ? { ...option, currentValue: "accept-edits" } : option,
              );
              return lines;
            },
          },
        },
      },
    ));

  it("writes the mode in the message with control characters escaped", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* h.start();

          h.harness().sendLine(JSON.stringify(buildModeUpdate("evil\nmode")));

          yield* h.until("the session exited", () => h.tags("session.exited").length === 1);
          const [error] = h.tags("runtime.error");
          expect(error?.message).toContain("evil\\u{a}mode");
          expect(error?.message).not.toContain("\n");
        }),
      { fake: { recording: readRecordedSetup("cancel") } },
    ));
});

describe("a stop with a Request open", () => {
  it("does not warn that the reply may not have reached agy", () =>
    run(
      (h) =>
        Effect.gen(function* () {
          yield* h.start();
          yield* h.adapter.sendInput(SESSION, buildInput());
          yield* h.until("a request opened", () => h.tags("request.opened").length === 1);

          yield* h.adapter.stopSession(SESSION, "stopped");

          expect(h.tags("runtime.warning")).toEqual([]);
          expect(h.tags("request.resolved")).toMatchObject([{ decision: "cancel" }]);
        }),
      {
        fake: { recording: "edit-shell" },
        holdAcknowledgement: (message) =>
          message.method === undefined && message.id !== undefined
            ? new Promise(() => {})
            : undefined,
      },
    ));
});
