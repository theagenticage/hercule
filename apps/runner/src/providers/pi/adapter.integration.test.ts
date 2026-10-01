/**
 * Tests that the pi adapter works with the real binary and the real Z.ai GLM
 * models. The tests are skipped unless `pi` is on PATH and `ZAI_API_KEY` is
 * set. Otherwise `pnpm test` on any machine would quietly spend a paid Coding
 * Plan.
 *
 * The key is read from the environment and handed to the adapter as the
 * instance's secret. It is never printed, never written to the scratch home by
 * this file, and never asserted on.
 *
 * Every run gets a throwaway agent directory: the developer's own `~/.pi` is
 * never touched.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Effect, Stream } from "effect";
import type { OutputSchema, ProbeResult, ProviderEvent, SessionSpec } from "@hercule/protocol";
import {
  ASSESSOR_SYSTEM_PROMPT,
  FIXTURE_PROMPT,
  FIXTURE_SCHEMA,
  IMPOSSIBLE_PROMPT,
  IMPOSSIBLE_SCHEMA,
} from "@hercule/protocol/testing";
import { pi } from "./adapter";
import type { ProviderRunnerContext } from "../index";
import { buildContext, SPEC } from "./testing";
import { cleanupHomes, createScratchHome, filterByTag, waitUntil } from "../testing";
import { pointAtFakeModel, startFakeModelServer, type FakeModelServer } from "./upstream";

const binary = Bun.which("pi") ?? undefined;

const key = process.env["ZAI_API_KEY"] ?? "";

afterAll(cleanupHomes);

const createScratchDir = (): string => createScratchHome("pi-live");

const BUDGET_MS = 180_000;

/** Long enough for a model to answer, and short enough to leave room in the budget. */
const PATIENCE_MS = BUDGET_MS / 2;

/** Builds a context with the real binary, the given secrets, and fresh directories for this run. */
const buildLiveContext = (secrets: Readonly<Record<string, string>>): ProviderRunnerContext => ({
  ...buildContext(createScratchDir(), createScratchDir(), secrets),
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
  seen: ReadonlyArray<ProviderEvent>,
  what: string,
  ready: () => boolean,
): Promise<void> =>
  waitUntil(
    `${what}, having reported ${seen.map((event) => event._tag).join(", ")}`,
    ready,
    PATIENCE_MS,
  );

const readAssistantText = (seen: ReadonlyArray<ProviderEvent>): string =>
  filterByTag(seen, "content.delta")
    .filter((event) => event.streamKind === "assistant_text")
    .map((event) => event.delta)
    .join("");

const listCompletedTurns = (
  seen: ReadonlyArray<ProviderEvent>,
): ReadonlyArray<Extract<ProviderEvent, { _tag: "turn.completed" }>> =>
  filterByTag(seen, "turn.completed");

const listCompletedItems = (
  seen: ReadonlyArray<ProviderEvent>,
  kind: string,
): ReadonlyArray<Extract<ProviderEvent, { _tag: "item.completed" }>> =>
  filterByTag(seen, "item.completed").filter((event) => event.kind === kind);

describe.skipIf(binary === undefined || key === "")("a real pi session on a real GLM model", () => {
  for (const model of ["glm-5.3", "glm-5.3-flash"]) {
    it(
      `answers a prompt and runs a shell command on ${model}, and reports the turn's cost`,
      async () => {
        const ctx = buildLiveContext({ zaiApiKey: key });
        const sessionId = crypto.randomUUID();
        const seen: Array<ProviderEvent> = [];
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
): Promise<Extract<ProviderEvent, { _tag: "turn.completed" }>> => {
  const sessionId = crypto.randomUUID();
  const seen: Array<ProviderEvent> = [];
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
      buildLiveContext({ zaiApiKey: key }),
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
 * The probe makes no API call: pi reads the key from the environment and the
 * catalog from its installed providers. So a fake key is enough to test what
 * a Fleet row will show.
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
      pi.probe(buildLiveContext({ zaiApiKey: "not-a-key-and-never-sent-anywhere" }), {}),
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
    const probed = await Effect.runPromise(pi.probe(buildLiveContext({}), {}));

    expect(probed.harnessVersion).toBe(readInstalledVersion());
    expect(probed.auth.status).toBe("unauthenticated");
    expect(probed.models).toEqual([]);
  }, 60_000);
});

/**
 * Checks that the real pi reads the `AGENTS.md` in a session's cwd when the
 * session has a workspace, and ignores it when the session has none. The
 * model is the fake server, so no key is needed: the test reads the request
 * pi sends it, where pi puts its context files into the system prompt.
 */
describe.skipIf(binary === undefined)("a real pi and the AGENTS.md in its cwd", () => {
  const upstreams: Array<FakeModelServer> = [];
  afterAll(() => {
    for (const upstream of upstreams.splice(0)) upstream.stop();
  });

  /**
   * Starts a session in a directory holding an `AGENTS.md` with a marker,
   * sends one input, and stops the session once pi has asked the model.
   * Returns the marker and the body of that first request.
   */
  const sendFirstRequest = async (
    workspaceId: SessionSpec["workspaceId"],
  ): Promise<{ readonly marker: string; readonly request: string }> => {
    const upstream = startFakeModelServer();
    upstreams.push(upstream);
    const home = createScratchDir();
    pointAtFakeModel(home, upstream.baseUrl);
    const cwd = createScratchDir();
    const marker = `hercule-project-${crypto.randomUUID().slice(0, 8)}`;
    writeFileSync(join(cwd, "AGENTS.md"), `# Project\n\nThe project's code word is ${marker}.\n`);

    const sessionId = crypto.randomUUID();
    await Effect.runPromise(
      pi.startSession(
        sessionId,
        {
          ...SPEC,
          workspaceId,
          modelSelection: { model: "fake-model", options: { thinking: "low" } },
        },
        { ...buildContext(home, cwd), binary: binary!, env: { PATH: process.env["PATH"] ?? "" } },
      ),
    );
    await Effect.runPromise(pi.sendInput(sessionId, { text: "What is the code word?" }));
    await waitUntil("pi asked the model", () => upstream.asked() >= 1, PATIENCE_MS);
    await Effect.runPromise(pi.stopSession(sessionId, "stopped"));
    return { marker, request: upstream.requests()[0]! };
  };

  it(
    "puts the workspace's AGENTS.md into the system prompt",
    async () => {
      const { marker, request } = await sendFirstRequest("0199e0e7-0000-7000-8000-00000000000b");
      expect(request).toContain(marker);
    },
    BUDGET_MS,
  );

  it(
    "leaves an AGENTS.md in its cwd out when it has no workspace",
    async () => {
      const { marker, request } = await sendFirstRequest(null);
      expect(request).not.toContain(marker);
    },
    BUDGET_MS,
  );
});
