/**
 * Checks that the real vendor SDK still returns the shapes that the stubbed
 * tests in `claude-code.test.ts` assume. The last test replays a run recorded
 * from the real CLI through the adapter, so it needs no CLI at all.
 *
 * The probe test and the User Material tests use a temporary config directory
 * and never touch the developer's own `~/.claude`. The User Material tests can
 * do that because they only read what a session loaded at startup and never
 * send a turn, so a placeholder API key is enough. The other session tests
 * cannot: a login is stored only in the config directory, and on macOS it is a
 * Keychain item keyed by that directory, so it cannot be copied into a
 * temporary one. So those tests use the developer's own login, spend a few
 * tokens, and run only when opted in.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Duration, Effect, Schema, Stream } from "effect";
import {
  query as sdkQuery,
  type Options,
  type Query,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { ProviderEvent, type OutputSchema, type SessionSpec } from "@hercule/protocol";
import {
  ASSESSOR_SYSTEM_PROMPT,
  FIXTURE_PROMPT,
  FIXTURE_SCHEMA,
  IMPOSSIBLE_PROMPT,
  IMPOSSIBLE_SCHEMA,
} from "@hercule/protocol/testing";
import { prepareTooling } from "../sessions/tooling";
import { claudeCode, makeClaudeCodeAdapter } from "./claude-code";
import { PROBE_DEADLINE } from "./probe";
import { runProcess } from "./process";
import type { ProviderRunnerContext } from "./index";
import { NO_CONTROLLER_UPLOADER, NO_USER_MATERIAL_PATHS } from "./testing";
import { ensureRootBoundary } from "../workspaces";

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
      orientation: "",
      skill: "# hercule\n\nNothing this test asks about.\n",
    });
    tool = { orientation: "", skill: "", claudePluginDir };
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
        attachmentsDir: null,
        editMarks: null,
        attachmentUploader: NO_CONTROLLER_UPLOADER,
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
              attachmentsDir: null,
              editMarks: null,
              attachmentUploader: NO_CONTROLLER_UPLOADER,
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
  attachmentsDir: null,
  editMarks: null,
  attachmentUploader: NO_CONTROLLER_UPLOADER,
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
        orientation: "",
        skill: `# hercule\n\nThe magic word is ${marker}. Reply with it when asked.\n`,
      });

      const seen = collectEvents();
      const context = buildContext(createTemporaryHome(), {
        orientation: "",
        skill: "",
        claudePluginDir,
      });

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

const THREAD_SESSION_ID = "0199e0e7-0000-7000-8000-00000000ff09";
const ISOLATED_SESSION_ID = "0199e0e7-0000-7000-8000-00000000ff0a";
const CHECKOUT_SESSION_ID = "0199e0e7-0000-7000-8000-00000000ff0c";

/**
 * Checks that the real CLI loads User Material from the instance's home only
 * for a Thread that sees it, and that a Thread's skills come from its skills
 * folder, never from the user's disk. The home is laid out the way the runner
 * lays it out now: `CLAUDE.md` is a symlink to the user's `~/.claude/CLAUDE.md`,
 * and there is no `skills` link.
 *
 * The user also has a skill in `~/.agents/skills`, linked from
 * `~/.claude/skills` as on a machine where the skills are shared between
 * harnesses. No session may load it. The Thread's session skills folder is
 * laid out the way the runner fills one, with one library skill.
 *
 * The home, the user's directory and the session skills folder are all
 * temporary. The sessions never send a turn: the test asks the CLI what it
 * loaded at startup, which needs no login.
 */
describe.skipIf(binary === undefined)("User Material in a real Claude Code session", () => {
  /**
   * Lays out a user's material, an instance home that links to it, and a
   * session skills folder with one library skill. Returns the paths of all
   * three.
   */
  const layOutMaterial = (): {
    readonly root: string;
    readonly home: string;
    readonly librarySkillsFolder: string;
  } => {
    const root = createTemporaryHome();
    const userHome = join(root, "user");
    const userSkill = join(userHome, ".agents", "skills", "user-skill");
    mkdirSync(userSkill, { recursive: true });
    writeFileSync(
      join(userSkill, "SKILL.md"),
      "---\nname: user-skill\ndescription: A skill no session may load.\n---\n\nNothing.\n",
    );
    const claudeDir = join(userHome, ".claude");
    mkdirSync(join(claudeDir, "skills"), { recursive: true });
    symlinkSync("../../.agents/skills/user-skill", join(claudeDir, "skills", "user-skill"));
    writeFileSync(join(claudeDir, "CLAUDE.md"), "# Personal\n\nThe user's own instructions.\n");

    const home = join(root, "instance");
    mkdirSync(home);
    symlinkSync(join(claudeDir, "CLAUDE.md"), join(home, "CLAUDE.md"));

    const librarySkillsFolder = join(root, "session-skills-folder");
    mkdirSync(join(librarySkillsFolder, ".claude-plugin"), { recursive: true });
    writeFileSync(
      join(librarySkillsFolder, ".claude-plugin", "plugin.json"),
      `${JSON.stringify({ name: "skills" })}\n`,
    );
    const librarySkill = join(librarySkillsFolder, "skills", "library-skill");
    mkdirSync(librarySkill, { recursive: true });
    writeFileSync(
      join(librarySkill, "SKILL.md"),
      "---\nname: library-skill\ndescription: A skill from the Skill Library.\n---\n\nNothing.\n",
    );
    return { root, home, librarySkillsFolder };
  };

  /**
   * Lays out a single-checkout workspace the way the runner stages it: the
   * checkout `hercule` has a skill in `.claude/skills` and one in
   * `.agents/skills`, and the plugin folder `repo-hercule` links both from
   * its `skills/`. Returns the checkout and the plugin folder.
   */
  const layOutCheckout = (
    root: string,
  ): { readonly checkout: string; readonly repositorySkillsFolder: string } => {
    const checkout = join(root, "hercule");
    const repositorySkillsFolder = join(root, "repository-skills", "hercule");
    mkdirSync(join(repositorySkillsFolder, ".claude-plugin"), { recursive: true });
    writeFileSync(
      join(repositorySkillsFolder, ".claude-plugin", "plugin.json"),
      `${JSON.stringify({ name: "repo-hercule" })}\n`,
    );
    mkdirSync(join(repositorySkillsFolder, "skills"));
    for (const [folder, name] of [
      [".claude", "from-claude"],
      [".agents", "from-agents"],
    ] as const) {
      const skill = join(checkout, folder, "skills", name);
      mkdirSync(skill, { recursive: true });
      writeFileSync(
        join(skill, "SKILL.md"),
        `---\nname: ${name}\ndescription: A skill from ${folder}.\n---\n\nNothing.\n`,
      );
      symlinkSync(skill, join(repositorySkillsFolder, "skills", name));
    }
    return { checkout, repositorySkillsFolder };
  };

  /**
   * Starts a workspace-less session through the adapter, with the real SDK,
   * and returns the skills and memory files the CLI reports it loaded. A
   * Thread gets the user's material and the session skills folder, as the
   * runner gives them; any other session gets neither. With `checkout`, the
   * session instead runs in a single-checkout workspace and gets its
   * repository skills folder. The session is stopped before this returns.
   */
  const readLoadedMaterial = async (
    sessionId: string,
    session: { readonly thread: boolean; readonly checkout?: boolean },
  ): Promise<{
    readonly home: string;
    readonly skills: ReadonlyArray<string>;
    readonly memoryFiles: ReadonlyArray<{ readonly path: string; readonly type: string }>;
  }> => {
    const { root, home, librarySkillsFolder } = layOutMaterial();
    const scratch = join(root, "scratch");
    mkdirSync(scratch);
    const repository = session.checkout ? layOutCheckout(root) : undefined;
    const spec: SessionSpec =
      repository === undefined
        ? SPEC
        : { ...SPEC, workspaceId: "0199e0e7-0000-7000-8000-00000000000b" };
    let running: Query | undefined;
    const adapter = makeClaudeCodeAdapter({
      stream: ({ options, input }) => {
        const started = sdkQuery({ prompt: input, options });
        running = started;
        return {
          [Symbol.asyncIterator]: () => started[Symbol.asyncIterator](),
          interrupt: () => started.interrupt().then(() => undefined),
          setModel: (model) => started.setModel(model),
          stopTask: (taskId) => started.stopTask(taskId),
          close: () => void started.return(undefined).catch(() => undefined),
        };
      },
      query: () => {
        throw new Error("these tests start sessions, not probes");
      },
      run: runProcess,
    });
    const context: ProviderRunnerContext = {
      cwd: repository?.checkout ?? scratch,
      attachmentsDir: null,
      editMarks: null,
      attachmentUploader: NO_CONTROLLER_UPLOADER,
      home,
      binary: binary!,
      // `HOME` points into the temporary directory too, so nothing the CLI
      // finds under the developer's own home can reach the session.
      env: {
        PATH: process.env["PATH"] ?? "",
        HOME: join(root, "user"),
        ANTHROPIC_API_KEY: "sk-ant-placeholder",
      },
      secrets: {},
      herculeTool: prepareTool(),
      ...(session.thread ? { userMaterial: NO_USER_MATERIAL_PATHS, librarySkillsFolder } : {}),
      ...(repository === undefined
        ? {}
        : {
            repositorySkillsFolders: [repository.repositorySkillsFolder],
            checkoutPaths: [repository.checkout],
            // The skill overrides reach the CLI through a file in this folder.
            sessionSkillsFolder: join(root, "session-skills"),
          }),
    };

    await Effect.runPromise(adapter.startSession(sessionId, spec, context));
    try {
      await running!.initializationResult();
      // `summary` is computed from local estimates. `full` would count tokens
      // through the API, which the placeholder key cannot do.
      const usage = await running!.getContextUsage({ detail: "summary" });
      return {
        home,
        skills: (usage.skills?.skillFrontmatter ?? [])
          .flatMap((skill) =>
            skill.source === "built-in" ? [] : [`${skill.name} (${skill.source})`],
          )
          .sort(),
        memoryFiles: usage.memoryFiles.map(({ path, type }) => ({ path, type })),
      };
    } finally {
      await Effect.runPromise(adapter.stopSession(sessionId, "stopped"));
    }
  };

  it(
    "lists the library's skills and the user's instructions in a Thread",
    async () => {
      const loaded = await readLoadedMaterial(THREAD_SESSION_ID, { thread: true });

      // Both skills come from plugins: Hercule's own and the session skills folder.
      // The user's skill on disk is not among them.
      expect(loaded.skills).toEqual(["hercule:hercule (plugin)", "skills:library-skill (plugin)"]);
      expect(loaded.memoryFiles).toEqual([{ path: join(loaded.home, "CLAUDE.md"), type: "User" }]);
    },
    Duration.toMillis(PROBE_DEADLINE) * 2,
  );

  it(
    "loads none of it in a session that does not see User Material",
    async () => {
      const loaded = await readLoadedMaterial(ISOLATED_SESSION_ID, { thread: false });

      // The `CLAUDE.md` link is in the same home, but the CLI never reads it.
      expect(loaded.skills).toEqual(["hercule:hercule (plugin)"]);
      expect(loaded.memoryFiles).toEqual([]);
    },
    Duration.toMillis(PROBE_DEADLINE) * 2,
  );

  it(
    "lists a single checkout's repository skills once each, by their qualified names",
    async () => {
      const loaded = await readLoadedMaterial(CHECKOUT_SESSION_ID, {
        thread: false,
        checkout: true,
      });

      // The checkout is the working directory and the project source is
      // loaded, so Claude would also load `.claude/skills/from-claude` as a
      // plain `from-claude`. The adapter turns that off. `from-agents` is not
      // in a folder Claude reads natively, so it was only ever the plugin's.
      expect(loaded.skills).toEqual([
        "hercule:hercule (plugin)",
        "repo-hercule:from-agents (plugin)",
        "repo-hercule:from-claude (plugin)",
      ]);
    },
    Duration.toMillis(PROBE_DEADLINE) * 2,
  );
});

