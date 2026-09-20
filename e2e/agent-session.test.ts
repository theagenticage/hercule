/**
 * The whole journey of a non-interactive agent session, run out of the release
 * binary: an Agent created through the CLI, a session spawned from that Agent
 * under an output schema, and the turn's answer read back from the transcript.
 *
 * The two schemas are imported from the protocol package's own testing module
 * rather than written again. A package reaches that module as
 * `@hercule/protocol/testing`, and this suite reaches it by relative path,
 * because the suite depends on no Hercule package. `live.test.ts` beside it
 * reaches client-core the same way. The module holds data only. Nothing else
 * of Hercule is imported here, and the binary under test knows nothing about
 * this process.
 *
 * Opt-in, like `session.test.ts` beside it: it spends the developer's tokens
 * and takes a couple of minutes. `HERCULE_LIVE_SESSION_TEST=1` asks for it.
 *
 * ## The login the session runs on
 *
 * A session runs against the Provider Instance's own `CLAUDE_CONFIG_DIR` under
 * the runner's storage (spec 06 section 4.2), which in a throwaway Hercule Home
 * is empty. There are two ways to give it one, and the case skips saying so
 * when it has neither:
 *
 * - `HERCULE_E2E_CLAUDE_CREDENTIALS` names a file holding what the Claude CLI
 *   stores as its credential. It is copied into the throwaway instance
 *   directory as `.credentials.json` and the instance is re-probed; the whole
 *   home, credential included, is deleted when the suite ends. Reading the
 *   developer's own login out of wherever their machine keeps it is the
 *   caller's business, never this file's.
 * - `ANTHROPIC_API_KEY` on the environment, which reaches the session through
 *   the runner the controller starts for itself.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  PASSWORD,
  ROOT,
  USERNAME,
  apiKeyIn,
  cli,
  completeSetup,
  instancesOf,
  jsonOk,
  liveSessionsAsked,
  startController,
  temporaryHome,
  untilTag,
  type Controller,
  type Instance,
  type Ran,
  type Row,
  type Session,
  type Snapshot,
} from "./harness";

/** Opt-in: `pnpm test:binary` on any machine must not quietly spend a subscription. */
const wanted = liveSessionsAsked();

/** The file a caller lent its Claude login through, where it lent one. */
const lentCredentials = process.env["HERCULE_E2E_CLAUDE_CREDENTIALS"];

const state = temporaryHome();
const binary = join(ROOT, "hercule");

let controller: Controller;
let url: string;
let apiKey: string;

/** Long enough for a cold harness to start, connect and answer one prompt. */
const TURN_DEADLINE_MS = 180_000;

/** Long enough for the runner to enrol and to probe a directory it was just handed. */
const LOGIN_DEADLINE_MS = 120_000;

interface Page<A> {
  readonly items: ReadonlyArray<A>;
}

/** An Agent as the agent operations answer it. */
interface Agent {
  readonly id: string;
  readonly name: string;
}

/**
 * `<home>/runner/<storage>/providers/<instanceId>`: the instance's private
 * config directory, named by the storage directory this runner's identity owns.
 */
const buildInstanceDir = (instanceId: string): string => {
  const pin = JSON.parse(readFileSync(join(state.home, "runner", "runner.json"), "utf8")) as {
    readonly storageDirectory: string;
  };
  return join(state.home, "runner", pin.storageDirectory, "providers", instanceId);
};

/** Lends the credential the caller named to the throwaway instance, for this run. */
const lendCredential = (instanceId: string): void => {
  const dir = buildInstanceDir(instanceId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, ".credentials.json");
  writeFileSync(path, readFileSync(lentCredentials!, "utf8"), { mode: 0o600 });
  chmodSync(path, 0o600);
};

/**
 * The controller's own runner, once it has enrolled and dialled in. It writes
 * `runner.json` and its storage directory on the way, which is what the login
 * is lent into, so nothing may read either before this answers.
 */
const enrolledRunner = async (): Promise<string> => {
  const deadline = Date.now() + LOGIN_DEADLINE_MS;
  for (;;) {
    const ran = await cli(["runner", "list", "--json"], { home: state.home, binary });
    const id = ran.code === 0 ? jsonOk<Page<{ readonly id: string }>>(ran).items[0]?.id : undefined;
    if (id !== undefined && existsSync(join(state.home, "runner", "runner.json"))) return id;
    if (Date.now() > deadline) throw new Error(`no runner dialled the controller:\n${ran.stdout}`);
    await Bun.sleep(500);
  }
};

