/**
 * Proves the vendor SDK still hands back the shapes the stubbed tests beside
 * this one assume.
 *
 * The probe runs against a temporary config directory and never touches the
 * developer's own `~/.claude`. The session cannot: a login lives in the config
 * directory and nowhere else, and on macOS it is a Keychain item keyed by that
 * directory, so it cannot be copied into a temporary one. That test therefore
 * uses the developer's own login, spends a few tokens of it, and is opt-in.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Duration, Effect, Stream } from "effect";
import type { OutputSchema, ProviderEvent, SessionSpec } from "@hydra/protocol";
import { FIXTURE_SCHEMA, IMPOSSIBLE_SCHEMA } from "@hydra/protocol/output-schema.fixture";
import { prepareTooling } from "../sessions/tooling";
import { claudeCode } from "./claude-code";
import { PROBE_DEADLINE } from "./probe";
import type { ProviderRunnerContext } from "./index";

const binary = Bun.which("claude") ?? undefined;

const homes: Array<string> = [];

afterAll(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const emptyHome = (): string => {
  const home = mkdtempSync(join(tmpdir(), "hydra-claude-probe-"));
  homes.push(home);
  return home;
};

/**
 * hydra-as-a-tool as the contexts here carry it: a real plugin directory,
 * because a path that is not one is a plugin the CLI would have to refuse. The
 * skill case below writes its own, with a marker in it.
 *
 * Made on first use, so a run that skips every case here writes nothing.
 */
let tool: ProviderRunnerContext["hydraTool"] | undefined;
const TOOL = (): ProviderRunnerContext["hydraTool"] => {
  if (tool === undefined) {
    const under = emptyHome();
    const {
      hydraTool: { claudePluginDir },
    } = prepareTooling({
      home: join(under, "home"),
      storageDir: join(under, "storage"),
      execPath: process.execPath,
      skill: "# hydra\n\nNothing this test asks about.\n",
    });
    tool = { skill: "", claudePluginDir };
  }
  return tool;
};

const installedVersion = async (path: string): Promise<string> => {
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
        home: emptyHome(),
        binary: binary!,
        env: { PATH: process.env["PATH"] ?? "" },
        secrets: {},
        hydraTool: TOOL(),
      };

      const started = Date.now();
      const probed = await Effect.runPromise(claudeCode.probe(context, {}));
      const took = Date.now() - started;

      // Not `error`: an empty config dir is a machine nobody has logged in on,
      // and telling that apart from a broken harness is the whole point.
      expect(probed.auth.status, probed.auth.message ?? "").toBe("unauthenticated");
      expect(probed.auth.identity).toBeUndefined();
      expect(probed.harnessVersion).toBe(await installedVersion(binary!));
      // The catalogue is probed, never authored: an empty one would leave the
      // composer with nothing to offer on a perfectly good machine.
      expect(probed.models.length).toBeGreaterThan(0);
      for (const model of probed.models) expect(model.slug).not.toBe("");

      expect(took).toBeLessThan(Duration.toMillis(PROBE_DEADLINE));
      // Vitest's own budget, aligned with the deadline under test rather than
      // left at its default five seconds: a probe that takes its full fifteen is
      // the failure this case exists to report, not one for vitest to cut short.
    },
    Duration.toMillis(PROBE_DEADLINE) * 2,
  );
});

/**
 * The config directory the session runs against. Everything else about it stays
 * isolated: a throwaway cwd, no setting sources, no auto memory.
 */
const CONFIG_DIR = process.env["CLAUDE_CONFIG_DIR"] ?? join(homedir(), ".claude");

/**
 * Opt-in, because the alternative is that `pnpm test` on any developer's
 * machine quietly spends their subscription and takes a minute doing it.
 */
const wanted = process.env["HYDRA_LIVE_SESSION_TEST"] !== undefined;

const SESSION = "0199e0e7-0000-7000-8000-0000000000ff";

const SPEC: SessionSpec = {
  instanceId: "0199e0e7-0000-7000-8000-00000000000a",
  workspaceId: null,
  // The cheapest model that answers, and no tools: this test is about the
  // session's shape on the wire, not about what the model can do.
  modelSelection: { model: "claude-haiku-4-5", options: {} },
  accessMode: "approval-required",
  timeouts: { inactivityMs: 1_800_000, absoluteMs: 28_800_000 },
};