/**
 * Checks that the boundary at the workspace root stops Claude Code's search
 * for `.claude/` folders there (#369). A workspace with no single checkout runs
 * in its root, which is not a repository, so without the boundary the search
 * climbs to the folders above the root and loads the skills it finds there as
 * project skills. The root holds two real Git checkouts, as a workspace with
 * two repositories does. `HOME` and the config directory are temporary, so
 * nothing of the developer's own installation is read.
 *
 * The skills sit in a folder above the root that is not `HOME`. On Linux, CLI
 * 2.1.299 to 2.1.304 skips the `.claude` of `HOME` when it climbs, as long as
 * `HOME` is spelled the same as the working directory's path: with `HOME` set
 * to a link to the folder that holds the skills, the skills load. A temporary
 * folder on macOS lies behind the `/var` link, so a test that put the skills
 * in `HOME` could pass there and fail on Linux for a reason that has nothing
 * to do with the boundary. A folder that is not `HOME` is climbed on every
 * platform, and that climb is what the boundary has to stop.
 */
describe.skipIf(binary === undefined)("the workspace root in a real Claude Code session", () => {
  const WITHOUT_BOUNDARY_SESSION_ID = "0199e0e7-0000-7000-8000-00000000ff30";
  const WITH_BOUNDARY_SESSION_ID = "0199e0e7-0000-7000-8000-00000000ff31";

  /** Writes a skill named `name` into the skills folder `skillsDir`. */
  const writeSkill = (skillsDir: string, name: string): void => {
    mkdirSync(join(skillsDir, name), { recursive: true });
    writeFileSync(
      join(skillsDir, name, "SKILL.md"),
      `---\nname: ${name}\ndescription: The ${name} skill.\n---\n\nNothing.\n`,
    );
  };

  /**
   * Makes the Git checkout `name` in `workspaceRoot`, with one skill of its
   * own in `.claude/skills`, and the plugin folder the runner stages for it.
   * Returns the plugin folder.
   */
  const layOutCheckoutInRoot = (root: string, workspaceRoot: string, name: string): string => {
    const checkout = join(workspaceRoot, name);
    mkdirSync(checkout);
    const initialized = Bun.spawnSync(["git", "-C", checkout, "init", "--quiet"]);
    expect(initialized.exitCode, initialized.stderr.toString()).toBe(0);
    writeSkill(join(checkout, ".claude", "skills"), `from-${name}`);
    const pluginFolder = join(root, "repository-skills", name);
    mkdirSync(join(pluginFolder, ".claude-plugin"), { recursive: true });
    writeFileSync(
      join(pluginFolder, ".claude-plugin", "plugin.json"),
      `${JSON.stringify({ name: `repo-${name}` })}\n`,
    );
    mkdirSync(join(pluginFolder, "skills"));
    symlinkSync(
      join(checkout, ".claude", "skills", `from-${name}`),
      join(pluginFolder, "skills", `from-${name}`),
    );
    return pluginFolder;
  };

  /**
   * Starts a session in a workspace root with two checkouts, under a folder
   * that has a user skill in `.claude/skills` and in `.agents/skills` and is
   * not the session's `HOME`, and returns the skills the CLI reports it
   * loaded. When `boundary` is set, the root first gets the boundary the
   * runner makes.
   */
  const readLoadedSkills = async (
    sessionId: string,
    options: { readonly boundary: boolean },
  ): Promise<ReadonlyArray<string>> => {
    const root = createTemporaryHome();
    const skillsParent = join(root, "user");
    writeSkill(join(skillsParent, ".claude", "skills"), "user-skill");
    writeSkill(join(skillsParent, ".agents", "skills"), "user-skill");
    const userHome = join(root, "home");
    mkdirSync(userHome);
    const workspaceRoot = join(skillsParent, "storage", "workspaces", "w");
    mkdirSync(workspaceRoot, { recursive: true });
    const repositorySkillsFolders = ["a", "b"].map((name) =>
      layOutCheckoutInRoot(root, workspaceRoot, name),
    );
    const home = join(root, "instance");
    mkdirSync(home);
    if (options.boundary) {
      await Effect.runPromise(ensureRootBoundary(workspaceRoot));
    }
    let running: Query | undefined;
    const adapter = makeClaudeCodeAdapter({
      stream: ({ options: streamOptions, input }) => {
        const started = sdkQuery({ prompt: input, options: streamOptions });
        running = started;
        return {
          [Symbol.asyncIterator]: () => started[Symbol.asyncIterator](),
          interrupt: () => started.interrupt().then(() => undefined),
          setModel: (model) => started.setModel(model),
          stopTask: (taskId) => started.stopTask(taskId),
          close: () => void started.return(undefined).catch(() => undefined),
        };
      },
      query: () => {
        throw new Error("these tests start sessions, not probes");
      },
      run: runProcess,
    });
    const context: ProviderRunnerContext = {
      cwd: workspaceRoot,
      attachmentsDir: null,
      editMarks: null,
      attachmentUploader: NO_CONTROLLER_UPLOADER,
      home,
      binary: binary!,
      env: {
        PATH: process.env["PATH"] ?? "",
        HOME: userHome,
        ANTHROPIC_API_KEY: "sk-ant-placeholder",
      },
      secrets: {},
      herculeTool: prepareTool(),
      repositorySkillsFolders,
    };
    const spec: SessionSpec = { ...SPEC, workspaceId: "0199e0e7-0000-7000-8000-00000000000b" };

    await Effect.runPromise(adapter.startSession(sessionId, spec, context));
    try {
      await running!.initializationResult();
      const usage = await running!.getContextUsage({ detail: "summary" });
      return (usage.skills?.skillFrontmatter ?? [])
        .flatMap((skill) =>
          skill.source === "built-in" ? [] : [`${skill.name} (${skill.source})`],
        )
        .sort();
    } finally {
      await Effect.runPromise(adapter.stopSession(sessionId, "stopped"));
    }
  };

  it(
    "loads the user's skills from a root with no boundary, and none from one with it",
    async () => {
      const without = await readLoadedSkills(WITHOUT_BOUNDARY_SESSION_ID, { boundary: false });
      const withBoundary = await readLoadedSkills(WITH_BOUNDARY_SESSION_ID, { boundary: true });

      // The first run shows the leak is real on this CLI version, so the
      // second run's result means something.
      expect(without.some((skill) => skill.startsWith("user-skill"))).toBe(true);
      expect(withBoundary).toEqual([
        "hercule:hercule (plugin)",
        "repo-a:from-a (plugin)",
        "repo-b:from-b (plugin)",
      ]);
    },
    Duration.toMillis(PROBE_DEADLINE) * 4,
  );
});

