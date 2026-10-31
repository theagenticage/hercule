/**
 * Tests that the pi adapter works with the real binary and the real Z.ai GLM
 * models. The tests are skipped unless `pi` is on PATH and `ZAI_API_KEY` is
 * set. Otherwise `pnpm test` on any machine would quietly spend a paid Coding
 * Plan.
 *
 * The key is read from the environment and handed to the adapter as the
 * account's secret. It is never printed, never written to the scratch home by
 * this file, and never asserted on.
 *
 * Every run gets a throwaway agent directory: the developer's own `~/.pi` is
 * never touched.
 */
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Effect, Stream } from "effect";
import type { OutputSchema, ProbeResult, HarnessEvent, SessionSpec } from "@hercule/protocol";
import {
  ASSESSOR_SYSTEM_PROMPT,
  FIXTURE_PROMPT,
  FIXTURE_SCHEMA,
  IMPOSSIBLE_PROMPT,
  IMPOSSIBLE_SCHEMA,
} from "@hercule/protocol/testing";
import { ensureRootBoundary } from "../../workspaces";
import { pi } from "./adapter";
import { readPiProvider } from "./provider";
import type { HarnessRunnerContext, UserMaterial } from "../index";
import { buildContext, SPEC } from "./testing";
import {
  cleanupHomes,
  createScratchHome,
  filterByTag,
  NO_USER_MATERIAL_PATHS,
  waitUntil,
} from "../testing";
import {
  pointAtFakeModel,
  startFakeModelServer,
  startScriptedModelServer,
  type FakeModelServer,
} from "./upstream";

const binary = Bun.which("pi") ?? undefined;

const key = process.env["ZAI_API_KEY"] ?? "";

afterAll(cleanupHomes);

const createScratchDir = (): string => createScratchHome("pi-live");

const BUDGET_MS = 180_000;

/** Long enough for a model to answer, and short enough to leave room in the budget. */
const PATIENCE_MS = BUDGET_MS / 2;

/** Builds a context with the real binary, the given key, and fresh directories for this run. */
const buildLiveContext = (zaiApiKey: string | null): HarnessRunnerContext => ({
  ...buildContext(
    createScratchDir(),
    createScratchDir(),
    zaiApiKey === null ? null : { variable: "ZAI_API_KEY", value: zaiApiKey },
  ),
  binary: binary!,
  env: { PATH: process.env["PATH"] ?? "" },
});

const buildSpec = (model: string): SessionSpec => ({
  ...SPEC,
  modelSelection: { model, options: { thinking: "low" } },
  // No approvals to answer: these tests only check that the models work at all.
  accessMode: "full-access",
});

const waitReportingEvents = (
  seen: ReadonlyArray<HarnessEvent>,
  what: string,
  ready: () => boolean,
): Promise<void> =>
  waitUntil(
    `${what}, having reported ${seen.map((event) => event._tag).join(", ")}`,
    ready,
    PATIENCE_MS,
  );

const readAssistantText = (seen: ReadonlyArray<HarnessEvent>): string =>
  filterByTag(seen, "content.delta")
    .filter((event) => event.streamKind === "assistant_text")
    .map((event) => event.delta)
    .join("");

const listCompletedTurns = (
  seen: ReadonlyArray<HarnessEvent>,
): ReadonlyArray<Extract<HarnessEvent, { _tag: "turn.completed" }>> =>
  filterByTag(seen, "turn.completed");

const listCompletedItems = (
  seen: ReadonlyArray<HarnessEvent>,
  kind: string,
): ReadonlyArray<Extract<HarnessEvent, { _tag: "item.completed" }>> =>
  filterByTag(seen, "item.completed").filter((event) => event.kind === kind);

