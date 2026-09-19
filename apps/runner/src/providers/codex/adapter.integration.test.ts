/**
 * That a real Codex session answers its output schema, and says so when no
 * value can satisfy it. Codex constrains the turn's final assistant message
 * itself; what is proven here is that the runner's verdict follows - an `ok`
 * whose value really fits, and a `schema-failure` that arrives as an ended turn
 * rather than as a hang.
 *
 * Opt-in twice over, because the alternative is that `pnpm test` on any
 * developer's machine quietly spends their subscription:
 * `HYDRA_LIVE_SESSION_TEST` asks for the run, and `CODEX_HOME` names the
 * directory the login is borrowed from - the developer's own Codex home is
 * never looked for, let alone read. The login is copied into a throwaway
 * instance home rather than used where it lies, because that home is the one
 * the session runs under.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Duration, Effect, Stream } from "effect";
import type { OutputSchema, ProviderEvent, SessionSpec } from "@hydra/protocol";
import { FIXTURE_SCHEMA, IMPOSSIBLE_SCHEMA } from "@hydra/protocol/output-schema.fixture";
import { codex } from "./adapter";
import type { ProviderRunnerContext } from "../index";

const binary = Bun.which("codex") ?? undefined;

const wanted = process.env["HYDRA_LIVE_SESSION_TEST"] !== undefined;

/** The directory the login is borrowed from; unset means this suite skips. */
const borrowed = process.env["CODEX_HOME"];

const scratch: Array<string> = [];

afterAll(() => {
  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const scratchDir = (label: string): string => {
  const made = mkdtempSync(join(tmpdir(), `hydra-codex-${label}-`));
  scratch.push(made);
  return made;
};

/**
 * An instance home with the borrowed login in it. The adapter points
 * `CODEX_HOME` at the home's own `codex/` directory, so that is where the
 * credential has to be for the session to be logged in at all.
 */
const homeWithLogin = (): string => {
  const home = scratchDir("home");
  const codexHome = join(home, "codex");
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  copyFileSync(join(borrowed!, "auth.json"), join(codexHome, "auth.json"));
  return home;
};

const contextFor = (home: string): ProviderRunnerContext => ({
  cwd: scratchDir("cwd"),
  home,
  binary: binary!,
  env: { PATH: process.env["PATH"] ?? "" },
  secrets: {},
  hydraTool: { skill: "", claudePluginDir: join(home, "claude-plugin") },
});

const ready =
  binary !== undefined &&
  wanted &&
  borrowed !== undefined &&
  existsSync(join(borrowed, "auth.json"));

/**
 * What the borrowed login can do, asked the way the runner asks it: whether it
 * is a login at all, and which model this account gets by default - a slug
 * written down here would be one more thing to keep up with OpenAI's catalogue.
 */
const probed = !ready
  ? undefined
  : await Effect.runPromise(codex.probe(contextFor(homeWithLogin()), {}));

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

/** Long enough for a cold app-server to start, connect and answer one prompt. */
const TURN_DEADLINE = Duration.seconds(120);

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

/** A fresh subscriber per session: the stream is unbounded and never replays. */
const watching = (): Array<ProviderEvent> => {
  const seen: Array<ProviderEvent> = [];
  Effect.runFork(
    Stream.runForEach(codex.events, (event) => Effect.sync(() => void seen.push(event))),
  );
  return seen;
};

const STRUCTURED = "0199e0e7-0000-7000-8000-00000000ff05";
const IMPOSSIBLE = "0199e0e7-0000-7000-8000-00000000ff06";

const AGENT_PROMPT =
  "You assess tasks and answer with a verdict. Where the user names the verdict, give that one.";

describe.skipIf(!authed)("a real Codex session under an output schema", () => {
  /** One session under one schema: start, ask, wait the turn out, stop. */
  const answering = async (
    sessionId: string,
    outputSchema: OutputSchema,
    text: string,
  ): Promise<Extract<ProviderEvent, { _tag: "turn.completed" }>> => {
    const seen = watching();
    await Effect.runPromise(
      codex.startSession(
        sessionId,
        { ...SESSION_SPEC, systemPrompt: AGENT_PROMPT, outputSchema },
        contextFor(homeWithLogin()),
      ),
    );
    await Effect.runPromise(codex.sendInput(sessionId, { text }));
    await until(seen, "turn.completed");
    await Effect.runPromise(codex.stopSession(sessionId, "stopped"));
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
      expect(await Effect.runPromise(codex.listSessions)).toEqual([]);
    },
    Duration.toMillis(TURN_DEADLINE) * 2,
  );
});