/**
 * Checks the skills Claude Code loads from a checkout while a session works in
 * it. Besides the working directory, Claude looks at every directory between a
 * file a tool touches and the working directory, and loads the
 * `.claude/skills` it finds (spec 06 section 9.4). In a workspace with several
 * checkouts, the working directory is above them, so a skill in
 * `web/.claude/skills` loads once the session reads a file in `web/`. If that
 * folder is a link to the user's own skills, the user's skills load (#369).
 *
 * The test needs a turn in which a tool reads a file, so the CLI talks to a
 * mock of the Anthropic API that asks for one `Read` and then replies with
 * text. No login is involved: `HOME`, the config directory and the API key
 * are all temporary or placeholders, and nothing of the developer's own
 * installation is read.
 */
describe.skipIf(binary === undefined)(
  "native skills of a checkout in a real Claude Code session",
  () => {
    /**
     * Starts a mock of the Anthropic Messages API. The first request of a turn
     * that has tools answers with a `Read` of `readPath`; every other request
     * answers with the text "done". Returns the base URL and a function that
     * stops the server.
     */
    const startMockApi = (
      readPath: string,
    ): { readonly url: string; readonly stop: () => void } => {
      const stream = (events: ReadonlyArray<readonly [string, unknown]>): Response =>
        new Response(
          events
            .map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
            .join(""),
          { headers: { "content-type": "text/event-stream" } },
        );
      const server = Bun.serve({
        port: 0,
        async fetch(request) {
          if (!new URL(request.url).pathname.endsWith("/v1/messages")) {
            return new Response("{}", { headers: { "content-type": "application/json" } });
          }
          const body = (await request.json()) as {
            readonly model: string;
            readonly tools?: ReadonlyArray<unknown>;
            readonly messages: unknown;
          };
          const message = {
            id: "msg_1",
            type: "message",
            role: "assistant",
            model: body.model,
            content: [],
            stop_reason: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          };
          const asksForRead =
            (body.tools?.length ?? 0) > 0 && !JSON.stringify(body.messages).includes("tool_result");
          const block = asksForRead
            ? [
                {
                  type: "content_block_start",
                  index: 0,
                  content_block: { type: "tool_use", id: "toolu_1", name: "Read", input: {} },
                },
                {
                  type: "content_block_delta",
                  index: 0,
                  delta: {
                    type: "input_json_delta",
                    partial_json: JSON.stringify({ file_path: readPath }),
                  },
                },
              ]
            : [
                {
                  type: "content_block_start",
                  index: 0,
                  content_block: { type: "text", text: "" },
                },
                {
                  type: "content_block_delta",
                  index: 0,
                  delta: { type: "text_delta", text: "done" },
                },
              ];
          return stream([
            ["message_start", { type: "message_start", message }],
            ...block.map((event) => [event.type, event] as const),
            ["content_block_stop", { type: "content_block_stop", index: 0 }],
            [
              "message_delta",
              {
                type: "message_delta",
                delta: { stop_reason: asksForRead ? "tool_use" : "end_turn" },
                usage: { output_tokens: 5 },
              },
            ],
            ["message_stop", { type: "message_stop" }],
          ]);
        },
      });
      return { url: `http://localhost:${server.port}`, stop: () => void server.stop(true) };
    };

    /** Writes a skill named `name` into the skills folder `skillsDir`. */
    const writeSkill = (skillsDir: string, name: string): void => {
      mkdirSync(join(skillsDir, name), { recursive: true });
      writeFileSync(
        join(skillsDir, name, "SKILL.md"),
        `---\nname: ${name}\ndescription: The ${name} skill.\n---\n\nNothing.\n`,
      );
    };

    /** Makes the Git repository `directory`. */
    const initRepository = (directory: string): void => {
      mkdirSync(directory, { recursive: true });
      const initialized = Bun.spawnSync(["git", "-C", directory, "init", "--quiet"]);
      expect(initialized.exitCode, initialized.stderr.toString()).toBe(0);
    };

    /**
     * Lays out a workspace with the checkouts `web` and `api` under a root that
     * has the boundary the runner makes, runs one session in the root whose
     * agent reads `web/src/a.ts`, and returns the project skills Claude has
     * loaded after that. `lay` makes the checkouts' skill folders. With
     * `listCheckouts`, the adapter is told where the checkouts are, as the
     * runner does; without, it is not, which shows what the session loads
     * otherwise.
     */
    const readProjectSkillsAfterRead = async (
      sessionId: string,
      lay: (layout: { readonly web: string; readonly userHome: string }) => void,
      listCheckouts: boolean,
    ): Promise<ReadonlyArray<string>> => {
      // The CLI compares the path of the file with the working directory as
      // text, and macOS reaches `/tmp` and `/var` through links. With a path
      // that goes through a link the comparison fails and the CLI discovers
      // nothing, which looks like a pass. So the root is resolved first.
      const root = realpathSync(createTemporaryHome());
      const userHome = join(root, "user");
      const workspaceRoot = join(root, "workspace");
      const web = join(workspaceRoot, "web");
      mkdirSync(userHome);
      initRepository(web);
      initRepository(join(workspaceRoot, "api"));
      mkdirSync(join(web, "src"));
      writeFileSync(join(web, "src", "a.ts"), "export {};\n");
      lay({ web, userHome });
      await Effect.runPromise(ensureRootBoundary(workspaceRoot));
      const home = join(root, "instance");
      mkdirSync(home);

      const mock = startMockApi(join(web, "src", "a.ts"));
      let running: Query | undefined;
      const adapter = makeClaudeCodeAdapter({
        stream: ({ options, input }) => {
          const started = sdkQuery({ prompt: input, options });
          running = started;
          return {
            [Symbol.asyncIterator]: () => started[Symbol.asyncIterator](),
            interrupt: () => started.interrupt().then(() => undefined),
            setModel: (model) => started.setModel(model),
            stopTask: (taskId) => started.stopTask(taskId),
            close: () => void started.return(undefined).catch(() => undefined),
          };
        },
        query: () => {
          throw new Error("these tests start sessions, not probes");
        },
        run: runProcess,
      });
      const seen: Array<ProviderEvent> = [];
      Effect.runFork(
        Stream.runForEach(adapter.events, (event) => Effect.sync(() => void seen.push(event))),
      );
      const context: ProviderRunnerContext = {
        cwd: workspaceRoot,
        attachmentsDir: null,
        editMarks: null,
        attachmentUploader: NO_CONTROLLER_UPLOADER,
        home,
        binary: binary!,
        env: {
          PATH: process.env["PATH"] ?? "",
          HOME: userHome,
          ANTHROPIC_API_KEY: "sk-ant-placeholder",
          ANTHROPIC_BASE_URL: mock.url,
        },
        secrets: {},
        herculeTool: prepareTool(),
        sessionSkillsFolder: join(root, "session-skills"),
        ...(listCheckouts ? { checkoutPaths: [web, join(workspaceRoot, "api")] } : {}),
      };
      // `full-access`, so the agent's read needs no approval.
      const spec: SessionSpec = {
        ...SPEC,
        accessMode: "full-access",
        workspaceId: "0199e0e7-0000-7000-8000-00000000000b",
      };

      const countTurns = () => seen.filter((event) => event._tag === "turn.completed").length;
      const waitForTurns = async (count: number): Promise<void> => {
        const deadline = Date.now() + Duration.toMillis(TURN_DEADLINE);
        while (countTurns() < count) {
          if (Date.now() > deadline) throw new Error(`fewer than ${count} turns completed`);
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      };
      try {
        await Effect.runPromise(adapter.startSession(sessionId, spec, context));
        // The first turn reads the file. Claude hands the skills it found there
        // to the model at the start of the next turn, so a second turn follows.
        await Effect.runPromise(adapter.sendInput(sessionId, { text: "Read the file." }));
        await waitForTurns(1);
        await Effect.runPromise(adapter.sendInput(sessionId, { text: "Thanks." }));
        await waitForTurns(2);
        const usage = await running!.getContextUsage({ detail: "summary" });
        return (usage.skills?.skillFrontmatter ?? [])
          .filter((skill) => skill.source === "projectSettings")
          .map((skill) => skill.name)
          .sort();
      } finally {
        await Effect.runPromise(adapter.stopSession(sessionId, "stopped"));
        mock.stop();
      }
    };

    const SKILL_SESSION_IDS = [
      "0199e0e7-0000-7000-8000-00000000ff40",
      "0199e0e7-0000-7000-8000-00000000ff41",
      "0199e0e7-0000-7000-8000-00000000ff42",
      "0199e0e7-0000-7000-8000-00000000ff43",
      "0199e0e7-0000-7000-8000-00000000ff44",
    ] as const;

    it(
      "loads a skill of a checkout when the session reads there, unless the adapter knows the checkout",
      async () => {
        const lay = ({ web }: { readonly web: string }) =>
          writeSkill(join(web, ".claude", "skills"), "from-web");

        const unknown = await readProjectSkillsAfterRead(SKILL_SESSION_IDS[0], lay, false);
        const known = await readProjectSkillsAfterRead(SKILL_SESSION_IDS[1], lay, true);

        // The first run shows the skill loads on this CLI version, so the
        // second run's result means something.
        expect(unknown).toEqual(["from-web"]);
        expect(known).toEqual([]);
      },
      Duration.toMillis(TURN_DEADLINE) * 3,
    );

    it(
      "loads none of the user's skills when a checkout links its skills folder to them",
      async () => {
        const lay = ({ web, userHome }: { readonly web: string; readonly userHome: string }) => {
          writeSkill(join(userHome, ".claude", "skills"), "user-skill");
          mkdirSync(join(web, ".claude"), { recursive: true });
          symlinkSync(join(userHome, ".claude", "skills"), join(web, ".claude", "skills"));
        };

        const unknown = await readProjectSkillsAfterRead(SKILL_SESSION_IDS[2], lay, false);
        const known = await readProjectSkillsAfterRead(SKILL_SESSION_IDS[3], lay, true);

        expect(unknown).toEqual(["user-skill"]);
        expect(known).toEqual([]);
      },
      Duration.toMillis(TURN_DEADLINE) * 3,
    );

    it(
      "still loads a skill from a skills folder deeper than the checkout's root (a known gap)",
      async () => {
        // Claude looks at every directory down to the file, and the adapter
        // lists only the checkout's own `.claude/skills`. The folder cannot be
        // known before the session reads there (spec 06 section 9.4).
        const lay = ({ web }: { readonly web: string }) =>
          writeSkill(join(web, "src", ".claude", "skills"), "deep");

        const known = await readProjectSkillsAfterRead(SKILL_SESSION_IDS[4], lay, true);

        expect(known).toEqual(["deep"]);
      },
      Duration.toMillis(TURN_DEADLINE) * 2,
    );
  },
);

/**
 * Replays a recorded live run with two subagents through the adapter, and
 * checks the events a user would see (spec 06 section 13, #436). The fixture
 * was recorded from CLI 2.1.289 and scrubbed. Each line is one of these:
 *
 * - `{ frame }`: a message the SDK's query yielded;
 * - `{ canUseTool }`: the SDK called the adapter's `canUseTool` at that point.
 *
 * In the run, the session's own agent starts a foreground subagent, "outer",
 * which starts a background subagent, "inner". Both ask to use `Write` and wait
 * at the same time. Then outer asks to use `Bash`.
 */
const OUTER = "ad748b185e19d61f8";
const INNER = "adea95d9b3725e861";
const OUTER_CALL = "toolu_01EsHF3WZdK6G3jSgav7n4UZ";
const INNER_CALL = "toolu_01JEeMqQEM6B3HzmtSfRWfx5";
const OUTER_WRITE = "toolu_01Y4bUpLFTVZ93qtPjkgEt2E";
const INNER_WRITE = "toolu_011XTxjP7YJZR7Cn1kGy2aTQ";
const OUTER_BASH = "toolu_01QouyZpMyyiKxyVS4rqX4uX";

/**
 * The ids of the messages the subagents sent. None may show up in an event of
 * the session's own agent.
 */
const SUBAGENT_MESSAGES = [
  "msg_011CfjqhJP1D4UWmZiWKW5qv",
  "msg_011CfjqhYFgm38ZyBq2WUx3z",
  "msg_011CfjqhYGRqicxjCpcRmx4E",
  "msg_011CfjqhiMQ1nPVDXRWN857u",
];

/** The `system` subtypes that only report progress, and must produce no event. */
const PROGRESS_SUBTYPES = ["task_progress", "task_updated", "background_tasks_changed"];

const REPLAY_SESSION = "0199e0e7-0000-7000-8000-00000000ff0b";

/** The arguments the SDK passed to `canUseTool`, as the fixture recorded them. */
type CanUseToolCall = {
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  readonly toolUseID: string;
  readonly agentID?: string;
};

/**
 * What the host did at that point of a recorded run: stopped one subagent, or
 * interrupted the whole session.
 */
type HostAction = { readonly stopTask: string } | { readonly interrupt: true };

type FixtureLine =
  | { readonly frame: SDKMessage }
  | { readonly canUseTool: CanUseToolCall }
  | { readonly host: HostAction };

/** Reads a recorded run, one fixture line per JSON line of the file. */
const readFixture = (name: string): ReadonlyArray<FixtureLine | { readonly scenario: string }> =>
  readFileSync(new URL(name, import.meta.url), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as FixtureLine | { readonly scenario: string });

const FIXTURE = readFixture("./claude-code-subagents.fixture.jsonl") as ReadonlyArray<FixtureLine>;

const FIXTURE_FRAMES: ReadonlyArray<SDKMessage> = FIXTURE.flatMap((line) =>
  "frame" in line ? [line.frame] : [],
);

/** Returns the ids of the tool calls whose results a frame carries. */
const readToolResultIds = (frame: SDKMessage): ReadonlyArray<string> =>
  frame.type === "user" && Array.isArray(frame.message.content)
    ? frame.message.content.flatMap((block) =>
        block.type === "tool_result" ? [block.tool_use_id] : [],
      )
    : [];

/**
 * Returns the id of the tool call whose shell a frame reports started, or
 * none. Claude runs a `Bash` call as a shell task, and starts it only once the
 * call is allowed.
 */
const readShellToolCallIds = (frame: SDKMessage): ReadonlyArray<string> =>
  frame.type === "system" &&
  frame.subtype === "task_started" &&
  frame.task_type === "local_bash" &&
  frame.tool_use_id !== undefined
    ? [frame.tool_use_id]
    : [];

/**
 * Returns the id of the request the adapter opened for a tool call, or
 * `undefined` when it opened none.
 */
const findRequestIdForToolCall = (
  events: ReadonlyArray<ProviderEvent>,
  toolUseId: string,
): string | undefined =>
  events.flatMap((event) =>
    event._tag === "request.opened" && event.request.itemId === toolUseId
      ? [event.request.requestId]
      : [],
  )[0];

/** Returns the SDK message an event carries as its raw payload, or `undefined`. */
const readRawFrame = (event: ProviderEvent): Readonly<Record<string, unknown>> | undefined => {
  const payload: unknown = event.raw?.payload;
  return typeof payload === "object" && payload !== null && !Array.isArray(payload)
    ? (payload as Readonly<Record<string, unknown>>)
    : undefined;
};

/** Checks whether an SDK message only reports the progress of a subagent. */
const isProgressReport = (frame: Readonly<Record<string, unknown>> | undefined): boolean =>
  frame?.["type"] === "system" && PROGRESS_SUBTYPES.includes(String(frame["subtype"]));

/**
 * Returns the position of the event that carries a frame as its raw payload.
 * The adapter puts the payload on the first event it emits for the frame
 * itself, after any event that opens a turn.
 */
const findEventCarryingFrame = (events: ReadonlyArray<ProviderEvent>, frame: SDKMessage): number =>
  events.findIndex((event) => readRawFrame(event)?.["uuid"] === frame.uuid);

/** Checks whether an event belongs to the session's own agent rather than a subagent. */
const isOwnAgentEvent = (event: ProviderEvent): boolean =>
  !("subagentId" in event) || event.subagentId === undefined;

/** What one replay of a recorded run produced. */
interface Replay {
  /** Every event the adapter emitted, in order, up to and including `session.exited`. */
  readonly events: ReadonlyArray<ProviderEvent>;
  /**
   * The events the adapter emitted for the recorded run itself, before the
   * replay stopped the session.
   */
  readonly eventsBeforeStop: ReadonlyArray<ProviderEvent>;
  /** The decision each `canUseTool` call returned, by tool call id. */
  readonly decisions: ReadonlyMap<string, unknown>;
  /** The subagent id of each `stopTask` the adapter sent the harness, in order. */
  readonly stopTasks: ReadonlyArray<string>;
  /** How many times the adapter sent the harness `interrupt()`. */
  readonly interrupts: number;
}

/**
 * Replays a recorded run through the adapter, as one session, and returns
 * every event it emitted. Fails when the adapter supplies no `canUseTool`,
 * opens no request for a tool call the replay has to answer, or does not send
 * the harness the `stopTask` a host stop line asks for.
 *
 * A tool call is allowed when the CLI went on to run it: just before the frame
 * that carries its result, or the `task_started` of its shell. At a host line
 * the replay calls the adapter's `interrupt`, as the controller would.
 *
 * The replay waits only for conditions, never for time. The fake query hands
 * the adapter one frame, then waits until the adapter asks for the next one,
 * which it does after it has handled the frame. A tool call is answered once
 * its `request.opened` event has arrived, and the replay ends once
 * `session.exited` has arrived.
 */
const replayFixture = async (
  sessionId: string,
  lines: ReadonlyArray<FixtureLine>,
): Promise<Replay> => {
  let options: Options | undefined;
  let deliver: ((result: IteratorResult<SDKMessage>) => void) | undefined;
  let onPull: (() => void) | undefined;
  const stopTasks: Array<string> = [];
  let interrupts = 0;
  const adapter = makeClaudeCodeAdapter({
    stream: (params) => {
      options = params.options;
      return {
        [Symbol.asyncIterator]: () => ({
          next: () =>
            new Promise<IteratorResult<SDKMessage>>((resolve) => {
              deliver = resolve;
              onPull?.();
              onPull = undefined;
            }),
        }),
        interrupt: () => {
          interrupts += 1;
          return Promise.resolve();
        },
        setModel: () => Promise.resolve(),
        stopTask: (taskId) => {
          stopTasks.push(taskId);
          return Promise.resolve();
        },
        close: () => deliver?.({ done: true, value: undefined }),
      };
    },
    query: () => {
      throw new Error("this test replays a session, not a probe");
    },
    run: () => Effect.succeed({ code: 0, stdout: "", stderr: "" }),
  });

  const seen: Array<ProviderEvent> = [];
  Effect.runFork(
    Stream.runForEach(adapter.events, (event) => Effect.sync(() => void seen.push(event))),
  );

  /** Waits until the adapter is waiting for its next frame. */
  const waitForPull = (): Promise<void> =>
    deliver !== undefined
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          onPull = resolve;
        });

  /** Hands the adapter one frame and waits until it has handled it. */
  const deliverFrame = async (frame: SDKMessage): Promise<void> => {
    await waitForPull();
    const send = deliver!;
    deliver = undefined;
    send({ done: false, value: frame });
    await waitForPull();
  };

  await Effect.runPromise(
    adapter.startSession(
      sessionId,
      { ...SPEC, modelSelection: { model: "claude-sonnet-5-5", options: {} } },
      {
        cwd: "/workspace",
        attachmentsDir: null,
        editMarks: null,
        attachmentUploader: NO_CONTROLLER_UPLOADER,
        home: "/var/hercule/runner/providers/replay",
        binary: "/usr/local/bin/claude",
        env: { PATH: "/usr/bin" },
        secrets: {},
        herculeTool: {
          orientation: "",
          skill: "",
          claudePluginDir: "/var/hercule/runner/storage/claude-plugin",
        },
      },
    ),
  );

  const waiting: Array<{ readonly toolUseId: string; readonly decision: Promise<unknown> }> = [];
  const decisions = new Map<string, unknown>();

  /**
   * Allows every tool call that is waiting, the newest first. In the live run
   * the user answered inner's `Write` before outer's.
   */
  const allowWaitingToolCalls = async (): Promise<void> => {
    for (const { toolUseId, decision } of waiting.toReversed()) {
      const requestId = await vi.waitUntil(() => findRequestIdForToolCall(seen, toolUseId), {
        timeout: 5_000,
      });
      await Effect.runPromise(adapter.respondToApprovalRequest(sessionId, requestId, "allow"));
      decisions.set(toolUseId, await decision);
    }
    waiting.length = 0;
  };

  for (const [index, line] of lines.entries()) {
    if ("frame" in line) {
      // The CLI runs a tool, and so starts its shell or sends its result, only
      // after the tool call is allowed.
      const ran = [...readToolResultIds(line.frame), ...readShellToolCallIds(line.frame)];
      if (waiting.some(({ toolUseId }) => ran.includes(toolUseId))) {
        await allowWaitingToolCalls();
      }
      await deliverFrame(line.frame);
      continue;
    }
    if ("host" in line) {
      if ("stopTask" in line.host) {
        const subagentId = line.host.stopTask;
        await Effect.runPromise(adapter.interrupt(sessionId, subagentId));
        expect(stopTasks, `the adapter sent no stopTask for ${subagentId}`).toContain(subagentId);
      } else {
        await Effect.runPromise(adapter.interrupt(sessionId));
      }
      continue;
    }
    const { toolName, input, toolUseID, agentID } = line.canUseTool;
    const canUseTool = options?.canUseTool;
    if (canUseTool === undefined) throw new Error("the adapter supplied no canUseTool");
    waiting.push({
      toolUseId: toolUseID,
      decision: canUseTool(toolName, input, {
        signal: new AbortController().signal,
        toolUseID,
        // The SDK's own control request id. The recording leaves it out, and
        // the adapter never reads it.
        requestId: `control-${index + 1}`,
        ...(agentID === undefined ? {} : { agentID }),
      }),
    });
  }

  const eventsBeforeStop = [...seen];
  await Effect.runPromise(adapter.stopSession(sessionId, "stopped"));
  await vi.waitUntil(() => seen.some((event) => event._tag === "session.exited"), {
    timeout: 5_000,
  });
  return { events: seen, eventsBeforeStop, decisions, stopTasks, interrupts };
};