describe.skipIf(binary === undefined || key === "")("a real pi session on a real GLM model", () => {
  for (const model of ["glm-5.3", "glm-5.3-flash"]) {
    it(
      `answers a prompt and runs a shell command on ${model}, and reports the turn's cost`,
      async () => {
        const ctx = buildLiveContext(key);
        const sessionId = crypto.randomUUID();
        const seen: Array<HarnessEvent> = [];
        Effect.runFork(
          Stream.runForEach(pi.events, (event) =>
            Effect.sync(() => {
              if (event.sessionId === sessionId) seen.push(event);
            }),
          ),
        );

        await Effect.runPromise(pi.startSession(sessionId, buildSpec(model), ctx));
        await Effect.runPromise(
          pi.sendInput(sessionId, { text: "Reply with exactly one word: OK" }),
        );
        await waitReportingEvents(
          seen,
          "answered the prompt",
          () => listCompletedTurns(seen).length === 1,
        );

        expect(readAssistantText(seen).toUpperCase()).toContain("OK");
        const first = listCompletedTurns(seen)[0]!;
        expect(first.state).toBe("completed");
        // The session view shows the turn's cost from this field.
        expect(first.costUsd ?? 0).toBeGreaterThan(0);

        await Effect.runPromise(
          pi.sendInput(sessionId, {
            text: "Run this shell command and tell me its output: echo hercule-lives",
          }),
        );
        await waitReportingEvents(
          seen,
          "ran the command",
          () =>
            listCompletedItems(seen, "command_execution").length >= 1 &&
            listCompletedTurns(seen).length === 2,
        );

        expect(listCompletedItems(seen, "command_execution")[0]?.status).toBe("completed");
        expect(listCompletedTurns(seen)[1]?.costUsd ?? 0).toBeGreaterThan(0);

        await Effect.runPromise(pi.stopSession(sessionId, "stopped"));
      },
      BUDGET_MS,
    );
  }
});

/** The model these tests use: the cheaper of the two tested above. */
const STRUCTURED_MODEL = "glm-5.3-flash";

/**
 * Runs one turn with an output schema: starts a session, sends the prompt,
 * waits for the turn to complete, and stops the session. Returns the
 * `turn.completed` event. Every run gets its own session and directories, so
 * one test can never answer from another test's transcript.
 */
const runTurnUnderSchema = async (
  outputSchema: OutputSchema,
  text: string,
): Promise<Extract<HarnessEvent, { _tag: "turn.completed" }>> => {
  const sessionId = crypto.randomUUID();
  const seen: Array<HarnessEvent> = [];
  Effect.runFork(
    Stream.runForEach(pi.events, (event) =>
      Effect.sync(() => {
        if (event.sessionId === sessionId) seen.push(event);
      }),
    ),
  );
  await Effect.runPromise(
    pi.startSession(
      sessionId,
      { ...buildSpec(STRUCTURED_MODEL), systemPrompt: ASSESSOR_SYSTEM_PROMPT, outputSchema },
      buildLiveContext(key),
    ),
  );
  await Effect.runPromise(pi.sendInput(sessionId, { text }));
  await waitReportingEvents(
    seen,
    "answered under the schema",
    () => listCompletedTurns(seen).length === 1,
  );
  await Effect.runPromise(pi.stopSession(sessionId, "stopped"));
  return listCompletedTurns(seen)[0]!;
};

describe.skipIf(binary === undefined || key === "")(
  "a real pi session under an output schema",
  () => {
    it(
      "answers the fixture schema through the tool, with a value the schema accepts",
      async () => {
        const turn = await runTurnUnderSchema(FIXTURE_SCHEMA, FIXTURE_PROMPT);

        expect(turn.structuredResult?.outcome, JSON.stringify(turn.structuredResult)).toBe("ok");
        const answer = turn.structuredResult as { outcome: "ok"; value: { verdict?: unknown } };
        expect(answer.value.verdict).toBe("accept");
      },
      BUDGET_MS,
    );

    it(
      "ends the turn with a schema failure when no value can satisfy the schema",
      async () => {
        const turn = await runTurnUnderSchema(IMPOSSIBLE_SCHEMA, IMPOSSIBLE_PROMPT);

        expect(turn.structuredResult?.outcome, JSON.stringify(turn.structuredResult)).toBe(
          "schema-failure",
        );
        const failure = turn.structuredResult as { outcome: "schema-failure"; reason: string };
        expect(failure.reason).not.toBe("");
        // Nothing hung: the turn ended and the adapter no longer hosts the session.
        expect(await Effect.runPromise(pi.listSessions)).toEqual([]);
      },
      BUDGET_MS,
    );
  },
);

