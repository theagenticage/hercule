/**
 * Checks that the real vendor SDK still returns the shapes that the stubbed
 * tests in `claude-code.test.ts` assume.
 *
 * The probe test uses a temporary config directory and never touches the
 * developer's own `~/.claude`. The session tests cannot do that: a login is
 * stored only in the config directory, and on macOS it is a Keychain item
 * keyed by that directory, so it cannot be copied into a temporary one. So
 * the session tests use the developer's own login, spend a few tokens, and
 * run only when opted in.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Duration, Effect, Stream } from "effect";
import type { OutputSchema, ProviderEvent, SessionSpec } from "@hercule/protocol";
import {
  ASSESSOR_SYSTEM_PROMPT,
  FIXTURE_PROMPT,
  FIXTURE_SCHEMA,
  IMPOSSIBLE_PROMPT,
  IMPOSSIBLE_SCHEMA,
} from "@hercule/protocol/testing";
import { prepareTooling } from "../sessions/tooling";
import { claudeCode } from "./claude-code";
import { PROBE_DEADLINE } from "./probe";
import type { ProviderRunnerContext } from "./index";

const binary = Bun.which("claude") ?? undefined;

const homes: Array<string> = [];

afterAll(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const createTemporaryHome = (): string => {
  const home = mkdtempSync(join(tmpdir(), "hercule-claude-probe-"));
  homes.push(home);
  return home;
};

/**
 * Returns the hercule-as-a-tool setting for the contexts in this file. It
 * points at a real plugin directory, because the CLI would reject a path that
 * is not one. The skill test below writes its own plugin, with a marker in it.
 *
 * The directory is created on first use, so a run that skips every test here
 * writes nothing.
 */
let tool: ProviderRunnerContext["herculeTool"] | undefined;
const prepareTool = (): ProviderRunnerContext["herculeTool"] => {
  if (tool === undefined) {
    const under = createTemporaryHome();
    const {
      herculeTool: { claudePluginDir },
    } = prepareTooling({
      home: join(under, "home"),
      storageDir: join(under, "storage"),
      execPath: process.execPath,
      skill: "# hercule\n\nNothing this test asks about.\n",
    });
    tool = { skill: "", claudePluginDir };
  }
  return tool;
};

const readInstalledVersion = async (path: string): Promise<string> => {
  const child = Bun.spawn([path, "--version"], { stdout: "pipe", stderr: "ignore" });
  const printed = await new Response(child.stdout).text();
  await child.exited;
  expect(child.exitCode, printed).toBe(0);
  return /\d+\.\d+\.\d+\S*/.exec(printed)?.[0] ?? printed.trim();
};

describe.skipIf(binary === undefined)("the real Claude adapter on this machine", () => {
  it(
    "reports an empty config directory as not logged in, with the machine's version and models",
    async () => {
      const context: ProviderRunnerContext = {
        cwd: null,
        home: createTemporaryHome(),
        binary: binary!,
        env: { PATH: process.env["PATH"] ?? "" },
        secrets: {},
        herculeTool: prepareTool(),
      };

      const started = Date.now();
      const probed = await Effect.runPromise(claudeCode.probe(context, {}));
      const took = Date.now() - started;

      // Not `error`: an empty config directory means nobody has logged in, and
      // the point of this test is to tell that apart from a broken harness.
      expect(probed.auth.status, probed.auth.message ?? "").toBe("unauthenticated");
      expect(probed.auth.identity).toBeUndefined();
      expect(probed.harnessVersion).toBe(await readInstalledVersion(binary!));
      // The model catalog comes from the probe, not from a hand-written list.
      // An empty catalog would leave the composer with nothing to offer on a
      // working machine.
      expect(probed.models.length).toBeGreaterThan(0);
      for (const model of probed.models) expect(model.slug).not.toBe("");

      expect(took).toBeLessThan(Duration.toMillis(PROBE_DEADLINE));
      // The vitest timeout below is set from the probe deadline instead of the
      // default five seconds: a probe that takes the full fifteen seconds is the
      // failure this test exists to report, so vitest must not cut it short.
    },
    Duration.toMillis(PROBE_DEADLINE) * 2,
  );
});