describe("a recorded Claude Code run with a nested subagent, replayed", () => {
  let events: ReadonlyArray<ProviderEvent> = [];
  let decisions: ReadonlyMap<string, unknown> = new Map();
  beforeAll(async () => {
    ({ events, decisions } = await replayFixture(REPLAY_SESSION, FIXTURE));
  });

  it("encodes every event with the protocol schema", () => {
    const encode = Schema.encodeUnknownSync(ProviderEvent);
    for (const event of events) expect(() => encode(event), JSON.stringify(event)).not.toThrow();
  });

  it("drops no frame and exits once", () => {
    expect(events.filter((event) => event._tag === "runtime.warning")).toEqual([]);
    expect(events.filter((event) => event._tag === "session.exited")).toHaveLength(1);
  });

  it("gives the session's own agent one turn, from its first message to the result", () => {
    const started = events.filter(
      (event) => event._tag === "turn.started" && isOwnAgentEvent(event),
    );
    const completed = events.filter(
      (event) => event._tag === "turn.completed" && isOwnAgentEvent(event),
    );
    expect(started).toHaveLength(1);
    expect(completed).toEqual([
      expect.objectContaining({
        state: "completed",
        turnId: (started[0] as Extract<ProviderEvent, { _tag: "turn.started" }>).turnId,
      }),
    ]);

    // The turn opens with the first message of the session's own agent: no
    // earlier stream event opens it.
    const firstMessage = FIXTURE_FRAMES.find(
      (frame) => frame.type === "assistant" && frame.parent_tool_use_id === null,
    )!;
    const carryingFirstMessage = findEventCarryingFrame(events, firstMessage);
    expect(carryingFirstMessage).toBeGreaterThan(0);
    expect(events[carryingFirstMessage - 1]).toBe(started[0]);

    // The turn ends with the result, the last frame of the run.
    const result = FIXTURE_FRAMES.find((frame) => frame.type === "result")!;
    expect(FIXTURE_FRAMES.at(-1)).toBe(result);
    const carryingResult = findEventCarryingFrame(events, result);
    expect(carryingResult).toBeGreaterThanOrEqual(0);
    expect(events.indexOf(completed[0]!)).toBeGreaterThanOrEqual(carryingResult);
  });

  it("keeps subagent content out of the session's own agent's transcript", () => {
    const reply = events
      .flatMap((event) =>
        event._tag === "content.delta" &&
        isOwnAgentEvent(event) &&
        event.streamKind === "assistant_text"
          ? [event.delta]
          : [],
      )
      .join("");
    expect(reply).toBe("Both files (inner.txt and outer.txt) were created.");
    // The transcript holds only the `Agent` call and the reply.
    expect(
      events.flatMap((event) =>
        event._tag === "item.started" && isOwnAgentEvent(event) ? [event.itemId] : [],
      ),
    ).toEqual([OUTER_CALL, "msg_011CfjqhrigSwVhSJEp6AAz6#0"]);

    const subagentContent = [
      INNER_CALL,
      OUTER_WRITE,
      INNER_WRITE,
      OUTER_BASH,
      ...SUBAGENT_MESSAGES,
    ];
    for (const event of events) {
      if (!isOwnAgentEvent(event) || event._tag === "subagent.started") continue;
      const encoded = JSON.stringify(event);
      for (const marker of subagentContent) {
        expect(encoded, `an event of the session's own agent carries ${marker}`).not.toContain(
          marker,
        );
      }
    }
  });

  it("introduces each subagent before its own events, with its parent", () => {
    // Outer is introduced by the session's own agent, inner by outer. Each is
    // linked to the `Agent` call that started it, in its parent's transcript.
    const introductions = events.filter((event) => event._tag === "subagent.started");
    expect(introductions).toEqual([
      expect.objectContaining({
        subagentId: OUTER,
        itemId: OUTER_CALL,
        description: "Outer nested agent task",
        agentType: "general-purpose",
      }),
      expect.objectContaining({
        subagentId: INNER,
        parentSubagentId: OUTER,
        itemId: INNER_CALL,
        description: "Create inner.txt",
        agentType: "general-purpose",
      }),
    ]);
    expect(introductions[0]).not.toHaveProperty("parentSubagentId");
    const agentCalls = events.filter(
      (event) =>
        event._tag === "item.started" &&
        (event.itemId === OUTER_CALL || event.itemId === INNER_CALL),
    );
    expect(agentCalls).toEqual([
      expect.objectContaining({ itemId: OUTER_CALL, kind: "subagent" }),
      expect.objectContaining({ itemId: INNER_CALL, kind: "subagent", subagentId: OUTER }),
    ]);
    expect(isOwnAgentEvent(agentCalls[0]!)).toBe(true);

    for (const subagentId of [OUTER, INNER]) {
      const introduced = events.findIndex(
        (event) => event._tag === "subagent.started" && event.subagentId === subagentId,
      );
      const firstOwn = events.findIndex(
        (event) =>
          "subagentId" in event &&
          event.subagentId === subagentId &&
          event._tag !== "subagent.started",
      );
      expect(introduced, subagentId).toBeGreaterThanOrEqual(0);
      expect(introduced, subagentId).toBeLessThan(firstOwn);
    }
  });

  it("gives each subagent one turn with its model and no Token Usage", () => {
    // Claude reports no Token Usage that is exact for a subagent, so a
    // subagent's turn ends without one.
    for (const subagentId of [OUTER, INNER]) {
      const started = events.filter(
        (event) => event._tag === "turn.started" && event.subagentId === subagentId,
      );
      const completed = events.filter(
        (event) => event._tag === "turn.completed" && event.subagentId === subagentId,
      );
      expect(started, subagentId).toEqual([
        expect.objectContaining({ model: "claude-sonnet-5-5" }),
      ]);
      expect(completed, subagentId).toEqual([
        expect.objectContaining({
          state: "completed",
          turnId: (started[0] as Extract<ProviderEvent, { _tag: "turn.started" }>).turnId,
        }),
      ]);
      for (const field of ["usage", "costUsd", "structuredResult"]) {
        expect(completed[0], subagentId).not.toHaveProperty(field);
      }
    }
    expect(
      events.filter((event) => event._tag === "session.usage.updated" && !isOwnAgentEvent(event)),
    ).toEqual([]);
  });

  it("opens both writes at once and resolves each before its agent's turn ends", () => {
    for (const toolUseId of [INNER_WRITE, OUTER_WRITE, OUTER_BASH]) {
      expect(decisions.get(toolUseId), toolUseId).toMatchObject({ behavior: "allow" });
    }

    // Both writes wait at once, each on its own subagent, and the answers
    // come back in the other order.
    const innerWrite = findRequestIdForToolCall(events, INNER_WRITE);
    const outerWrite = findRequestIdForToolCall(events, OUTER_WRITE);
    const outerBash = findRequestIdForToolCall(events, OUTER_BASH);
    expect(new Set([innerWrite, outerWrite, outerBash]).size).toBe(3);
    expect(
      events
        .filter((event) => event._tag === "request.opened" || event._tag === "request.resolved")
        .map((event) =>
          event._tag === "request.opened"
            ? { opened: event.request.requestId, subagentId: event.subagentId }
            : { resolved: event.requestId, subagentId: event.subagentId },
        ),
    ).toEqual([
      { opened: outerWrite, subagentId: OUTER },
      { opened: innerWrite, subagentId: INNER },
      { resolved: innerWrite, subagentId: INNER },
      { resolved: outerWrite, subagentId: OUTER },
      { opened: outerBash, subagentId: OUTER },
      { resolved: outerBash, subagentId: OUTER },
    ]);
    for (const [requestId, subagentId] of [
      [innerWrite, INNER],
      [outerWrite, OUTER],
      [outerBash, OUTER],
    ] as const) {
      const resolved = events.findIndex(
        (event) => event._tag === "request.resolved" && event.requestId === requestId,
      );
      const turnEnded = events.findIndex(
        (event) => event._tag === "turn.completed" && event.subagentId === subagentId,
      );
      expect(resolved, String(requestId)).toBeGreaterThanOrEqual(0);
      expect(resolved, String(requestId)).toBeLessThan(turnEnded);
    }
  });

  it("puts each tool call in the transcript of the subagent that made it", () => {
    for (const [toolUseId, subagentId] of [
      [OUTER_WRITE, OUTER],
      [INNER_WRITE, INNER],
      [OUTER_BASH, OUTER],
    ] as const) {
      const items = events.filter(
        (event) =>
          (event._tag === "item.started" || event._tag === "item.completed") &&
          event.itemId === toolUseId,
      );
      expect(
        items.map((event) => event._tag),
        toolUseId,
      ).toEqual(["item.started", "item.completed"]);
      for (const item of items) expect(item, toolUseId).toMatchObject({ subagentId });
    }
  });

  it("produces nothing for progress reports", () => {
    // The fixture holds progress reports, so the check below is not empty.
    expect(FIXTURE_FRAMES.filter((frame) => isProgressReport(frame)).length).toBeGreaterThan(0);
    // Any event the adapter made from a progress report, other than one that
    // opens a turn, would carry the report as its raw payload.
    expect(events.filter((event) => isProgressReport(readRawFrame(event)))).toEqual([]);
  });
});