/**
 * The probe sends no key anywhere: pi reads the key from the environment, and
 * the probe's only network request is the refresh of pi's model list from
 * pi.dev, which carries no key. When that request fails, for example offline,
 * the probe still reports the catalog pi has stored or bundled. So a fake key
 * is enough to test what a Fleet row will show.
 */
describe.skipIf(binary === undefined)("probing a real pi", () => {
  /** Returns the version the installed binary prints, which the probe should report. */
  const readInstalledVersion = (): string =>
    Bun.spawnSync([binary!, "--version"]).stdout.toString().trim();

  const getReportedThinkingLevels = (
    models: ProbeResult["models"],
    slug: string,
  ): ReadonlyArray<string> =>
    (models.find((model) => model.slug === slug)?.options ?? [])
      .filter((option) => option.id === "thinking")
      .flatMap((option) => (option.choices ?? []).map((choice) => choice.value));

  it("reports the version, the key as usable, and the models Z.ai offers", async () => {
    const probed = await Effect.runPromise(
      pi.probe(buildLiveContext("not-a-key-and-never-sent-anywhere"), { readUsage: false }),
    );

    // Whatever version is installed: pinning one here would fail on the next
    // pi release, not on a bug in this adapter.
    expect(probed.harnessVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(probed.harnessVersion).toBe(readInstalledVersion());
    expect(probed.auth.status).toBe("ok");
    expect(probed.auth.identity).toBeUndefined();
    expect(probed.models.map((model) => model.slug)).toEqual(
      expect.arrayContaining(["glm-5.3", "glm-5.3-flash"]),
    );
    expect(getReportedThinkingLevels(probed.models, "glm-5.3")).toEqual(["low", "high", "max"]);
    expect(getReportedThinkingLevels(probed.models, "glm-5.3-flash")).toEqual([
      "low",
      "high",
      "max",
    ]);
  }, 60_000);

  it("reports a machine with no key as unauthenticated", async () => {
    const probed = await Effect.runPromise(pi.probe(buildLiveContext(null), { readUsage: false }));

    expect(probed.harnessVersion).toBe(readInstalledVersion());
    expect(probed.auth.status).toBe("unauthenticated");
    expect(probed.models).toEqual([]);
  }, 60_000);
});

/** The fake model servers the tests below start, stopped once the file is done. */
const upstreams: Array<FakeModelServer> = [];
afterAll(() => {
  for (const upstream of upstreams.splice(0)) upstream.stop();
});

/**
 * Starts a real pi session on the fake model server, in the given directory,
 * sends one input, and stops the session once pi has asked the model. Returns
 * the body of that first request, which holds pi's whole system prompt. No key
 * is needed, because the model is the fake server.
 *
 * The session's `HOME` is `user.home`, or an empty scratch directory when the
 * test passes none, so pi never sees the developer's own home. The session
 * sees User Material only when the test passes `user.material`, and has a
 * library skills folder only when the test passes `user.librarySkillsFolder`,
 * and repository skills folders only when it passes `user.repositorySkillsFolders`.
 */
const sendFirstRequest = async (
  workspaceId: SessionSpec["workspaceId"],
  cwd: string,
  user: {
    readonly home?: string;
    readonly material?: UserMaterial;
    readonly librarySkillsFolder?: string;
    readonly repositorySkillsFolders?: ReadonlyArray<string>;
  } = {},
): Promise<string> => {
  const upstream = startFakeModelServer();
  upstreams.push(upstream);
  const home = createScratchDir();
  pointAtFakeModel(home, "zai", upstream.baseUrl);
  const userHome = user.home ?? createScratchDir();
  // The user's own pi points at the fake model too. A session that reads the
  // user's agent directory by mistake then still asks the model, so the
  // test's assertion reports the mistake rather than a timeout.
  const userAgentDir = join(userHome, ".pi", "agent");
  mkdirSync(userAgentDir, { recursive: true });
  pointAtFakeModel(userAgentDir, "zai", upstream.baseUrl);

  const sessionId = crypto.randomUUID();
  await Effect.runPromise(
    pi.startSession(
      sessionId,
      {
        ...SPEC,
        workspaceId,
        modelSelection: { model: "fake-model", options: { thinking: "low" } },
      },
      {
        ...buildContext(home, cwd),
        binary: binary!,
        env: { PATH: process.env["PATH"] ?? "", HOME: userHome },
        ...(user.material === undefined ? {} : { userMaterial: user.material }),
        ...(user.librarySkillsFolder === undefined
          ? {}
          : { librarySkillsFolder: user.librarySkillsFolder }),
        ...(user.repositorySkillsFolders === undefined
          ? {}
          : { repositorySkillsFolders: user.repositorySkillsFolders }),
      },
    ),
  );
  await Effect.runPromise(pi.sendInput(sessionId, { text: "What is the code word?" }));
  await waitUntil("pi asked the model", () => upstream.asked() >= 1, PATIENCE_MS);
  await Effect.runPromise(pi.stopSession(sessionId, "stopped"));
  return upstream.requests()[0]!;
};

/** Returns a marker unique to one test, for finding text in pi's request. */
const createMarker = (label: string): string =>
  `hercule-${label}-${crypto.randomUUID().slice(0, 8)}`;

/**
 * Checks that the real pi reads the `AGENTS.md` in a session's cwd when the
 * session has a workspace, and ignores it when the session has none. pi puts
 * its context files into the system prompt, which the request to the model
 * holds.
 */
describe.skipIf(binary === undefined)("a real pi and the AGENTS.md in its cwd", () => {
  /** Creates a cwd holding an `AGENTS.md` with a marker. Returns the cwd and the marker. */
  const createProject = (): { readonly cwd: string; readonly marker: string } => {
    const cwd = createScratchDir();
    const marker = createMarker("project");
    writeFileSync(join(cwd, "AGENTS.md"), `# Project\n\nThe project's code word is ${marker}.\n`);
    return { cwd, marker };
  };

  it(
    "puts the workspace's AGENTS.md into the system prompt",
    async () => {
      const { cwd, marker } = createProject();
      const request = await sendFirstRequest("0199e0e7-0000-7000-8000-00000000000b", cwd);
      expect(request).toContain(marker);
    },
    BUDGET_MS,
  );

  it(
    "leaves an AGENTS.md in its cwd out when it has no workspace",
    async () => {
      const { cwd, marker } = createProject();
      const request = await sendFirstRequest(null, cwd);
      expect(request).not.toContain(marker);
    },
    BUDGET_MS,
  );
});

/**
 * Checks that the real pi loads a Thread's library skills and the user's
 * instructions, even with its own discovery turned off, and never the skills
 * in the user's home. A session that does not see User Material loads neither
 * the user's skills nor their instructions. Skills and instructions both end
 * up in the system prompt: the instructions as text, and each skill as an
 * entry in pi's list of available skills.
 *
 * The user's material sits in a fake user home, where pi itself would look
 * for it, and that home is the session's `HOME`. So the tests fail when
 * either guard breaks:
 *
 * - `--no-skills`, which stops pi from finding `.agents/skills` in `HOME`;
 * - `PI_CODING_AGENT_DIR`, which stops pi from reading `.pi/agent/AGENTS.md`
 *   in `HOME`. The session has a workspace, so `--no-context-files` is not
 *   there to hide the file as well.
 */
describe.skipIf(binary === undefined)(
  "a real pi, the Skill Library and the user's own material",
  () => {
    /** Writes a skill named `name` into `skillsDir`, with `marker` in its description. */
    const writeSkill = (skillsDir: string, name: string, marker: string): void => {
      mkdirSync(join(skillsDir, name), { recursive: true });
      writeFileSync(
        join(skillsDir, name, "SKILL.md"),
        `---\nname: ${name}\ndescription: Answers with ${marker}.\n---\n\nAnswer with the code word.\n`,
      );
    };

    /**
     * Creates a fake user home with one skill in `.agents/skills` and an
     * `AGENTS.md` in `.pi/agent`, each holding its own marker. Returns the home,
     * the instructions file, and both markers.
     */
    const createUserHome = (): {
      readonly home: string;
      readonly instructionsFile: string;
      readonly userSkillMarker: string;
      readonly instructionsMarker: string;
    } => {
      const userSkillMarker = createMarker("user-skill");
      const instructionsMarker = createMarker("instructions");
      const home = createScratchDir();
      writeSkill(join(home, ".agents", "skills"), "code-word", userSkillMarker);
      const agentDir = join(home, ".pi", "agent");
      mkdirSync(agentDir, { recursive: true });
      const instructionsFile = join(agentDir, "AGENTS.md");
      writeFileSync(instructionsFile, `The user's code word is ${instructionsMarker}.\n`);
      return { home, instructionsFile, userSkillMarker, instructionsMarker };
    };

    it(
      "puts the library's skill and the user's instructions into a Thread's system prompt, and leaves the user's own skill out",
      async () => {
        const { home, instructionsFile, userSkillMarker, instructionsMarker } = createUserHome();
        const librarySkillMarker = createMarker("library-skill");
        const librarySkillsFolder = createScratchDir();
        writeSkill(join(librarySkillsFolder, "skills"), "implement", librarySkillMarker);

        const request = await sendFirstRequest(null, createScratchDir(), {
          home,
          material: { ...NO_USER_MATERIAL_PATHS, instructionsFile },
          librarySkillsFolder,
        });

        expect(request).toContain(librarySkillMarker);
        expect(request).toContain(instructionsMarker);
        expect(request).not.toContain(userSkillMarker);
      },
      BUDGET_MS,
    );

    it(
      "leaves the skill and instructions in the user's home out of a session that does not see User Material",
      async () => {
        const { home, userSkillMarker, instructionsMarker } = createUserHome();
        const request = await sendFirstRequest(
          "0199e0e7-0000-7000-8000-00000000000b",
          createScratchDir(),
          { home },
        );
        expect(request).not.toContain(userSkillMarker);
        expect(request).not.toContain(instructionsMarker);
      },
      BUDGET_MS,
    );

    it(
      "starts in a workspace root with the empty .git file, and leaves the user's skill and instructions out",
      async () => {
        const { home, userSkillMarker, instructionsMarker } = createUserHome();
        // A workspace root with two checkouts, inside the user's home. The
        // root's `.git` is the empty boundary file, which Git cannot read.
        const root = join(home, "storage", "workspaces", "w");
        for (const name of ["a", "b"]) {
          mkdirSync(join(root, name), { recursive: true });
          const initialized = Bun.spawnSync(["git", "-C", join(root, name), "init", "--quiet"]);
          expect(initialized.exitCode, initialized.stderr.toString()).toBe(0);
        }
        await Effect.runPromise(ensureRootBoundary(root));

        const request = await sendFirstRequest("0199e0e7-0000-7000-8000-00000000000b", root, {
          home,
        });

        expect(request).not.toContain(userSkillMarker);
        expect(request).not.toContain(instructionsMarker);
      },
      BUDGET_MS,
    );

    it(
      "lists a skill that a repository skills folder links to",
      async () => {
        // A checkout holding the skill, and the folder the runner stages for
        // it: `<folder>/skills/<name>` is a symbolic link to the skill's folder.
        const checkout = createScratchDir();
        const repositorySkillMarker = createMarker("repository-skill");
        writeSkill(join(checkout, "skills-source"), "deploy", repositorySkillMarker);
        const repositorySkillsFolder = createScratchDir();
        mkdirSync(join(repositorySkillsFolder, "skills"));
        symlinkSync(
          join(checkout, "skills-source", "deploy"),
          join(repositorySkillsFolder, "skills", "deploy"),
        );

        const request = await sendFirstRequest(
          "0199e0e7-0000-7000-8000-00000000000b",
          createScratchDir(),
          { repositorySkillsFolders: [repositorySkillsFolder] },
        );

        expect(request).toContain(repositorySkillMarker);
      },
      BUDGET_MS,
    );
  },
);

/**
 * Checks that the real pi runs each kind of key the `pi` plugin pairs with a
 * provider that has a built-in pi provider of its own. A session gets only the
 * account's model argument and its key in a variable, so what matters is that
 * pi picks the provider the argument names and sends the key to it. The model
 * server is the fake one: `models.json` points the pi provider at it, and it
 * records the `Authorization` header it received.
 *
 * The rows repeat what the plugins declare, because the runner cannot import
 * a plugin.
 */
describe.skipIf(binary === undefined)("a real pi on the keys of OpenCode and MiniMax", () => {
  const REPLY = "The fake model answers.";

  it.each([
    { kind: "go-key", modelArgument: "opencode-go/{model}", variable: "OPENCODE_API_KEY" },
    { kind: "zen-key", modelArgument: "opencode/{model}", variable: "OPENCODE_API_KEY" },
    { kind: "pay-as-you-go-key", modelArgument: "minimax/{model}", variable: "MINIMAX_API_KEY" },
    { kind: "plan-key", modelArgument: "minimax/{model}", variable: "MINIMAX_API_KEY" },
  ])(
    "completes a turn on a $kind and sends the key to the model server",
    async ({ kind, modelArgument, variable }) => {
      const upstream = startScriptedModelServer(() => ({ text: REPLY }));
      upstreams.push(upstream);
      const home = createScratchDir();
      pointAtFakeModel(home, readPiProvider(modelArgument), upstream.baseUrl);
      const fakeKey = `fake-${kind}-key-${crypto.randomUUID()}`;
      const sessionId = crypto.randomUUID();
      const seen: Array<HarnessEvent> = [];
      Effect.runFork(
        Stream.runForEach(pi.events, (event) =>
          Effect.sync(() => {
            if (event.sessionId === sessionId) seen.push(event);
          }),
        ),
      );

      await Effect.runPromise(
        pi.startSession(
          sessionId,
          { ...buildSpec("fake-model"), providerAccountId: crypto.randomUUID() },
          {
            ...buildContext(home, createScratchDir(), { variable, value: fakeKey }),
            binary: binary!,
            env: { PATH: process.env["PATH"] ?? "" },
            modelArgument,
            credentialVariables: [variable],
          },
        ),
      );
      await Effect.runPromise(pi.sendInput(sessionId, { text: "Say anything." }));
      await waitReportingEvents(
        seen,
        "completed the turn",
        () => listCompletedTurns(seen).length === 1,
      );
      await Effect.runPromise(pi.stopSession(sessionId, "stopped"));

      expect(listCompletedTurns(seen)[0]?.state).toBe("completed");
      expect(readAssistantText(seen)).toBe(REPLY);
      expect(upstream.authorizations()).toEqual([`Bearer ${fakeKey}`]);
    },
    BUDGET_MS,
  );
});