/**
 * The config directory the live sessions use: the developer's own. Everything
 * else about those sessions is isolated: a throwaway cwd, no setting sources,
 * and no auto memory.
 */
const CONFIG_DIR = process.env["CLAUDE_CONFIG_DIR"] ?? join(homedir(), ".claude");

/**
 * The live session tests are opt-in. Otherwise `pnpm test` on any developer's
 * machine would silently spend their subscription and take a minute doing it.
 */
const wanted = process.env["HERCULE_LIVE_SESSION_TEST"] !== undefined;

const SESSION = "0199e0e7-0000-7000-8000-0000000000ff";

const SPEC: SessionSpec = {
  instanceId: "0199e0e7-0000-7000-8000-00000000000a",
  workspaceId: null,
  // The cheapest model, and no tools: these tests check the session's events,
  // not what the model can do.
  modelSelection: { model: "claude-haiku-4-5", options: {} },
  accessMode: "approval-required",
  timeouts: { inactivityMs: 1_800_000, absoluteMs: 28_800_000 },
};

/** Long enough for a cold CLI to start, connect and reply to one short prompt. */
const TURN_DEADLINE = Duration.seconds(90);

const waitForEvent = async (
  seen: ReadonlyArray<ProviderEvent>,
  tag: ProviderEvent["_tag"],
): Promise<void> => {
  const deadline = Date.now() + Duration.toMillis(TURN_DEADLINE);
  while (!seen.some((event) => event._tag === tag)) {
    if (Date.now() > deadline) {
      throw new Error(
        `no ${tag} within ${Duration.format(TURN_DEADLINE)}: saw ${seen.map((event) => event._tag).join(", ")}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

/**
 * Whether this machine can run a session at all. It is checked the way the
 * runner checks it: with the adapter's own probe, against the same config
 * directory the sessions will use. `claude auth status --json` is not used:
 * with `CLAUDE_CONFIG_DIR` set explicitly, even to its default value, it
 * reports on a different credential from the one the session gets.
 */
const authed =
  binary === undefined || !wanted
    ? false
    : (
        await Effect.runPromise(
          claudeCode.probe(
            {
              cwd: null,
              home: CONFIG_DIR,
              binary,
              env: process.env,
              secrets: {},
              herculeTool: prepareTool(),
            },
            {},
          ),
        )
      ).auth.status === "ok";

describe.skipIf(!authed)("a real Claude Code session on this machine", () => {
  it(
    "starts, replies to one prompt inside a turn, and exits when stopped",
    async () => {
      const seen: Array<ProviderEvent> = [];
      Effect.runFork(
        Stream.runForEach(claudeCode.events, (event) => Effect.sync(() => void seen.push(event))),
      );

      const context = buildContext(createTemporaryHome());

      const binding = await Effect.runPromise(claudeCode.startSession(SESSION, SPEC, context));
      expect(binding.sessionId).toBe(SESSION);
      // The two ids are separate concepts, joined only by this binding.
      expect(binding.nativeSessionId).not.toBe(SESSION);

      await Effect.runPromise(
        claudeCode.sendInput(SESSION, {
          text: "Reply with the single word ready. Use no tools.",
        }),
      );

      await waitForEvent(seen, "turn.completed");

      const tags = seen.map((event) => event._tag);
      expect(tags[0]).toBe("session.started");
      expect(tags.indexOf("turn.started")).toBeLessThan(tags.indexOf("turn.completed"));
      const done = seen.find((event) => event._tag === "turn.completed");
      expect(
        done?._tag === "turn.completed" ? done.state : undefined,
        done?._tag === "turn.completed" ? (done.error ?? "") : "",
      ).toBe("completed");
      // The reply arrived as deltas, not all at once at the end.
      expect(tags).toContain("content.delta");
      expect(tags).toContain("session.usage.updated");

      await Effect.runPromise(claudeCode.stopSession(SESSION, "stopped"));
      await waitForEvent(seen, "session.exited");
      const exited = seen.find((event) => event._tag === "session.exited");
      expect(exited?._tag === "session.exited" ? exited.reason : undefined).toBe("stopped");
      expect(await Effect.runPromise(claudeCode.listSessions)).toEqual([]);
    },
    Duration.toMillis(TURN_DEADLINE) * 2,
  );
});

/**
 * The fork and resume test checks one CLI behaviour the SDK's types do not
 * show: whether `options.sessionId` is honoured together with `resume` and
 * `forkSession: true`. That is what lets Hercule choose a forked session's id,
 * as it does for a new session. If the CLI ignores it, the fork's binding must
 * wait for the CLI's own `init` message instead, and the test's failure
 * message explains this.
 *
 * The cwd is a temporary directory, so the transcripts this test writes go
 * into their own `projects/<encoded-cwd>/` folder, and none of the developer's
 * transcripts are read or changed. The config directory must be the
 * developer's own: on macOS a login is a Keychain item keyed by the config
 * directory, so a temporary directory never has a login and the test would
 * always skip.
 */
const PROJECTS = join(CONFIG_DIR, "projects");

/** Lists every transcript file in the config directory's `projects/` folders. */
const listTranscripts = (): ReadonlyArray<string> =>
  !existsSync(PROJECTS)
    ? []
    : readdirSync(PROJECTS, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .flatMap((entry) =>
          readdirSync(join(PROJECTS, entry.name))
            .filter((name) => name.endsWith(".jsonl"))
            .map((name) => join(PROJECTS, entry.name, name)),
        );

const findTranscript = (nativeSessionId: string): string | undefined =>
  listTranscripts().find((path) => basename(path) === `${nativeSessionId}.jsonl`);

/**
 * Waits for a session's transcript file and returns its path, or `undefined`
 * after the deadline. The CLI writes the transcript as it goes, so the file
 * may not exist yet at the moment the turn completes.
 */
const waitForTranscript = async (nativeSessionId: string): Promise<string | undefined> => {
  const deadline = Date.now() + Duration.toMillis(TURN_DEADLINE);
  for (;;) {
    const found = findTranscript(nativeSessionId);
    if (found !== undefined || Date.now() > deadline) return found;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
};

/**
 * Builds the context a live session runs in: a throwaway cwd, the developer's
 * config directory (the only place a login is stored), and `ANTHROPIC_API_KEY`
 * when it is set, which is the other way to authenticate.
 */
const buildContext = (
  cwd: string,
  herculeTool: ProviderRunnerContext["herculeTool"] = prepareTool(),
): ProviderRunnerContext => ({
  cwd,
  home: CONFIG_DIR,
  binary: binary!,
  env: {
    PATH: process.env["PATH"] ?? "",
    HOME: homedir(),
    ...(process.env["ANTHROPIC_API_KEY"] === undefined
      ? {}
      : { ANTHROPIC_API_KEY: process.env["ANTHROPIC_API_KEY"] }),
  },
  secrets: {},
  herculeTool,
});

/**
 * Subscribes to the adapter's events and returns the list they are collected
 * into. Each session needs its own subscriber, because the stream never replays
 * past events.
 */
const collectEvents = (): Array<ProviderEvent> => {
  const seen: Array<ProviderEvent> = [];
  Effect.runFork(
    Stream.runForEach(claudeCode.events, (event) => Effect.sync(() => void seen.push(event))),
  );
  return seen;
};

const PARENT = "0199e0e7-0000-7000-8000-00000000ff01";
const FORKED = "0199e0e7-0000-7000-8000-00000000ff02";
const RESUMED = "0199e0e7-0000-7000-8000-00000000ff03";
const SKILLED = "0199e0e7-0000-7000-8000-00000000ff04";

describe.skipIf(!authed)("a real Claude Code session continued on this machine", () => {
  it(
    "forks under the native id Hercule created, and resumes under the parent's own id",
    async () => {
      const context = buildContext(createTemporaryHome());

      /**
       * A unique word in the parent's transcript, so a fork can be told apart
       * from a new session.
       */
      const marker = `hercule-fork-probe-${crypto.randomUUID().slice(0, 8)}`;
      const buildPrompt = (text: string) =>
        `Reply with the single word ready. Use no tools. ${text}`;

      /**
       * Starts a session, sends one input, waits for the turn to complete, and
       * stops it. Returns the native session id.
       */
      const runOneTurn = async (
        sessionId: string,
        spec: SessionSpec,
        text: string,
      ): Promise<string> => {
        const seen = collectEvents();
        const binding = await Effect.runPromise(claudeCode.startSession(sessionId, spec, context));
        await Effect.runPromise(claudeCode.sendInput(sessionId, { text }));
        await waitForEvent(seen, "turn.completed");
        await Effect.runPromise(claudeCode.stopSession(sessionId, "stopped"));
        await waitForEvent(seen, "session.exited");
        return binding.nativeSessionId;
      };

      const parent = await runOneTurn(PARENT, SPEC, buildPrompt(marker));
      const parentFile = await waitForTranscript(parent);
      expect(
        parentFile,
        `no transcript for the parent session ${parent} under ${PROJECTS}`,
      ).not.toBe(undefined);
      const before = readFileSync(parentFile!, "utf8");
      expect(before).toContain(marker);
      const known = new Set(listTranscripts());

      // Hercule creates the forked session's id itself, because in
      // streaming-input mode the CLI sends nothing until the first turn.
      const forkSeen = collectEvents();
      const minted = await Effect.runPromise(
        claudeCode.startSession(
          FORKED,
          { ...SPEC, continue: { nativeSessionId: parent, mode: "fork" } },
          context,
        ),
      );
      expect(minted.nativeSessionId).not.toBe(parent);
      await Effect.runPromise(claudeCode.sendInput(FORKED, { text: buildPrompt("second") }));
      await waitForEvent(forkSeen, "turn.completed");
      await Effect.runPromise(claudeCode.stopSession(FORKED, "stopped"));
      await waitForEvent(forkSeen, "session.exited");

      const forkedFile = await waitForTranscript(minted.nativeSessionId);
      const appeared = listTranscripts().filter((path) => !known.has(path));
      expect(
        forkedFile,
        `this CLI ignored options.sessionId beside resume + forkSession: true. Hercule minted ` +
          `${minted.nativeSessionId}; the transcripts that appeared instead were ` +
          `[${appeared.map((path) => basename(path)).join(", ")}]. Bind the fork from the CLI's ` +
          `own init message and emit session.started there instead.`,
      ).not.toBe(undefined);
      // A fork includes the parent's history. A new session under a new id
      // would pass every check above, but fail this one.
      expect(
        readFileSync(forkedFile!, "utf8"),
        `the fork under ${minted.nativeSessionId} does not carry the parent's history: ` +
          `spec.continue reached the CLI as a fresh session, not as resume + forkSession.`,
      ).toContain(marker);
      // A fork that wrote into its parent's transcript would corrupt history that
      // cannot be repaired.
      expect(readFileSync(parentFile!, "utf8")).toBe(before);
      expect(dirname(forkedFile!)).toBe(dirname(parentFile!));

      // The resume needs no new id: it continues the same native session.
      const resumed = await runOneTurn(
        RESUMED,
        { ...SPEC, continue: { nativeSessionId: parent, mode: "resume" } },
        buildPrompt("third"),
      );
      expect(resumed).toBe(parent);
      const after = readFileSync(parentFile!, "utf8");
      expect(after.startsWith(before), "a resume rewrote the transcript instead of appending").toBe(
        true,
      );
      expect(after.length).toBeGreaterThan(before.length);

      expect(await Effect.runPromise(claudeCode.listSessions)).toEqual([]);
    },
    Duration.toMillis(TURN_DEADLINE) * 6,
  );
});