/**
 * Replays recorded live runs in which the host stopped subagents, and checks
 * that each stopped subagent reads `stopped` and that the stop sets no agent
 * working again (spec 06 sections 13.4 and 13.6, #436). The fixture was
 * recorded from CLI 2.1.289 and scrubbed. It holds several runs, each one
 * after a `{ scenario }` line, and besides the lines of the fixture above it
 * has `{ host }` lines: the host called `stopTask` for one subagent, or
 * `interrupt()` for the whole session, at that point.
 */
const STOP_SCENARIOS: ReadonlyMap<string, ReadonlyArray<FixtureLine>> = (() => {
  const scenarios = new Map<string, Array<FixtureLine>>();
  let current: Array<FixtureLine> | undefined;
  for (const line of readFixture("./claude-code-subagents-stop.fixture.jsonl")) {
    if ("scenario" in line) {
      current = [];
      scenarios.set(line.scenario, current);
    } else {
      current!.push(line);
    }
  }
  return scenarios;
})();

/** Returns the `turn.completed` events of one agent, or of the session's own agent. */
const listTurnEnds = (
  events: ReadonlyArray<ProviderEvent>,
  subagentId: string | undefined,
): ReadonlyArray<Extract<ProviderEvent, { _tag: "turn.completed" }>> =>
  events.filter(
    (event): event is Extract<ProviderEvent, { _tag: "turn.completed" }> =>
      event._tag === "turn.completed" && event.subagentId === subagentId,
  );