/** Long enough for a cold CLI to start, connect and answer one short prompt. */
const TURN_DEADLINE = Duration.seconds(90);

const until = async (
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
 * Whether this machine can run a session at all, asked the way the runner asks
 * it: the adapter's own probe against the very config directory the session
 * will use. `claude auth status --json` is not the check - with
 * `CLAUDE_CONFIG_DIR` set explicitly, even to the directory it already
 * defaults to, it answers about a different credential than the session gets.
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
              hydraTool: TOOL(),
            },
            {},
          ),
        )
      ).auth.status === "ok";

describe.skipIf(!authed)("a real Claude Code session on this machine", () => {
  it(
    "starts, answers one prompt inside a bracketed turn, and exits when stopped",
    async () => {
      const seen: Array<ProviderEvent> = [];
      Effect.runFork(
        Stream.runForEach(claudeCode.events, (event) => Effect.sync(() => void seen.push(event))),
      );

      const context = contextFor(emptyHome());

      const binding = await Effect.runPromise(claudeCode.startSession(SESSION, SPEC, context));
      expect(binding.sessionId).toBe(SESSION);
      // The two ids are separate concepts, joined only by this binding.
      expect(binding.nativeSessionId).not.toBe(SESSION);

      await Effect.runPromise(
        claudeCode.sendInput(SESSION, {
          text: "Reply with the single word ready. Use no tools.",
        }),
      );

      await until(seen, "turn.completed");

      const tags = seen.map((event) => event._tag);
      expect(tags[0]).toBe("session.started");
      expect(tags.indexOf("turn.started")).toBeLessThan(tags.indexOf("turn.completed"));
      const done = seen.find((event) => event._tag === "turn.completed");
      expect(
        done?._tag === "turn.completed" ? done.state : undefined,
        done?._tag === "turn.completed" ? (done.error ?? "") : "",
      ).toBe("completed");
      // The answer arrived as deltas, not as one lump at the end.
      expect(tags).toContain("content.delta");
      expect(tags).toContain("session.usage.updated");

      await Effect.runPromise(claudeCode.stopSession(SESSION, "stopped"));
      await until(seen, "session.exited");
      const exited = seen.find((event) => event._tag === "session.exited");
      expect(exited?._tag === "session.exited" ? exited.reason : undefined).toBe("stopped");
      expect(await Effect.runPromise(claudeCode.listSessions)).toEqual([]);
    },
    Duration.toMillis(TURN_DEADLINE) * 2,
  );
});

/**
 * The one fact about the CLI this build could not read out of the SDK's types:
 * whether `options.sessionId` is honoured together with `resume` and
 * `forkSession: true`, which is what lets Hydra name a forked session the way it
 * names a fresh one. If it is not, the fork's binding has to wait for the CLI's
 * own `init` message instead, and this test's failure message says so.
 *
 * The cwd is a temporary directory, so the transcripts this test writes land in
 * a `projects/<encoded-cwd>/` folder of their own and nothing of the
 * developer's is read or rewritten. The config directory has to be the
 * developer's own: on macOS a login is a Keychain item keyed by the config
 * directory, so a temporary one never holds one and this would only ever skip.
 */
const PROJECTS = join(CONFIG_DIR, "projects");