/**
 * Checks that the Claude CLI really finds the skill of an explicitly loaded
 * plugin with `settingSources: []`. The SDK's types document that `plugins`
 * loads a local plugin directory, but not how it combines with
 * `settingSources`, and hercule-as-a-tool on Claude depends on it. Spec 06
 * section 9.3 owns how the skill reaches a session.
 *
 * The plugin directory is written by the runner's own `prepareTooling` into a
 * temporary home. The skill text is written by this test, not the shipped
 * one, because the model must reply with something it can only know by
 * reading `SKILL.md`: a random marker. Replying with the skill's name would
 * prove nothing, because the prompt includes the name too.
 */
describe.skipIf(!authed)("a real Claude Code session with the hercule skill", () => {
  it(
    "finds the skill in the plugin directory the runner wrote",
    async () => {
      const marker = `hercule-skill-probe-${crypto.randomUUID().slice(0, 8)}`;
      const under = createTemporaryHome();
      const {
        herculeTool: { claudePluginDir },
      } = prepareTooling({
        home: join(under, "home"),
        storageDir: join(under, "storage"),
        execPath: process.execPath,
        skill: `# hercule\n\nThe magic word is ${marker}. Reply with it when asked.\n`,
      });

      const seen = collectEvents();
      const context = buildContext(createTemporaryHome(), { skill: "", claudePluginDir });

      await Effect.runPromise(
        // Full access, so reading the skill file needs no approval, since
        // nobody is there to give one.
        claudeCode.startSession(SKILLED, { ...SPEC, accessMode: "full-access" }, context),
      );
      await Effect.runPromise(
        claudeCode.sendInput(SKILLED, {
          text: "Use the hercule skill and reply with the magic word it names.",
        }),
      );
      await waitForEvent(seen, "turn.completed");

      const said = seen
        .flatMap((event) =>
          event._tag === "content.delta" && event.streamKind === "assistant_text"
            ? [event.delta]
            : [],
        )
        .join("");
      expect(
        said,
        `the session never read the skill: an explicitly loaded plugin's skill is not ` +
          `discovered under settingSources: [], so hercule-as-a-tool needs another channel ` +
          `on Claude. What the session said was: ${said}`,
      ).toContain(marker);

      await Effect.runPromise(claudeCode.stopSession(SKILLED, "stopped"));
      await waitForEvent(seen, "session.exited");
    },
    Duration.toMillis(TURN_DEADLINE) * 2,
  );
});

