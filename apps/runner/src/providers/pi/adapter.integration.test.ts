/**
 * Proves the pi adapter drives the real binary against the real models Hydra
 * runs GLM on. Opt-in twice over: it skips without `pi` on PATH, and without a
 * `ZAI_API_KEY` in the environment, because the alternative is that `pnpm test`
 * on any machine quietly spends a paid Coding Plan.
 *
 * The key is read from the environment and handed to the adapter as the
 * instance's secret. It is never printed, never written to the scratch home by
 * this file, and never asserted on.
 *
 * Every run gets a throwaway agent directory: the developer's own `~/.pi` is
 * never touched.
 */
import { afterAll, describe, expect, it } from "vitest";
import { Effect, Stream } from "effect";
import type { OutputSchema, ProbeResult, ProviderEvent, SessionSpec } from "@hydra/protocol";
import { FIXTURE_SCHEMA, IMPOSSIBLE_SCHEMA } from "@hydra/protocol/output-schema.fixture";
import { pi } from "./adapter";
import type { ProviderRunnerContext } from "../index";
import { contextIn, SPEC } from "./testing";
import { cleanupHomes, scratchHome, taggedIn, until } from "../testing";

const binary = Bun.which("pi") ?? undefined;

const key = process.env["ZAI_API_KEY"] ?? "";

afterAll(cleanupHomes);

const scratch = (): string => scratchHome("pi-live");

const BUDGET_MS = 180_000;

/** Long enough for a model to answer, short enough to leave the budget room. */
const PATIENCE_MS = BUDGET_MS / 2;

/** The real binary, the real key, and a directory of this run's own. */
const liveContext = (secrets: Readonly<Record<string, string>>): ProviderRunnerContext => ({
  ...contextIn(scratch(), scratch(), secrets),
  binary: binary!,
  env: { PATH: process.env["PATH"] ?? "" },
});

const specFor = (model: string): SessionSpec => ({
  ...SPEC,
  modelSelection: { model, options: { thinking: "low" } },
  // No approvals to answer: this case is about the models answering at all.
  accessMode: "full-access",
});

const awaiting = (
  seen: ReadonlyArray<ProviderEvent>,
  what: string,
  ready: () => boolean,
): Promise<void> =>
  until(
    `${what}, having reported ${seen.map((event) => event._tag).join(", ")}`,
    ready,
    PATIENCE_MS,
  );

const textIn = (seen: ReadonlyArray<ProviderEvent>): string =>
  taggedIn(seen, "content.delta")
    .filter((event) => event.streamKind === "assistant_text")
    .map((event) => event.delta)
    .join("");

const completed = (
  seen: ReadonlyArray<ProviderEvent>,
): ReadonlyArray<Extract<ProviderEvent, { _tag: "turn.completed" }>> =>
  taggedIn(seen, "turn.completed");

const items = (
  seen: ReadonlyArray<ProviderEvent>,
  kind: string,
): ReadonlyArray<Extract<ProviderEvent, { _tag: "item.completed" }>> =>
  taggedIn(seen, "item.completed").filter((event) => event.kind === kind);

describe.skipIf(binary === undefined || key === "")("a real pi session on a real GLM model", () => {
  for (const model of ["glm-5.3", "glm-5.3-flash"]) {
    it(
      `answers a prompt and runs a shell command on ${model}, and prices the turn`,
      async () => {
        const ctx = liveContext({ zaiApiKey: key });
        const sessionId = crypto.randomUUID();
        const seen: Array<ProviderEvent> = [];
        Effect.runFork(
          Stream.runForEach(pi.events, (event) =>
            Effect.sync(() => {
              if (event.sessionId === sessionId) seen.push(event);
            }),
          ),
        );

        await Effect.runPromise(pi.startSession(sessionId, specFor(model), ctx));
        await Effect.runPromise(
          pi.sendInput(sessionId, { text: "Reply with exactly one word: OK" }),
        );
        await awaiting(seen, "answered the prompt", () => completed(seen).length === 1);

        expect(textIn(seen).toUpperCase()).toContain("OK");
        const first = completed(seen)[0]!;
        expect(first.state).toBe("completed");
        // A priced turn is what the session view reads to show what it cost.
        expect(first.costUsd ?? 0).toBeGreaterThan(0);

        await Effect.runPromise(
          pi.sendInput(sessionId, {
            text: "Run this shell command and tell me its output: echo hydra-lives",
          }),
        );
        await awaiting(
          seen,
          "ran the command",
          () => items(seen, "command_execution").length >= 1 && completed(seen).length === 2,
        );

        expect(items(seen, "command_execution")[0]?.status).toBe("completed");
        expect(completed(seen)[1]?.costUsd ?? 0).toBeGreaterThan(0);

        await Effect.runPromise(pi.stopSession(sessionId, "stopped"));
      },
      BUDGET_MS,
    );
  }
});

