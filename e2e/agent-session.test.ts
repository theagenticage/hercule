/**
 * Tests the whole flow of a non-interactive agent session through the release
 * binary: an Agent created through the CLI, a session spawned from that Agent
 * under an output schema, and the turn's result read back from the
 * transcript.
 *
 * The two schemas are imported from the protocol package's own testing module
 * rather than written again. A package imports that module as
 * `@hercule/protocol/testing`, and this suite imports it by relative path,
 * because the suite depends on no Hercule package. `live.test.ts` imports
 * client-core the same way. The module holds data only. Nothing else
 * of Hercule is imported here, and the binary under test knows nothing about
 * this process.
 *
 * Opt-in, like `session.test.ts`: it spends the developer's tokens and takes a
 * couple of minutes. Set `HERCULE_LIVE_SESSION_TEST=1` to run it.
 *
 * The login it runs on is provided for the run by either of the two routes
 * `e2e/harness.ts` documents; with neither, the case is skipped with a
 * message.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ASSESSOR_SYSTEM_PROMPT,
  FIXTURE_PROMPT,
  FIXTURE_SCHEMA,
  IMPOSSIBLE_PROMPT,
  IMPOSSIBLE_SCHEMA,
} from "../packages/protocol/src/output-schema.testing";
import {
  runCli,
  completeSetup,
  PASSWORD,
  ROOT,
  startController,
  USERNAME,
  type Controller,
  type Ran,
} from "../scripts/controller-process";
import {
  readApiKey,
  parseJsonOutputOrFail,
  isLiveSessionTestEnabled,
  LOGIN_DEADLINE_MS,
  isLoginAvailable,
  prepareLoggedInInstance,
  createTemporaryHome,
  waitForTranscriptTag,
  type Page,
  type Row,
  type Session,
} from "./harness";

/** Opt-in: `pnpm test:binary` on any machine must not silently spend a subscription. */
const wanted = isLiveSessionTestEnabled();

const state = createTemporaryHome();
const binary = join(ROOT, "hercule");

let controller: Controller;
let url: string;
let apiKey: string;

/** Long enough for a cold harness to start, connect and reply to one prompt. */
const TURN_DEADLINE_MS = 180_000;

/** An Agent as the agent operations return it. */
interface Agent {
  readonly id: string;
  readonly name: string;
}

/** The Agent every case here spawns from. */
interface Ready {
  readonly agentId: string;
}

let ready: Ready | undefined;

/**
 * Prepares everything that has to exist before a session can be spawned from
 * an Agent: a logged-in instance, the shipped profile its sessions carry, and
 * the Agent itself. Built once, because both cases spawn from the same Agent.
 * The Agent sets no model, so its sessions run on the instance's default: the
 * verdict in the prompt is an instruction to follow, and the cheapest model
 * available has been seen to give its own verdict instead.
 */
const prepare = async (): Promise<Ready> => {
  const { instance } = await prepareLoggedInInstance({ home: state.home, binary, url, apiKey });
  const profiles = parseJsonOutputOrFail<Page<{ readonly id: string; readonly name: string }>>(
    await runCli(["profile", "list", "--json"], { home: state.home, binary }),
  ).items;
  const profile = profiles.find((one) => one.name === "unrestricted") ?? profiles[0]!;
  const agent = parseJsonOutputOrFail<Agent>(
    await runCli(
      [
        "agent",
        "create",
        "--name",
        "e2e-assessor",
        "--instance",
        instance.id,
        "--profile",
        profile.id,
        "--json",
      ],
      { home: state.home, binary, stdin: ASSESSOR_SYSTEM_PROMPT },
    ),
  );
  return { agentId: agent.id };
};

/** Returns the `turn.completed` row, which holds the session's result. */
const findCompletedTurn = (rows: ReadonlyArray<Row>): Row => {
  const found = rows.find((row) => row.event._tag === "turn.completed");
  if (found === undefined) {
    throw new Error(`no completed turn in ${rows.map((row) => row.event._tag).join(", ")}`);
  }
  return found;
};

/** Returns what a turn returned under its session's schema, as the transcript holds it. */
const readStructuredResult = (rows: ReadonlyArray<Row>): Readonly<Record<string, unknown>> => {
  const result = findCompletedTurn(rows).event["structuredResult"];
  if (typeof result !== "object" || result === null) {
    throw new Error(
      `the turn carried no structured result: ${JSON.stringify(findCompletedTurn(rows))}`,
    );
  }
  return result as Readonly<Record<string, unknown>>;
};

/**
 * Spawns one session from the Agent under a schema, and returns its transcript
 * once the turn is over.
 */
const runSessionUnderSchema = async (
  schema: unknown,
  prompt: string,
): Promise<ReadonlyArray<Row>> => {
  const spawned: Ran = await runCli(
    [
      "session",
      "spawn",
      "--agent",
      ready!.agentId,
      "--output-schema",
      JSON.stringify(schema),
      "--json",
    ],
    { home: state.home, binary, stdin: prompt },
  );
  const session = parseJsonOutputOrFail<Session>(spawned);
  return waitForTranscriptTag({
    home: state.home,
    binary,
    id: session.id,
    tag: "turn.completed",
    timeoutMs: TURN_DEADLINE_MS,
  });
};

beforeAll(async () => {
  if (!wanted) return;
  if (!existsSync(binary)) {
    throw new Error(
      `no binary at ${binary}: run \`pnpm build:binary\` before \`pnpm test:binary\`.`,
    );
  }
  controller = await startController({ home: state.home, binary });
  url = controller.url;

  const completed = await completeSetup({ home: state.home, url, binary });
  expect(completed.code, `${completed.stdout}\n${completed.stderr}`).toBe(0);

  const login = await runCli(
    ["login", url, "--username", USERNAME, "--password-stdin", "--name", "e2e-agent-session"],
    { home: state.home, binary, stdin: PASSWORD },
  );
  expect(login.code, `${login.stdout}\n${login.stderr}`).toBe(0);
  apiKey = readApiKey(state.home);

  if (!isLoginAvailable()) return;
  ready = await prepare();
}, LOGIN_DEADLINE_MS * 2);

afterAll(async () => {
  await controller?.stop().catch(() => -1);
  state.remove();
});

describe.skipIf(!wanted)("a session spawned from an Agent under an output schema", () => {
  it(
    "answers the fixture schema with a value a program can route on",
    async (ctx) => {
      if (ready === undefined) {
        ctx.skip(
          "no login for the claude-code instance: name a credentials file in " +
            "HERCULE_E2E_CLAUDE_CREDENTIALS, or put ANTHROPIC_API_KEY on the environment.",
        );
        return;
      }

      const rows = await runSessionUnderSchema(FIXTURE_SCHEMA, FIXTURE_PROMPT);

      const result = readStructuredResult(rows) as {
        outcome: string;
        value: { verdict?: unknown };
      };
      expect(result.outcome, JSON.stringify(result)).toBe("ok");
      expect(result.value.verdict).toBe("accept");
    },
    TURN_DEADLINE_MS + 60_000,
  );

  it(
    "says the schema could not be satisfied rather than runSessionUnderSchema prose",
    async (ctx) => {
      if (ready === undefined) {
        ctx.skip("no login for the claude-code instance");
        return;
      }

      const rows = await runSessionUnderSchema(IMPOSSIBLE_SCHEMA, IMPOSSIBLE_PROMPT);

      const result = readStructuredResult(rows) as { outcome: string; reason: string };
      expect(result.outcome, JSON.stringify(result)).toBe("schema-failure");
      expect(result.reason).not.toBe("");
    },
    TURN_DEADLINE_MS + 60_000,
  );
});