/** Returns the `turn.started` events of one agent, or of the session's own agent. */
const listTurnStarts = (
  events: ReadonlyArray<ProviderEvent>,
  subagentId: string | undefined,
): ReadonlyArray<Extract<ProviderEvent, { _tag: "turn.started" }>> =>
  events.filter(
    (event): event is Extract<ProviderEvent, { _tag: "turn.started" }> =>
      event._tag === "turn.started" && event.subagentId === subagentId,
  );

/** Returns the ids of the turns that started and have not completed. */
const listOpenTurnIds = (events: ReadonlyArray<ProviderEvent>): ReadonlyArray<string> => {
  const ended = new Set(
    events.flatMap((event) => (event._tag === "turn.completed" ? [event.turnId] : [])),
  );
  return events.flatMap((event) =>
    event._tag === "turn.started" && !ended.has(event.turnId) ? [event.turnId] : [],
  );
};

/**
 * Checks that a stopped subagent reads `stopped`: it has a turn that ended
 * `interrupted`, its last turn ended `interrupted`, and none of its turns ended
 * `completed` after the first one interrupted.
 */
const expectStopped = (events: ReadonlyArray<ProviderEvent>, subagentId: string): void => {
  const ends = listTurnEnds(events, subagentId);
  const stopped = ends.findIndex((end) => end.state === "interrupted");
  expect(stopped, `${subagentId} has no interrupted turn`).toBeGreaterThanOrEqual(0);
  expect(ends.at(-1)?.state, subagentId).toBe("interrupted");
  expect(
    ends.slice(stopped).map((end) => end.state),
    `${subagentId} completed a turn after it was stopped`,
  ).not.toContain("completed");
};