/** What the session is told it is, above pi's own prompt. */
const AGENT_PROMPT =
  "You assess tasks and answer with a verdict. Where the user names the verdict, give that one.";

/** The model these cases run on: the cheapest of the two this adapter drives. */
const STRUCTURED_MODEL = "glm-5.3-flash";

/**
 * A session's answer under one schema: start, ask, wait the turn out, stop.
 * Every run gets its own session and its own directories, so the second case
 * is never answered out of the first one's transcript.
 */
const answering = async (
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
      { ...specFor(STRUCTURED_MODEL), systemPrompt: AGENT_PROMPT, outputSchema },
      liveContext({ zaiApiKey: key }),
    ),
  );
  await Effect.runPromise(pi.sendInput(sessionId, { text }));
  await awaiting(seen, "answered under the schema", () => completed(seen).length === 1);
  await Effect.runPromise(pi.stopSession(sessionId, "stopped"));
  return completed(seen)[0]!;
};

describe.skipIf(binary === undefined || key === "")(
  "a real pi session under an output schema",
  () => {
    it(
      "answers the fixture schema through the tool, with a value the schema accepts",
      async () => {
        const turn = await answering(
          FIXTURE_SCHEMA,
          "Assess this task: 'Fix a typo in the README'. Accept it.",
        );

        expect(turn.structuredResult?.outcome, JSON.stringify(turn.structuredResult)).toBe("ok");
        const answer = turn.structuredResult as { outcome: "ok"; value: { verdict?: unknown } };
        expect(answer.value.verdict).toBe("accept");
      },
      BUDGET_MS,
    );

    it(
      "ends the turn with a schema failure when no value can satisfy the schema",
      async () => {
        const turn = await answering(IMPOSSIBLE_SCHEMA, "Answer.");

        expect(turn.structuredResult?.outcome, JSON.stringify(turn.structuredResult)).toBe(
          "schema-failure",
        );
        const failure = turn.structuredResult as { outcome: "schema-failure"; reason: string };
        expect(failure.reason).not.toBe("");
        // Never hung: the turn ended and the session is no longer this adapter's.
        expect(await Effect.runPromise(pi.listSessions)).toEqual([]);
      },
      BUDGET_MS,
    );
  },
);

/**
 * The probe makes no API call: pi reads the credential out of the environment
 * and its catalog out of its own installed providers, so a key that would
 * buy nothing is enough to prove what a Fleet row will say.
 */
describe.skipIf(binary === undefined)("what a probe reads off a real pi", () => {
  /** What the binary on this machine says it is, which is what a probe reports. */
  const installedVersion = (): string =>
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
      pi.probe(liveContext({ zaiApiKey: "not-a-key-and-never-sent-anywhere" }), {}),
    );

    // The installed version, whatever it is: pinning one here would fail on
    // the next release rather than on anything this adapter got wrong.
    expect(probed.harnessVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(probed.harnessVersion).toBe(installedVersion());
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

  it("reports a machine nobody has entered a key on as unauthenticated", async () => {
    const probed = await Effect.runPromise(pi.probe(liveContext({}), {}));

    expect(probed.harnessVersion).toBe(installedVersion());
    expect(probed.auth.status).toBe("unauthenticated");
    expect(probed.models).toEqual([]);
  }, 60_000);
});