/** Every transcript under the instance home, wherever the CLI filed it. */
const transcripts = (): ReadonlyArray<string> =>
  !existsSync(PROJECTS)
    ? []
    : readdirSync(PROJECTS, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .flatMap((entry) =>
          readdirSync(join(PROJECTS, entry.name))
            .filter((name) => name.endsWith(".jsonl"))
            .map((name) => join(PROJECTS, entry.name, name)),
        );

const transcriptOf = (nativeSessionId: string): string | undefined =>
  transcripts().find((path) => basename(path) === `${nativeSessionId}.jsonl`);

/**
 * The CLI writes the transcript as it goes, so a file that is not there the
 * instant a turn completed is waited for rather than declared missing.
 */
const untilTranscript = async (nativeSessionId: string): Promise<string | undefined> => {
  const deadline = Date.now() + Duration.toMillis(TURN_DEADLINE);
  for (;;) {
    const found = transcriptOf(nativeSessionId);
    if (found !== undefined || Date.now() > deadline) return found;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
};

/**
 * The context a live session runs in: a throwaway cwd, the developer's config
 * directory - a login lives there and nowhere else - and, where one is set, the
 * other route to an authenticated session.
 */
const contextFor = (
  cwd: string,
  hydraTool: ProviderRunnerContext["hydraTool"] = TOOL(),
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
  hydraTool,
});

/** A fresh subscriber per session: the stream is unbounded and never replays. */
const watching = (): Array<ProviderEvent> => {
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
    "forks under the native id Hydra minted, and resumes under the parent's own",
    async () => {
      const context = contextFor(emptyHome());

      /** Reads back out of a transcript, so a fork can be told from a fresh session. */
      const marker = `hydra-fork-probe-${crypto.randomUUID().slice(0, 8)}`;
      const asking = (text: string) => `Reply with the single word ready. Use no tools. ${text}`;

      /** One session: start it, say one thing, wait the turn out, stop it. */
      const oneTurn = async (
        sessionId: string,
        spec: SessionSpec,
        text: string,
      ): Promise<string> => {
        const seen = watching();
        const binding = await Effect.runPromise(claudeCode.startSession(sessionId, spec, context));
        await Effect.runPromise(claudeCode.sendInput(sessionId, { text }));
        await until(seen, "turn.completed");
        await Effect.runPromise(claudeCode.stopSession(sessionId, "stopped"));
        await until(seen, "session.exited");
        return binding.nativeSessionId;
      };

      const parent = await oneTurn(PARENT, SPEC, asking(marker));
      const parentFile = await untilTranscript(parent);
      expect(
        parentFile,
        `no transcript for the parent session ${parent} under ${PROJECTS}`,
      ).not.toBe(undefined);
      const before = readFileSync(parentFile!, "utf8");
      expect(before).toContain(marker);
      const known = new Set(transcripts());

      // Hydra names the forked session itself, because in streaming-input mode
      // the CLI says nothing at all until a first turn arrives.
      const forkSeen = watching();
      const minted = await Effect.runPromise(
        claudeCode.startSession(
          FORKED,
          { ...SPEC, continue: { nativeSessionId: parent, mode: "fork" } },
          context,
        ),
      );
      expect(minted.nativeSessionId).not.toBe(parent);
      await Effect.runPromise(claudeCode.sendInput(FORKED, { text: asking("second") }));
      await until(forkSeen, "turn.completed");
      await Effect.runPromise(claudeCode.stopSession(FORKED, "stopped"));
      await until(forkSeen, "session.exited");

      const forkedFile = await untilTranscript(minted.nativeSessionId);
      const appeared = transcripts().filter((path) => !known.has(path));
      expect(
        forkedFile,
        `this CLI ignored options.sessionId beside resume + forkSession: true. Hydra minted ` +
          `${minted.nativeSessionId}; the transcripts that appeared instead were ` +
          `[${appeared.map((path) => basename(path)).join(", ")}]. Bind the fork from the CLI's ` +
          `own init message and emit session.started there instead.`,
      ).not.toBe(undefined);
      // A fork carries the parent's history; a fresh session under a new name
      // would pass every check above and none of this one.
      expect(
        readFileSync(forkedFile!, "utf8"),
        `the fork under ${minted.nativeSessionId} does not carry the parent's history: ` +
          `spec.continue reached the CLI as a fresh session, not as resume + forkSession.`,
      ).toContain(marker);
      // A fork that wrote into its parent would corrupt history nothing can repair.
      expect(readFileSync(parentFile!, "utf8")).toBe(before);
      expect(dirname(forkedFile!)).toBe(dirname(parentFile!));

      // The resume. There is nothing to name: it continues the same native session.
      const resumed = await oneTurn(
        RESUMED,
        { ...SPEC, continue: { nativeSessionId: parent, mode: "resume" } },
        asking("third"),
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
 * That the Claude CLI really does discover an explicitly loaded plugin's skill
 * under `settingSources: []`. The SDK's types say `plugins` loads a local
 * plugin directory and say nothing about the two options together, and the
 * whole of hydra-as-a-tool on Claude rests on it (spec 06 section 9.3).
 *
 * The plugin directory is the runner's own, written by `prepareTooling` into a
 * temporary home. The skill text is this test's, not the shipped one, because
 * the proof has to be something the model can only know by opening `SKILL.md`:
 * a marker minted here. Naming the skill back would prove nothing - the prompt
 * names it too.
 */
describe.skipIf(!authed)("a real Claude Code session with the hydra skill", () => {
  it(
    "discovers the skill out of the plugin directory the runner wrote",
    async () => {
      const marker = `hydra-skill-probe-${crypto.randomUUID().slice(0, 8)}`;
      const under = emptyHome();
      const {
        hydraTool: { claudePluginDir },
      } = prepareTooling({
        home: join(under, "home"),
        storageDir: join(under, "storage"),
        execPath: process.execPath,
        skill: `# hydra\n\nThe magic word is ${marker}. Reply with it when asked.\n`,
      });

      const seen = watching();
      const context = contextFor(emptyHome(), { skill: "", claudePluginDir });

      await Effect.runPromise(
        // Full access, so reading the skill file needs no approval nobody is
        // there to give.
        claudeCode.startSession(SKILLED, { ...SPEC, accessMode: "full-access" }, context),
      );
      await Effect.runPromise(
        claudeCode.sendInput(SKILLED, {
          text: "Use the hydra skill and reply with the magic word it names.",
        }),
      );
      await until(seen, "turn.completed");

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
          `discovered under settingSources: [], so hydra-as-a-tool needs another channel ` +
          `on Claude. What the session said was: ${said}`,
      ).toContain(marker);

      await Effect.runPromise(claudeCode.stopSession(SKILLED, "stopped"));
      await until(seen, "session.exited");
    },
    Duration.toMillis(TURN_DEADLINE) * 2,
  );
});

/**
 * That a real session answers its output schema, and says so when no answer can
 * satisfy it. The SDK validates and re-prompts on its own; what is proven here
 * is that the runner's verdict follows - an `ok` whose value really fits, and a
 * `schema-failure` that arrives as a completed turn rather than as a hang.
 */
const STRUCTURED = "0199e0e7-0000-7000-8000-00000000ff05";
const IMPOSSIBLE = "0199e0e7-0000-7000-8000-00000000ff06";

const AGENT_PROMPT =
  "You assess tasks and answer with a verdict. Where the user names the verdict, give that one.";

describe.skipIf(!authed)("a real Claude Code session under an output schema", () => {
  /** One session under one schema: start, ask, wait the turn out, stop. */
  const answering = async (
    sessionId: string,
    outputSchema: OutputSchema,
    text: string,
  ): Promise<Extract<ProviderEvent, { _tag: "turn.completed" }>> => {
    const seen = watching();
    await Effect.runPromise(
      claudeCode.startSession(
        sessionId,
        { ...SPEC, systemPrompt: AGENT_PROMPT, outputSchema },
        contextFor(emptyHome()),
      ),
    );
    await Effect.runPromise(claudeCode.sendInput(sessionId, { text }));
    await until(seen, "turn.completed");
    await Effect.runPromise(claudeCode.stopSession(sessionId, "stopped"));
    await until(seen, "session.exited");
    return seen.find(
      (event): event is Extract<ProviderEvent, { _tag: "turn.completed" }> =>
        event._tag === "turn.completed",
    )!;
  };

  it(
    "answers the fixture schema with a value the schema accepts",
    async () => {
      const completed = await answering(
        STRUCTURED,
        FIXTURE_SCHEMA,
        "Assess this task: 'Fix a typo in the README'. Accept it.",
      );

      expect(completed.structuredResult?.outcome, JSON.stringify(completed.structuredResult)).toBe(
        "ok",
      );
      const answer = completed.structuredResult as { outcome: "ok"; value: { verdict?: unknown } };
      expect(answer.value.verdict).toBe("accept");
    },
    Duration.toMillis(TURN_DEADLINE) * 2,
  );

  it(
    "ends the turn with a schema failure when no value can satisfy the schema",
    async () => {
      const completed = await answering(IMPOSSIBLE, IMPOSSIBLE_SCHEMA, "Answer.");

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