const STOPPED_OUTER = "a8c1fa90413e76396";
const STOPPED_INNER = "a1dd814294a45cd7b";
const STOPPED_OUTER_CALL = "toolu_01BhgdpXbb7UZmCms59EfpgR";
const STOPPED_INNER_CALL = "toolu_01V9uiPLDJ9xJybTXJnWWHjy";
/** The ids of the shell tasks the subagents' `Bash` calls started. */
const SHELL_TASKS = ["blrg07p6w", "befpfikgv", "bw3n8gm12"];

const STOP_TREE_SESSION = "0199e0e7-0000-7000-8000-00000000ff0c";
const INTERRUPT_ALL_SESSION = "0199e0e7-0000-7000-8000-00000000ff0d";

/**
 * In the run, the session's own agent starts a foreground subagent, "outer",
 * which starts a background subagent, "inner". Each runs a long `Bash`
 * command. The host stops inner, then outer. After each stop the CLI still
 * sends two late messages from the stopped subagent: the rejected tool result
 * and "[Request interrupted by user for tool use]". Then the session's own
 * agent replies and its turn ends.
 */
describe("a recorded Claude Code run whose subagents the host stopped, replayed", () => {
  let replay: Replay;
  beforeAll(async () => {
    replay = await replayFixture(STOP_TREE_SESSION, STOP_SCENARIOS.get("stop-tree")!);
  });

  it("encodes every event with the protocol schema", () => {
    const encode = Schema.encodeUnknownSync(ProviderEvent);
    for (const event of replay.events) {
      expect(() => encode(event), JSON.stringify(event)).not.toThrow();
    }
  });

  it("introduces the two subagents, and no shell task as a subagent", () => {
    expect(replay.events.filter((event) => event._tag === "subagent.started")).toEqual([
      expect.objectContaining({ subagentId: STOPPED_OUTER, itemId: STOPPED_OUTER_CALL }),
      expect.objectContaining({
        subagentId: STOPPED_INNER,
        parentSubagentId: STOPPED_OUTER,
        itemId: STOPPED_INNER_CALL,
      }),
    ]);
    for (const event of replay.events) {
      const encoded = JSON.stringify(event);
      for (const task of SHELL_TASKS) {
        if ("subagentId" in event) expect(event.subagentId, encoded).not.toBe(task);
        if ("parentSubagentId" in event) expect(event.parentSubagentId, encoded).not.toBe(task);
      }
    }
  });

  it("sends stopTask once for each subagent, and none again for inner when outer stops", () => {
    expect(replay.stopTasks).toEqual([STOPPED_INNER, STOPPED_OUTER]);
    expect(replay.interrupts).toBe(0);
  });

  it("leaves each stopped subagent stopped, through its late messages", () => {
    for (const subagentId of [STOPPED_OUTER, STOPPED_INNER]) {
      expectStopped(replay.eventsBeforeStop, subagentId);
    }
  });

  it("leaves no turn open when the run ends", () => {
    expect(listOpenTurnIds(replay.eventsBeforeStop)).toEqual([]);
  });

  it("gives the session's own agent one turn, which completes", () => {
    const started = listTurnStarts(replay.eventsBeforeStop, undefined);
    expect(started).toHaveLength(1);
    expect(listTurnEnds(replay.eventsBeforeStop, undefined)).toEqual([
      expect.objectContaining({ turnId: started[0]!.turnId, state: "completed" }),
    ]);
  });
});

