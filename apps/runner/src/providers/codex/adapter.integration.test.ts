/**
 * Checks that a real Codex session answers with its output schema, and
 * reports a schema failure when no value can satisfy the schema. Codex itself
 * constrains the turn's final assistant message; these tests check that the
 * runner's result matches: `ok` with a value that really fits, and a
 * `schema-failure` that arrives as an ended turn rather than a hang.
 *
 * The suite needs two opt-ins, so that `pnpm test` never quietly spends a
 * developer's subscription:
 *
 * - `HERCULE_LIVE_SESSION_TEST` must be set.
 * - `CODEX_HOME` must name the directory to copy the login from. The
 *   developer's own Codex home is never searched for or read.
 *
 * The login is copied into a throwaway instance home, because the session
 * runs under that home.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { codex } from "./adapter";
import type { ProviderRunnerContext } from "../index";

const binary = Bun.which("codex") ?? undefined;

const wanted = process.env["HERCULE_LIVE_SESSION_TEST"] !== undefined;

/** The directory the login is copied from. If it is unset, this suite is skipped. */
const borrowed = process.env["CODEX_HOME"];

const scratch: Array<string> = [];

afterAll(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const createScratchDir = (label: string): string => {
  const made = mkdtempSync(join(tmpdir(), `hercule-codex-${label}-`));
  scratch.push(made);
  return made;
};

/**
 * Creates an instance home with the copied login in it. The adapter points
 * `CODEX_HOME` at the home's own `codex/` directory, so the credential must be
 * there for the session to be logged in.
 */
const createHomeWithLogin = (): string => {
  const home = createScratchDir("home");
  const codexHome = join(home, "codex");
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  copyFileSync(join(borrowed!, "auth.json"), join(codexHome, "auth.json"));
  return home;
};

const buildContext = (home: string): ProviderRunnerContext => ({
  cwd: createScratchDir("cwd"),
  home,
  binary: binary!,
  env: { PATH: process.env["PATH"] ?? "" },
  secrets: {},
  herculeTool: { skill: "", claudePluginDir: join(home, "claude-plugin") },
});

const ready =
  binary !== undefined &&
  wanted &&
  borrowed !== undefined &&
  existsSync(join(borrowed, "auth.json"));

/**
 * Probes the copied login the same way the runner does: whether it is logged
 * in, and which model the account gets by default. A model slug hardcoded here
 * would need updating whenever OpenAI's catalogue changes.
 */
const probed = !ready
  ? undefined
  : await Effect.runPromise(codex.probe(buildContext(createHomeWithLogin()), {}));

const authed = probed?.auth.status === "ok";

const SESSION_SPEC: SessionSpec = {
  instanceId: "0199e0e7-0000-7000-8000-00000000000a",
  workspaceId: null,
  modelSelection: {
    model: (probed?.models.find((model) => model.isDefault) ?? probed?.models[0])?.slug ?? "",
    options: {},
  },
  accessMode: "approval-required",
  timeouts: { inactivityMs: 1_800_000, absoluteMs: 28_800_000 },
};

/** Long enough for a cold app-server to start, connect and reply to one prompt. */
const TURN_DEADLINE = Duration.seconds(120);

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
 * Subscribes to the adapter's events and returns the list they are collected
 * into. Each session needs a new subscriber, because the stream never replays
 * past events.
 */
const collectEvents = (): Array<ProviderEvent> => {
  const seen: Array<ProviderEvent> = [];
  Effect.runFork(
    Stream.runForEach(codex.events, (event) => Effect.sync(() => void seen.push(event))),
  );
  return seen;
};

const STRUCTURED = "0199e0e7-0000-7000-8000-00000000ff05";
const IMPOSSIBLE = "0199e0e7-0000-7000-8000-00000000ff06";

describe.skipIf(!authed)("a real Codex session under an output schema", () => {
  /** Starts a session with a schema, sends one input, waits for the turn to end, and stops it. */
  const runTurnUnderSchema = async (
    sessionId: string,
    outputSchema: OutputSchema,
    text: string,
  ): Promise<Extract<ProviderEvent, { _tag: "turn.completed" }>> => {
    const seen = collectEvents();
    await Effect.runPromise(
      codex.startSession(
        sessionId,
        { ...SESSION_SPEC, systemPrompt: ASSESSOR_SYSTEM_PROMPT, outputSchema },
        buildContext(createHomeWithLogin()),
      ),
    );
    await Effect.runPromise(codex.sendInput(sessionId, { text }));
    await waitForEvent(seen, "turn.completed");
    await Effect.runPromise(codex.stopSession(sessionId, "stopped"));
    await waitForEvent(seen, "session.exited");
    return seen.find(
      (event): event is Extract<ProviderEvent, { _tag: "turn.completed" }> =>
        event._tag === "turn.completed",
    )!;
  };

  it(
    "answers the fixture schema with a value the schema accepts",
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
    "ends the turn with a schema failure when no value can satisfy the schema",
    async () => {
      const completed = await runTurnUnderSchema(IMPOSSIBLE, IMPOSSIBLE_SCHEMA, IMPOSSIBLE_PROMPT);

      expect(completed.structuredResult?.outcome, JSON.stringify(completed.structuredResult)).toBe(
        "schema-failure",
      );
      const failure = completed.structuredResult as { outcome: "schema-failure"; reason: string };
      expect(failure.reason).not.toBe("");
      expect(await Effect.runPromise(codex.listSessions)).toEqual([]);
    },
    Duration.toMillis(TURN_DEADLINE) * 2,
  );
});