const claudeInstance = async (): Promise<Instance> => {
  const found = (await instancesOf({ url, apiKey })).find(
    (one) => one.providerId === "claude-code",
  );
  if (found === undefined) throw new Error("no claude-code Provider Instance was seeded");
  return found;
};

/**
 * Probes the instance until a machine says its login works, and answers with
 * that snapshot. Repeated rather than trusted once: a probe of a directory
 * that was empty a moment ago has been seen to answer `unauthenticated`.
 */
const probedLoggedIn = async (runnerId: string, instanceId: string): Promise<Snapshot> => {
  const deadline = Date.now() + LOGIN_DEADLINE_MS;
  let last: string;
  for (;;) {
    const ran = await cli(["runner", "probe", runnerId, "--instance", instanceId, "--json"], {
      home: state.home,
      binary,
    });
    if (ran.code === 0) {
      const snapshot = jsonOk<Snapshot>(ran);
      if (snapshot.auth.status === "ok") return snapshot;
      last = `${snapshot.auth.status}: ${snapshot.auth.message ?? "no message"}`;
    } else {
      last = `${ran.stdout}\n${ran.stderr}`;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `the instance never probed ok within ${String(LOGIN_DEADLINE_MS / 1000)}s: ${last}`,
      );
    }
    await Bun.sleep(2_000);
  }
};

/** The Agent every case here spawns from. */
interface Ready {
  readonly agentId: string;
}

let ready: Ready | undefined;

/**
 * Everything that has to exist before a session can be spawned from an Agent:
 * a logged-in instance, the shipped profile its sessions carry, and the Agent
 * itself. Built once, because it is the same Agent both cases spawn from. The
 * Agent names no model, so its sessions run on whatever the instance offers by
 * default: a verdict is an instruction to follow, and the cheapest model on
 * offer has been seen to answer with its own.
 */
const prepare = async (): Promise<Ready> => {
  const runnerId = await enrolledRunner();
  const instance = await claudeInstance();
  if (lentCredentials !== undefined) lendCredential(instance.id);
  await probedLoggedIn(runnerId, instance.id);
  const profiles = jsonOk<Page<{ readonly id: string; readonly name: string }>>(
    await cli(["profile", "list", "--json"], { home: state.home, binary }),
  ).items;
  const profile = profiles.find((one) => one.name === "unrestricted") ?? profiles[0]!;
  const agent = jsonOk<Agent>(
    await cli(
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

/** The turn's own row, which is where a session's answer is read off. */
const findCompletedTurn = (rows: ReadonlyArray<Row>): Row => {
  const found = rows.find((row) => row.event._tag === "turn.completed");
  if (found === undefined) {
    throw new Error(`no completed turn in ${rows.map((row) => row.event._tag).join(", ")}`);
  }
  return found;
};

/** What a turn answered under its session's schema, as the transcript carries it. */
const readStructuredResult = (rows: ReadonlyArray<Row>): Readonly<Record<string, unknown>> => {
  const result = findCompletedTurn(rows).event["structuredResult"];
  if (typeof result !== "object" || result === null) {
    throw new Error(
      `the turn carried no structured result: ${JSON.stringify(findCompletedTurn(rows))}`,
    );
  }
  return result as Readonly<Record<string, unknown>>;
};

/** One session spawned from the Agent under a schema, and the turn it answered. */
const runSessionUnderSchema = async (
  schema: unknown,
  prompt: string,
): Promise<ReadonlyArray<Row>> => {
  const spawned: Ran = await cli(
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
  const session = jsonOk<Session>(spawned);
  return untilTag({
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

  const login = await cli(
    ["login", url, "--username", USERNAME, "--password-stdin", "--name", "e2e-agent-session"],
    { home: state.home, binary, stdin: PASSWORD },
  );
  expect(login.code, `${login.stdout}\n${login.stderr}`).toBe(0);
  apiKey = apiKeyIn(state.home);

  if (lentCredentials === undefined && process.env["ANTHROPIC_API_KEY"] === undefined) return;
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
