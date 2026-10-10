/**
 * Checks the Codex adapter against a real `codex` binary.
 *
 * The first checks what a Thread that sees the user's material is shown, and
 * what another session is shown. It renders the prompt with
 * `codex debug prompt-input`, which needs no login and calls no API, so it
 * runs whenever `codex` is on the `PATH`.
 *
 * The second checks that a real Codex session answers with its output
 * schema, and reports a schema failure when no value can satisfy the schema.
 * Codex itself constrains the turn's final assistant message; these tests
 * check that the runner's result matches: `ok` with a value that really fits,
 * and a `schema-failure` that arrives as an ended turn rather than a hang.
 *
 * The second suite needs two opt-ins, so that `pnpm test` never quietly
 * spends a developer's subscription:
 *
 * - `HERCULE_LIVE_SESSION_TEST` must be set.
 * - `CODEX_HOME` must name the directory to copy the login from. The
 *   developer's own Codex home is never searched for or read.
 *
 * The login is copied into a throwaway instance home, because the session
 * runs under that home.
 *
 * The third suite drives real native subagents and approvals against a local
 * Responses API fixture. It needs no login and makes no external API calls.
 * `HERCULE_CODEX_TEST_BINARY` can select a pinned binary without changing PATH.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Duration, Effect, Fiber, Stream } from "effect";
import {
  computeSubagentAfter,
  createBareSubagent,
} from "../../../../controller/src/sessions/subagents";
import type { OutputSchema, ProviderEvent, SessionSpec } from "@hercule/protocol";
import {
  ASSESSOR_SYSTEM_PROMPT,
  FIXTURE_PROMPT,
  FIXTURE_SCHEMA,
  IMPOSSIBLE_PROMPT,
  IMPOSSIBLE_SCHEMA,
} from "@hercule/protocol/testing";
import { codex, makeCodexAdapter } from "./adapter";
import { runProcess, spawnAppServer } from "../process";
import { startMockModel } from "./mock-model.testing";
import type { ProviderRunnerContext } from "../index";
import { createLines, NO_CONTROLLER_TOOL_IMAGES, NO_USER_MATERIAL_PATHS } from "../testing";
import { buildScriptedSeam, listSentParams, SESSION, SPEC } from "./testing";

const binary = process.env["HERCULE_CODEX_TEST_BINARY"] ?? Bun.which("codex") ?? undefined;

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
  attachmentsDir: null,
  toolImages: NO_CONTROLLER_TOOL_IMAGES,
  home,
  binary: binary!,
  env: { PATH: process.env["PATH"] ?? "" },
  secrets: {},
  herculeTool: { skill: "", claudePluginDir: join(home, "claude-plugin") },
});

/**
 * Renders the prompt Codex would send for a session the adapter starts with
 * `ctx`, and returns it as JSON text. The adapter runs against a scripted
 * app-server, which records the environment it was started with and the
 * developer instructions of its thread. `codex debug prompt-input` is then run
 * with that environment, and the developer instructions are passed as the
 * `developer_instructions` config value, the setting that the app-server's
 * `developerInstructions` param overrides.
 */