const BACKGROUND = "a05b29375c71392eb";

/**
 * In the run, the session's own agent starts a background subagent and its
 * turn ends. While only the subagent works, on a long `Bash` command, the host
 * interrupts the session. The CLI stops the subagent and still sends its two
 * late messages.
 */
describe("a recorded Claude Code run interrupted while only a subagent works, replayed", () => {
  let replay: Replay;
  beforeAll(async () => {
    replay = await replayFixture(INTERRUPT_ALL_SESSION, STOP_SCENARIOS.get("interrupt-all")!);
  });

  it("encodes every event with the protocol schema", () => {
    const encode = Schema.encodeUnknownSync(ProviderEvent);
    for (const event of replay.events) {
      expect(() => encode(event), JSON.stringify(event)).not.toThrow();
    }
  });

  it("sends the harness the interrupt, because a subagent is working", () => {
    expect(replay.interrupts).toBe(1);
    expect(replay.stopTasks).toEqual([]);
  });

  it("leaves the subagent stopped, through its late messages", () => {
    expect(
      replay.events
        .filter((event) => event._tag === "subagent.started")
        .map((event) => event.subagentId),
    ).toEqual([BACKGROUND]);
    expectStopped(replay.eventsBeforeStop, BACKGROUND);
  });

  it("opens no turn of the session's own agent after its first one, and leaves nothing working", () => {
    const started = listTurnStarts(replay.eventsBeforeStop, undefined);
    expect(started).toHaveLength(1);
    expect(listTurnEnds(replay.eventsBeforeStop, undefined)).toEqual([
      expect.objectContaining({ turnId: started[0]!.turnId, state: "completed" }),
    ]);
    expect(listOpenTurnIds(replay.eventsBeforeStop)).toEqual([]);
  });
});

/**
 * Checks that the overrides the adapter writes for a checkout's own
 * `.claude/skills` turn those skills off in a real Claude Code, so each one is
 * listed once, from the repository plugin. Claude keys a native skill by its
 * folder name, even when the `name` in its SKILL.md says something else, so
 * the folder `foo` holding `name: bar` must still be turned off. `HOME` and
 * the config directory are temporary, so nothing of the developer's own
 * installation is read.
 */
describe.skipIf(binary === undefined)(
  "native skills in a single-checkout Claude Code session",
  () => {
    const NATIVE_SKILLS_SESSION_ID = "0199e0e7-0000-7000-8000-00000000ff40";

    it(
      "lists a skill once whether its frontmatter name matches its folder, differs from it, or is missing",
      async () => {
        const root = createTemporaryHome();
        const userHome = join(root, "user");
        mkdirSync(userHome);
        const checkout = join(root, "checkout");
        mkdirSync(checkout);
        const initialized = Bun.spawnSync(["git", "-C", checkout, "init", "--quiet"]);
        expect(initialized.exitCode, initialized.stderr.toString()).toBe(0);
        const pluginFolder = join(root, "repository-skills", "checkout");
        mkdirSync(join(pluginFolder, ".claude-plugin"), { recursive: true });
        writeFileSync(
          join(pluginFolder, ".claude-plugin", "plugin.json"),
          `${JSON.stringify({ name: "repo-checkout" })}\n`,
        );
        mkdirSync(join(pluginFolder, "skills"));
        const frontmatters = {
          same: "name: same\n",
          foo: "name: bar\n",
          unnamed: "",
        };
        for (const [folder, nameLine] of Object.entries(frontmatters)) {
          const skillFolder = join(checkout, ".claude", "skills", folder);
          mkdirSync(skillFolder, { recursive: true });
          writeFileSync(
            join(skillFolder, "SKILL.md"),
            `---\n${nameLine}description: The ${folder} skill.\n---\n\nNothing.\n`,
          );
          symlinkSync(skillFolder, join(pluginFolder, "skills", folder));
        }
        const home = join(root, "instance");
        mkdirSync(home);
        let running: Query | undefined;
        const adapter = makeClaudeCodeAdapter({
          stream: ({ options: streamOptions, input }) => {
            const started = sdkQuery({ prompt: input, options: streamOptions });
            running = started;
            return {
              [Symbol.asyncIterator]: () => started[Symbol.asyncIterator](),
              interrupt: () => started.interrupt().then(() => undefined),
              setModel: (model) => started.setModel(model),
              stopTask: (taskId) => started.stopTask(taskId),
              close: () => void started.return(undefined).catch(() => undefined),
            };
          },
          query: () => {
            throw new Error("these tests start sessions, not probes");
          },
          run: runProcess,
        });
        const context: ProviderRunnerContext = {
          cwd: checkout,
          attachmentsDir: null,
          editMarks: null,
          attachmentUploader: NO_CONTROLLER_UPLOADER,
          home,
          binary: binary!,
          env: {
            PATH: process.env["PATH"] ?? "",
            HOME: userHome,
            ANTHROPIC_API_KEY: "sk-ant-placeholder",
          },
          secrets: {},
          herculeTool: prepareTool(),
          repositorySkillsFolders: [pluginFolder],
        };
        const spec: SessionSpec = { ...SPEC, workspaceId: "0199e0e7-0000-7000-8000-00000000000b" };

        await Effect.runPromise(adapter.startSession(NATIVE_SKILLS_SESSION_ID, spec, context));
        try {
          await running!.initializationResult();
          const usage = await running!.getContextUsage({ detail: "summary" });
          const listed = (usage.skills?.skillFrontmatter ?? [])
            .flatMap((skill) =>
              skill.source === "built-in" ? [] : [`${skill.name} (${skill.source})`],
            )
            .sort();
          expect(listed).toEqual([
            "hercule:hercule (plugin)",
            "repo-checkout:bar (plugin)",
            "repo-checkout:same (plugin)",
            "repo-checkout:unnamed (plugin)",
          ]);

          // Control: without the overrides, Claude does load the three skills
          // natively (the folder `foo` under its frontmatter name `bar`), so the
          // list above is empty of them because of the overrides.
          const plain = sdkQuery({
            // A prompt that never arrives: the session starts and sends no turn.
            prompt: {
              [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => undefined) }),
            },
            options: {
              pathToClaudeCodeExecutable: binary!,
              cwd: checkout,
              settingSources: ["project"],
              env: context.env,
            },
          });
          try {
            await plain.initializationResult();
            const native = (await plain.getContextUsage({ detail: "summary" })).skills;
            expect(
              (native?.skillFrontmatter ?? [])
                .flatMap((skill) => (skill.source === "projectSettings" ? [skill.name] : []))
                .sort(),
            ).toEqual(["bar", "same", "unnamed"]);
          } finally {
            plain.close();
          }
        } finally {
          await Effect.runPromise(adapter.stopSession(NATIVE_SKILLS_SESSION_ID, "stopped"));
        }
      },
      Duration.toMillis(PROBE_DEADLINE) * 2,
    );
  },
);