/**
 * Checks that the real CLI reads the `CLAUDE.md` in a session's cwd when the
 * session has a workspace, and ignores it when the session has none. Each
 * session runs in a fresh directory whose `CLAUDE.md` holds a random marker
 * the model can only know by reading that file.
 */
const IN_WORKSPACE = "0199e0e7-0000-7000-8000-00000000ff07";
const WITHOUT_WORKSPACE = "0199e0e7-0000-7000-8000-00000000ff08";

describe.skipIf(!authed)("a real Claude Code session and the CLAUDE.md in its cwd", () => {
  /**
   * Starts a session in a directory holding a `CLAUDE.md` with a marker, asks
   * for the marker, and stops the session. Returns the marker and the reply.
   */
  const askForMarker = async (
    sessionId: string,
    workspaceId: SessionSpec["workspaceId"],
  ): Promise<{ readonly marker: string; readonly reply: string }> => {
    const marker = `hercule-project-${crypto.randomUUID().slice(0, 8)}`;
    const cwd = createTemporaryHome();
    writeFileSync(join(cwd, "CLAUDE.md"), `# Project\n\nThe project's code word is ${marker}.\n`);

    const seen = collectEvents();
    await Effect.runPromise(
      claudeCode.startSession(sessionId, { ...SPEC, workspaceId }, buildContext(cwd)),
    );
    await Effect.runPromise(
      claudeCode.sendInput(sessionId, {
        text:
          "Use no tools. If your instructions name the project's code word, reply with it. " +
          "Otherwise reply with the single word none.",
      }),
    );
    await waitForEvent(seen, "turn.completed");
    await Effect.runPromise(claudeCode.stopSession(sessionId, "stopped"));
    await waitForEvent(seen, "session.exited");

    const reply = seen
      .flatMap((event) =>
        event._tag === "content.delta" && event.streamKind === "assistant_text"
          ? [event.delta]
          : [],
      )
      .join("");
    return { marker, reply };
  };

  it(
    "follows the workspace's CLAUDE.md",
    async () => {
      const { marker, reply } = await askForMarker(
        IN_WORKSPACE,
        "0199e0e7-0000-7000-8000-00000000000b",
      );
      expect(reply, `the session never read the workspace's CLAUDE.md: ${reply}`).toContain(marker);
    },
    Duration.toMillis(TURN_DEADLINE) * 2,
  );

  it(
    "ignores a CLAUDE.md in its cwd when it has no workspace",
    async () => {
      const { marker, reply } = await askForMarker(WITHOUT_WORKSPACE, null);
      expect(reply, `a workspace-less session read a stray CLAUDE.md: ${reply}`).not.toContain(
        marker,
      );
    },
    Duration.toMillis(TURN_DEADLINE) * 2,
  );
});