const renderPrompt = async (ctx: ProviderRunnerContext): Promise<string> => {
  const { seam, spawns, requests } = buildScriptedSeam();
  await Effect.runPromise(makeCodexAdapter(seam).startSession(SESSION, SPEC, ctx));
  const { developerInstructions } = listSentParams(requests, "thread/start")[0] as {
    readonly developerInstructions: string;
  };
  const rendered = Bun.spawnSync({
    cmd: [
      binary!,
      "debug",
      "prompt-input",
      "-c",
      "check_for_update_on_startup=false",
      "-c",
      // A JSON string is also a valid TOML string for this text.
      `developer_instructions=${JSON.stringify(developerInstructions)}`,
      "hello",
    ],
    cwd: ctx.cwd!,
    env: Object.fromEntries(
      Object.entries(spawns[0]!.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
  });
  expect(rendered.exitCode, rendered.stderr.toString()).toBe(0);
  return rendered.stdout.toString();
};

describe.skipIf(binary === undefined)("what a real Codex is shown of the user's material", () => {
  const SKILL = "hercule-test-user-skill";
  const INSTRUCTIONS = "hercule-test-user-instructions: always answer in English.";
  const GLOBAL = "hercule-test-global-agents-file";

  /**
   * Creates a stand-in for the user's home directory: one skill in
   * `.agents/skills`, and an `AGENTS.md` in its `.codex` directory. The
   * adapter points `CODEX_HOME` at the instance's own directory, so Codex must
   * never read that `AGENTS.md` by itself.
   */
  const createUserHome = (): string => {
    const home = createScratchDir("user");
    mkdirSync(join(home, ".agents", "skills", SKILL), { recursive: true });
    writeFileSync(
      join(home, ".agents", "skills", SKILL, "SKILL.md"),
      `---\nname: ${SKILL}\ndescription: A skill only the user has.\n---\n\nSay hi.\n`,
    );
    mkdirSync(join(home, ".codex"));
    writeFileSync(join(home, ".codex", "AGENTS.md"), GLOBAL);
    return home;
  };

  it("shows a Thread the user's skills and instructions", async () => {
    const userHome = createUserHome();
    const instructionsFile = join(createScratchDir("instructions"), "AGENTS.md");
    writeFileSync(instructionsFile, INSTRUCTIONS);
    const ctx = buildContext(createScratchDir("home"));

    const prompt = await renderPrompt({
      ...ctx,
      env: { ...ctx.env, HOME: userHome },
      userMaterial: { ...NO_USER_MATERIAL_PATHS, instructionsFile },
    });

    expect(prompt).toContain(SKILL);
    expect(prompt).toContain(INSTRUCTIONS);
    // The user's `.codex/AGENTS.md` stays out: Codex reads its instance's own
    // CODEX_HOME, so the instructions reach the Thread only through the
    // developer instructions.
    expect(prompt).not.toContain(GLOBAL);
  });

  it("shows any other session none of the user's material", async () => {
    const userHome = createUserHome();
    const ctx = buildContext(createScratchDir("home"));

    const prompt = await renderPrompt({ ...ctx, env: { ...ctx.env, HOME: userHome } });

    expect(prompt).not.toContain(SKILL);
    expect(prompt).not.toContain(GLOBAL);
  });
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

/** These tests run real native tools against a local model fixture, with no account or API calls. */
describe.skipIf(binary === undefined)(
  "a real Codex session with concurrent child approvals",
  () => {
    it.each(["v1", "v2"] as const)(
      "%s keeps both approvals open, completes children independently, and sums thread usage",
      async (version) => {
        const model = startMockModel(version);
        const home = createScratchDir("subagents");
        mkdirSync(join(home, "codex"));
        writeFileSync(join(home, "codex", "config.toml"), model.config);
        const nativeNicknames = new Map<string, string>();
        const adapter = makeCodexAdapter({
          run: runProcess,
          appServer: (command, env) => {
            const process = spawnAppServer(command, env);
            return {
              ...process,
              stdout: {
                async *[Symbol.asyncIterator]() {
                  for await (const line of process.stdout) {
                    const frame = JSON.parse(line) as {
                      readonly result?: {
                        readonly thread?: {
                          readonly id: string;
                          readonly agentNickname?: string | null;
                        };
                      };
                    };
                    const thread = frame.result?.thread;
                    if (thread?.agentNickname) nativeNicknames.set(thread.id, thread.agentNickname);
                    yield line;
                  }
                },
              },
            };
          },
        });
        const seen: Array<ProviderEvent> = [];
        const subscriber = Effect.runFork(
          Stream.runForEach(adapter.events, (event) => Effect.sync(() => void seen.push(event))),
        );
        const waitUntil = async (predicate: () => boolean) => {
          const deadline = Date.now() + 20_000;
          while (!predicate()) {
            if (Date.now() >= deadline)
              throw new Error(
                `Codex fixture deadline: ${seen.map((event) => event._tag).join(", ")}`,
              );
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
        };
        const childCompletions = () =>
          seen.filter(
            (event): event is Extract<ProviderEvent, { _tag: "turn.completed" }> =>
              event._tag === "turn.completed" && event.subagentId !== undefined,
          );
        const approvals = () =>
          seen.filter(
            (event): event is Extract<ProviderEvent, { _tag: "request.opened" }> =>
              event._tag === "request.opened",
          );
        const sessionId =
          version === "v1"
            ? "0199e0e7-0000-7000-8000-00000000ff07"
            : "0199e0e7-0000-7000-8000-00000000ff08";
        try {
          await Effect.runPromise(
            adapter.startSession(
              sessionId,
              {
                ...SESSION_SPEC,
                modelSelection: { model: "gpt-5.4", options: {} },
              },
              {
                ...buildContext(home),
                env: {
                  PATH: process.env["PATH"] ?? "",
                  HERCULE_CODEX_FIXTURE_KEY: "dummy-local-key",
                },
              },
            ),
          );
          await Effect.runPromise(
            adapter.sendInput(sessionId, { text: "Establish root history." }),
          );
          await waitUntil(() => seen.some((event) => event._tag === "turn.completed"));
          await Effect.runPromise(adapter.sendInput(sessionId, { text: "Spawn both children." }));
          await waitUntil(
            () =>
              approvals().length === 2 &&
              seen.filter(
                (event) => event._tag === "turn.completed" && event.subagentId === undefined,
              ).length === 2,
          );
          const [first, second] = approvals();
          expect(first!.subagentId).toBeDefined();
          expect(second!.subagentId).toBeDefined();
          expect(first!.subagentId).not.toBe(second!.subagentId);
          expect(childCompletions()).toHaveLength(0);
          const introduced = seen.filter((event) => event._tag === "subagent.started");
          expect(introduced).toHaveLength(2);
          expect(introduced.every((event) => event.parentSubagentId === undefined)).toBe(true);
          if (version === "v1") {
            const descriptions = introduced.map(
              (child) =>
                seen.reduce(
                  (record, event) => computeSubagentAfter(record, event, { inFirstTurn: true }),
                  createBareSubagent(sessionId, child.subagentId, child.at),
                ).description,
            );
            expect(descriptions.sort()).toEqual([
              "Child first: ask approval, then finish.",
              "Child second: ask approval, then finish.",
            ]);
          } else {
            for (const child of introduced) {
              expect(nativeNicknames.has(child.subagentId)).toBe(true);
              expect(child.description).toBe(nativeNicknames.get(child.subagentId));
            }
          }
          expect(
            seen
              .filter((event) => event._tag === "turn.started" && event.subagentId !== undefined)
              .map((event) => (event._tag === "turn.started" ? event.model : undefined)),
          ).toEqual(["gpt-5.4", "gpt-5.4"]);
          expect(
            seen.filter(
              (event) =>
                event._tag === "item.started" &&
                event.subagentId !== undefined &&
                event.kind === "command_execution",
            ),
          ).toHaveLength(2);
          await Effect.runPromise(
            adapter.respondToApprovalRequest(sessionId, second!.request.requestId, "allow"),
          );
          await waitUntil(() => childCompletions().length === 1);
          expect(childCompletions()[0]!.subagentId).toBe(second!.subagentId);
          expect(
            seen.some(
              (event) =>
                event._tag === "request.resolved" && event.requestId === first!.request.requestId,
            ),
          ).toBe(false);
          await Effect.runPromise(
            adapter.respondToApprovalRequest(sessionId, first!.request.requestId, "allow"),
          );
          await waitUntil(() => childCompletions().length === 2);
          const usage = seen.filter((event) => event._tag === "session.usage.updated");
          const children = usage.filter((event) => event.subagentId !== undefined);
          expect(new Set(children.map((event) => event.subagentId)).size).toBe(2);
          for (const childId of model.children) {
            expect(children.filter((event) => event.subagentId === childId).at(-1)!.usage).toEqual({
              inputTokens: 600,
              outputTokens: 20,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            });
          }
          expect(usage.filter((event) => event.subagentId === undefined).at(-1)!.usage).toEqual({
            inputTokens: version === "v1" ? 2_500 : 2_400,
            outputTokens: version === "v1" ? 80 : 70,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          });
        } finally {
          await Effect.runPromise(adapter.stopSession(sessionId, "stopped"));
          await Effect.runPromise(Fiber.interrupt(subscriber));
          await model.stop();
        }
      },
      45_000,
    );
  },
);

/** Checks native whole-session, subtree and selective Stops with real nested subagents and Requests. */
describe.skipIf(binary === undefined)("Stop against real Codex subagents", () => {
  it.each([
    ["v1", "whole"],
    ["v2", "whole"],
    ["v1", "subtree"],
    ["v2", "subtree"],
    ["v1", "selective"],
    ["v2", "selective"],
    ["v1", "discovering-subtree"],
    ["v2", "discovering-subtree"],
  ] as const)(
    "%s stops %s work while preserving unrelated work",
    async (version, target) => {
      const model = startMockModel(version, true);
      const home = createScratchDir("native-stop");
      mkdirSync(join(home, "codex"));
      // V2 exposes delegation tools to subagents only for a V2 model preset.
      // A small local catalog makes that capability explicit for the fixture.
      const catalog = join(home, "codex", "model-catalog.json");
      if (version === "v2")
        writeFileSync(
          catalog,
          JSON.stringify({
            models: [
              {
                slug: "gpt-5.4",
                display_name: "Local fixture",
                description: "Local model fixture",
                supported_reasoning_levels: [],
                shell_type: "unified_exec",
                visibility: "list",
                supported_in_api: true,
                priority: 0,
                support_verbosity: false,
                truncation_policy: { mode: "tokens", limit: 10000 },
                experimental_supported_tools: [],
                base_instructions: "Complete the isolated fixture task.",
                multi_agent_version: "v2",
              },
            ],
          }),
        );
      writeFileSync(
        join(home, "codex", "config.toml"),
        `${version === "v2" ? `model_catalog_json = ${JSON.stringify(catalog)}\n` : ""}${model.config}`,
      );
      const delayed = createLines();
      let heldMetadata: { line: string; id: string; parentId: string } | undefined;
      let descendantRequestArrived = false;
      const adapter = makeCodexAdapter({
        appServer:
          target !== "discovering-subtree"
            ? spawnAppServer
            : (command, env) => {
                const child = spawnAppServer(command, env);
                const reads = new Set<string | number>();
                let rootId: string | undefined;
                void (async () => {
                  try {
                    for await (const line of child.stdout) {
                      const frame = JSON.parse(line) as {
                        id?: string | number;
                        method?: string;
                        params?: { threadId?: string };
                        result?: { thread?: { id: string; parentThreadId?: string | null } };
                      };
                      const thread = frame.result?.thread;
                      rootId ??= thread?.id;
                      if (
                        frame.id !== undefined &&
                        reads.has(frame.id) &&
                        thread?.parentThreadId != null &&
                        thread.parentThreadId !== rootId
                      ) {
                        heldMetadata = { line, id: thread.id, parentId: thread.parentThreadId };
                        continue;
                      }
                      if (
                        frame.method === "item/commandExecution/requestApproval" &&
                        frame.params?.threadId === heldMetadata?.id
                      )
                        descendantRequestArrived = true;
                      delayed.push(line);
                    }
                  } finally {
                    delayed.end();
                  }
                })();
                return {
                  ...child,
                  stdout: delayed.iterable,
                  write: (line) => {
                    const frame = JSON.parse(line) as { id?: string | number; method?: string };
                    if (frame.method === "thread/read" && frame.id !== undefined)
                      reads.add(frame.id);
                    child.write(line);
                  },
                };
              },
        run: runProcess,
      });
      const seen: Array<ProviderEvent> = [];
      const subscriber = Effect.runFork(
        Stream.runForEach(adapter.events, (event) => Effect.sync(() => void seen.push(event))),
      );
      const sessionId = "0199e0e7-0000-7000-8000-00000000ff10";
      const waitUntil = async (predicate: () => boolean) => {
        const deadline = Date.now() + 20_000;
        while (!predicate()) {
          if (Date.now() >= deadline)
            throw new Error(
              `Codex Stop fixture deadline: ${seen.map((event) => event._tag).join(", ")}`,
            );
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      };
      try {
        await Effect.runPromise(
          adapter.startSession(
            sessionId,
            { ...SESSION_SPEC, modelSelection: { model: "gpt-5.4", options: {} } },
            {
              ...buildContext(home),
              env: {
                PATH: process.env["PATH"] ?? "",
                HERCULE_CODEX_FIXTURE_KEY: "dummy-local-key",
              },
            },
          ),
        );
        await Effect.runPromise(adapter.sendInput(sessionId, { text: "Establish history." }));
        await waitUntil(() =>
          seen.some((event) => event._tag === "turn.completed" && event.subagentId === undefined),
        );
        await Effect.runPromise(adapter.sendInput(sessionId, { text: "Spawn the tree." }));
        await waitUntil(
          () =>
            (target === "discovering-subtree"
              ? heldMetadata !== undefined &&
                descendantRequestArrived &&
                seen.filter((event) => event._tag === "request.opened").length === 2
              : seen.filter((event) => event._tag === "request.opened").length === 3) &&
            model.waitingChildren.size === 1,
        );
        const introduced = seen.filter((event) => event._tag === "subagent.started");
        const descendant =
          target === "discovering-subtree"
            ? { subagentId: heldMetadata!.id, parentSubagentId: heldMetadata!.parentId }
            : introduced.find((event) => event.parentSubagentId !== undefined)!;
        expect(descendant).toBeDefined();
        const branch = introduced.find(
          (event) => event.subagentId === descendant.parentSubagentId,
        )!;
        const sibling = introduced.find(
          (event) => event.parentSubagentId === undefined && event.subagentId !== branch.subagentId,
        )!;
        const subtree = target === "subtree" || target === "discovering-subtree";
        const stoppedIds =
          target === "whole"
            ? introduced.map((event) => event.subagentId)
            : subtree
              ? [branch.subagentId, descendant.subagentId]
              : [descendant.subagentId];
        await Effect.runPromise(
          adapter.interrupt(
            sessionId,
            target === "whole" ? undefined : subtree ? branch.subagentId : descendant.subagentId,
          ),
        );
        if (target === "discovering-subtree") {
          await waitUntil(() =>
            seen.some(
              (event) =>
                event._tag === "turn.completed" &&
                event.subagentId === branch.subagentId &&
                event.state === "interrupted",
            ),
          );
          expect(
            seen.filter(
              (event) =>
                event._tag === "subagent.started" && event.subagentId === descendant.subagentId,
            ),
          ).toEqual([]);
          delayed.push(heldMetadata!.line);
        }
        await waitUntil(() =>
          stoppedIds.every((id) =>
            seen.some(
              (event) =>
                event._tag === "turn.completed" &&
                event.subagentId === id &&
                event.state === "interrupted",
            ),
          ),
        );
        for (const request of seen
          .filter((event) => event._tag === "request.opened")
          .filter((event) => stoppedIds.includes(event.subagentId!))) {
          expect(
            seen.some(
              (event) =>
                event._tag === "request.resolved" &&
                event.requestId === request.request.requestId &&
                "decision" in event &&
                event.decision === "cancel",
            ),
          ).toBe(true);
        }
        if (target === "discovering-subtree") {
          const request = seen
            .filter((event) => event._tag === "request.opened")
            .find((event) => event.subagentId === descendant.subagentId)!;
          expect(request).toBeDefined();
          const completions = seen.filter(
            (event) =>
              event._tag === "turn.completed" && event.subagentId === descendant.subagentId,
          ).length;
          await Effect.runPromise(
            adapter.respondToApprovalRequest(sessionId, request.request.requestId, "allow"),
          );
          expect(
            seen.filter(
              (event) =>
                event._tag === "turn.completed" && event.subagentId === descendant.subagentId,
            ),
          ).toHaveLength(completions);
        }
        if (target === "whole") {
          await waitUntil(() =>
            seen.some(
              (event) =>
                event._tag === "turn.completed" &&
                event.subagentId === undefined &&
                event.state === "interrupted",
            ),
          );
        } else {
          expect(
            seen.filter(
              (event) => event._tag === "turn.completed" && event.subagentId === sibling.subagentId,
            ),
          ).toEqual([]);
          expect(
            seen.filter(
              (event) => event._tag === "turn.completed" && event.subagentId === undefined,
            ),
          ).toHaveLength(1);
          const request = seen.find(
            (event) => event._tag === "request.opened" && event.subagentId === sibling.subagentId,
          )!;
          if (request._tag !== "request.opened")
            throw new Error("the sibling did not ask for approval");
          await Effect.runPromise(
            adapter.respondToApprovalRequest(sessionId, request.request.requestId, "allow"),
          );
          await waitUntil(() =>
            seen.some(
              (event) =>
                event._tag === "turn.completed" &&
                event.subagentId === sibling.subagentId &&
                event.state === "completed",
            ),
          );
        }
        expect(await Effect.runPromise(adapter.listSessions)).toHaveLength(1);
      } finally {
        await Effect.runPromise(adapter.stopSession(sessionId, "stopped"));
        await Effect.runPromise(Fiber.interrupt(subscriber));
        await model.stop();
      }
    },
    45_000,
  );
});

/** Proves accounting across a real process restart, including cancellation before a model completes. */
describe.skipIf(binary === undefined)("a real Codex child's usage after process restart", () => {
  it.each([
    ["v1", true],
    ["v2", true],
    ["v1", false],
    ["v2", false],
  ] as const)(
    "%s counts only new calls with saved report=%s",
    async (version, saveReport) => {
      const model = startMockModel(version);
      const home = createScratchDir("usage-resume");
      mkdirSync(join(home, "codex"));
      writeFileSync(join(home, "codex", "config.toml"), model.config);
      const context: ProviderRunnerContext = {
        ...buildContext(home),
        env: { PATH: process.env["PATH"] ?? "", HERCULE_CODEX_FIXTURE_KEY: "dummy-local-key" },
      };
      const sessionId = "0199e0e7-0000-7000-8000-00000000ff09";
      const spec: SessionSpec = {
        ...SESSION_SPEC,
        modelSelection: { model: "gpt-5.4", options: {} },
      };
      let adapter = makeCodexAdapter({ appServer: spawnAppServer, run: runProcess });
      const seen: Array<ProviderEvent> = [];
      const subscribe = () =>
        Effect.runFork(
          Stream.runForEach(adapter.events, (event) => Effect.sync(() => void seen.push(event))),
        );
      let subscriber = subscribe();
      const waitUntil = async (predicate: () => boolean) => {
        const deadline = Date.now() + 20_000;
        while (!predicate()) {
          if (Date.now() >= deadline)
            throw new Error(
              `Codex resume fixture deadline: ${seen.map((event) => event._tag).join(", ")}`,
            );
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      };
      const childCompletions = () =>
        seen.filter(
          (event): event is Extract<ProviderEvent, { _tag: "turn.completed" }> =>
            event._tag === "turn.completed" && event.subagentId !== undefined,
        );
      const rootCompletions = () =>
        seen.filter((event) => event._tag === "turn.completed" && event.subagentId === undefined);
      try {
        const binding = await Effect.runPromise(adapter.startSession(sessionId, spec, context));
        await Effect.runPromise(adapter.sendInput(sessionId, { text: "Establish history." }));
        await waitUntil(() => rootCompletions().length === 1);
        await Effect.runPromise(adapter.sendInput(sessionId, { text: "Spawn children." }));
        await waitUntil(() => seen.filter((event) => event._tag === "request.opened").length === 2);
        for (const event of seen.filter((event) => event._tag === "request.opened")) {
          await Effect.runPromise(
            adapter.respondToApprovalRequest(sessionId, event.request.requestId, "allow"),
          );
        }
        await waitUntil(() => childCompletions().length === 2 && rootCompletions().length === 2);
        const carried = seen
          .filter((event) => event._tag === "subagent.started")
          .map((event) => {
            const report = seen
              .filter(
                (usage) =>
                  usage._tag === "session.usage.updated" && usage.subagentId === event.subagentId,
              )
              .at(-1);
            expect(
              report?._tag === "session.usage.updated" ? report.usage?.inputTokens : undefined,
            ).toBe(600);
            expect(report?.raw).toBeDefined();
            return {
              subagentId: event.subagentId,
              ...(event.itemId === undefined ? {} : { itemId: event.itemId }),
              ...(saveReport ? { lastUsageReport: report!.raw! } : {}),
            };
          });
        const childId = carried[0]!.subagentId;
        await Effect.runPromise(adapter.stopSession(sessionId, "stopped"));
        await Effect.runPromise(Fiber.interrupt(subscriber));
        seen.length = 0;
        adapter = makeCodexAdapter({ appServer: spawnAppServer, run: runProcess });
        subscriber = subscribe();
        await Effect.runPromise(
          adapter.startSession(
            sessionId,
            {
              ...spec,
              continue: {
                nativeSessionId: binding.nativeSessionId,
                mode: "resume",
                subagents: carried,
              },
            },
            context,
          ),
        );
        model.scheduleFollowup(childId, true);
        await Effect.runPromise(
          adapter.sendInput(sessionId, { text: "Continue the known child." }),
        );
        await waitUntil(() => model.waitingChildren.has(childId) && rootCompletions().length === 1);
        await Effect.runPromise(adapter.interrupt(sessionId, childId));
        // Codex reports a turn's usage in its own notification, which may
        // arrive after the turn's completion, so the test waits for both.
        const childUsageReports = () =>
          seen.filter(
            (event) => event._tag === "session.usage.updated" && event.subagentId === childId,
          );
        await waitUntil(() => childCompletions().length === 1 && childUsageReports().length >= 1);
        expect(childCompletions()[0]!.state).toBe("interrupted");
        const cancelledUsage = seen
          .filter((event) => event._tag === "session.usage.updated" && event.subagentId === childId)
          .at(-1);
        expect(
          cancelledUsage?._tag === "session.usage.updated" ? cancelledUsage.usage : undefined,
        ).toEqual({
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        });
        const reportsBeforeCompletion = childUsageReports().length;
        model.scheduleFollowup(childId, false);
        await Effect.runPromise(
          adapter.sendInput(sessionId, { text: "Continue the child to completion." }),
        );
        await waitUntil(
          () =>
            childCompletions().length === 2 && childUsageReports().length > reportsBeforeCompletion,
        );
        const completedUsage = seen
          .filter((event) => event._tag === "session.usage.updated" && event.subagentId === childId)
          .at(-1);
        expect(
          completedUsage?._tag === "session.usage.updated" ? completedUsage.usage : undefined,
        ).toEqual({
          inputTokens: 300,
          outputTokens: 10,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        });
        const introducedIds = seen
          .filter((event) => event._tag === "subagent.started")
          .map((event) => event.subagentId);
        expect(introducedIds.every((id) => carried.some((known) => known.subagentId === id))).toBe(
          true,
        );
        expect(new Set(introducedIds).size).toBe(introducedIds.length);
      } finally {
        await Effect.runPromise(adapter.stopSession(sessionId, "stopped"));
        await Effect.runPromise(Fiber.interrupt(subscriber));
        await model.stop();
      }
    },
    45_000,
  );
});