/**
 * Checks that a real session produces output that matches its output schema,
 * and reports a failure when no output can match. The SDK validates and
 * re-prompts on its own. These tests check that the runner's structured result
 * agrees: an `ok` whose value really matches, and a `schema-failure` that
 * arrives as a completed turn instead of a hang.
 */
const STRUCTURED = "0199e0e7-0000-7000-8000-00000000ff05";
const IMPOSSIBLE = "0199e0e7-0000-7000-8000-00000000ff06";

describe.skipIf(!authed)("a real Claude Code session under an output schema", () => {
  /**
   * Starts a session with a schema, sends one input, waits for the turn to
   * complete, and stops it. Returns the `turn.completed` event.
   */
  const runTurnUnderSchema = async (
    sessionId: string,
    outputSchema: OutputSchema,
    text: string,
  ): Promise<Extract<ProviderEvent, { _tag: "turn.completed" }>> => {
    const seen = collectEvents();
    await Effect.runPromise(
      claudeCode.startSession(
        sessionId,
        { ...SPEC, systemPrompt: ASSESSOR_SYSTEM_PROMPT, outputSchema },
        buildContext(createTemporaryHome()),
      ),
    );
    await Effect.runPromise(claudeCode.sendInput(sessionId, { text }));
    await waitForEvent(seen, "turn.completed");
    await Effect.runPromise(claudeCode.stopSession(sessionId, "stopped"));
    await waitForEvent(seen, "session.exited");
    return seen.find(
      (event): event is Extract<ProviderEvent, { _tag: "turn.completed" }> =>
        event._tag === "turn.completed",
    )!;
  };

  it(
    "produces a value that matches the fixture schema",
    async () => {
      const completed = await runTurnUnderSchema(STRUCTURED, FIXTURE_SCHEMA, FIXTURE_PROMPT);

      expect(completed.structuredResult?.outcome, JSON.stringify(completed.structuredResult)).toBe(
        "ok",
      );
      const answer = completed.structuredResult as { outcome: "ok"; value: { verdict?: unknown } };
      expect(answer.value.verdict).toBe("accept");
    },
    Duration.toMillis(TURN_DEADLINE) * 2,
  );

  it(
    "ends the turn with a schema failure when no value can match the schema",
    async () => {
      const completed = await runTurnUnderSchema(IMPOSSIBLE, IMPOSSIBLE_SCHEMA, IMPOSSIBLE_PROMPT);

      expect(completed.structuredResult?.outcome, JSON.stringify(completed.structuredResult)).toBe(
        "schema-failure",
      );
      const failure = completed.structuredResult as { outcome: "schema-failure"; reason: string };
      expect(failure.reason).not.toBe("");
      expect(await Effect.runPromise(claudeCode.listSessions)).toEqual([]);
    },
    Duration.toMillis(TURN_DEADLINE) * 2,
  );
});
