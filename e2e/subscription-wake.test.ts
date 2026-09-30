/**
 * Tests the long-wait pattern end to end through the release binary: a real
 * session subscribes to an External Ref and ends its turn, a person emits an
 * event with that ref from a terminal, and the session's next turn starts with
 * the rendered event.
 *
 * Nothing is done behind the agent's back. The model creates the subscription
 * by running the `hercule` binary the runner put on the session's PATH, from a
 * bare process, with the token the runner injected; the emit uses a separate
 * credential over the same public API.
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
  runCli,
  completeSetup,
  PASSWORD,
  ROOT,
  startController,
  USERNAME,
  type Controller,
} from "../scripts/controller-process";
import {
  readApiKey,
  parseJsonOutputOrFail,
  isLiveSessionTestEnabled,
  LOGIN_DEADLINE_MS,
  isLoginAvailable,
  prepareLoggedInInstance,
  collectAssistantText,
  readSession,
  createTemporaryHome,
  readTranscript,
  waitForTranscriptTag,
  type Page,
  type Row,
  type Session,
  type TemporaryHome,
} from "./harness";

/** Opt-in: `pnpm test:binary` on any machine must not silently spend a subscription. */
const wanted = isLiveSessionTestEnabled();

let state: TemporaryHome;
const binary = join(ROOT, "hercule");

let controller: Controller;
let url: string;
let apiKey: string;

/** Long enough for a cold harness to start, subscribe and end its turn. */
const TURN_DEADLINE_MS = 240_000;

/** Long enough for one tick of the event pipeline, the delivery, and the woken turn. */
const WAKE_DEADLINE_MS = 240_000;

/** What the session waits for, and the event that arrives with it. */
const REF = "github:pr:o/r#87";
const KIND = "github.pr.merged";
const TITLE = "Close the lid when the run ends";
const PR_URL = "https://github.com/o/r/pull/87";
const PAYLOAD = JSON.stringify({
  subject: { repo: "o/r", number: 87, title: TITLE, url: PR_URL },
});

/**
 * The prompt spells out the command, because this case tests the wake-up, not
 * whether the model can find the command. What the model has to do on its own
 * is end the turn instead of waiting, which is the whole pattern.
 */
const PROMPT =
  "Using the hercule CLI on your PATH, run exactly this command: " +
  `hercule subscription create ${REF}\n` +
  "Report its output verbatim, then end your turn. Do not poll, do not sleep, " +
  "and do not run any other command.";

interface Profile {
  readonly id: string;
  readonly name: string;
}

/** Everything that has to exist before a session can be spawned. */
interface Ready {
  readonly profileId: string;
  readonly model: string | undefined;
}

let ready: Ready | undefined;

const prepare = async (): Promise<Ready> => {
  const { snapshot } = await prepareLoggedInInstance({ home: state.home, binary, url, apiKey });
  const profiles = parseJsonOutputOrFail<Page<Profile>>(
    await runCli(["profile", "list", "--json", "--all"], { home: state.home, binary }),
  ).items;
  // `worker` holds `subscription.write`, which is the grant the pattern needs.
  const worker = profiles.find((one) => one.name === "worker");
  expect(worker, "the shipped worker profile is not seeded").not.toBe(undefined);
  return {
    profileId: worker!.id,
    // The cheapest model that works, when this machine reported one.
    model: snapshot.models.find((one) => one.slug.includes("haiku"))?.slug,
  };
};

/** Waits until the session is idle, which means the turn has ended for good. */
const waitUntilIdle = async (id: string): Promise<void> => {
  const deadline = Date.now() + TURN_DEADLINE_MS;
  for (;;) {
    const session = await readSession({ home: state.home, binary, id });
    if (session.status === "idle") return;
    if (Date.now() > deadline) {
      throw new Error(`the session is ${session.status} rather than idle`);
    }
    await Bun.sleep(1_000);
  }
};

/** Counts the turns in the transcript; a wake-up adds one. */
const countTurns = (rows: ReadonlyArray<Row>): number =>
  rows.filter((row) => row.event._tag === "turn.started").length;

/** Waits until a turn after the first `before` turns has started, and returns the transcript. */
const waitForAnotherTurn = async (id: string, before: number): Promise<ReadonlyArray<Row>> => {
  const deadline = Date.now() + WAKE_DEADLINE_MS;
  for (;;) {
    const rows = await readTranscript({ home: state.home, binary, id });
    if (countTurns(rows) > before) return rows;
    if (Date.now() > deadline) {
      const session = await readSession({ home: state.home, binary, id });
      throw new Error(
        `no second turn within ${String(WAKE_DEADLINE_MS / 1000)}s: the session reads ` +
          `${session.status} and said:\n${collectAssistantText(rows)}`,
      );
    }
    await Bun.sleep(1_000);
  }
};

beforeAll(async () => {
  if (!wanted) return;
  state = createTemporaryHome();
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
    ["login", url, "--username", USERNAME, "--password-stdin", "--name", "e2e-subscription-wake"],
    { home: state.home, binary, stdin: PASSWORD },
  );
  expect(login.code, `${login.stdout}\n${login.stderr}`).toBe(0);
  apiKey = readApiKey(state.home);

  if (!isLoginAvailable()) return;
  ready = await prepare();
}, LOGIN_DEADLINE_MS * 2);

afterAll(async () => {
  await controller?.stop().catch(() => -1);
  // The copied credential is in here, so removing the home matters for
  // security, not just tidiness.
  state?.remove();
});

describe.skipIf(!wanted)("an event waking a session that subscribed to it", () => {
  it(
    "opens the session's next turn with the event it was waiting for",
    async (ctx) => {
      if (ready === undefined) {
        ctx.skip(
          "no login for the claude-code instance: name a credentials file in " +
            "HERCULE_E2E_CLAUDE_CREDENTIALS, or put ANTHROPIC_API_KEY on the environment.",
        );
        return;
      }

      const session = parseJsonOutputOrFail<Session>(
        await runCli(
          [
            "session",
            "spawn",
            "--profile",
            ready.profileId,
            ...(ready.model === undefined ? [] : ["--model", ready.model]),
            // The session runs unattended, and its one command would otherwise
            // wait for an approval nobody is there to give.
            "--access-mode",
            "full-access",
            "--json",
          ],
          { home: state.home, binary, stdin: PROMPT },
        ),
      );

      const first = await waitForTranscriptTag({
        home: state.home,
        binary,
        id: session.id,
        tag: "turn.completed",
        timeoutMs: TURN_DEADLINE_MS,
      });
      // The agent ended its turn rather than waiting, which is the pattern.
      await waitUntilIdle(session.id);
      const before = countTurns(first);

      // The user's own credential, from a terminal, with no session involved.
      const emitted = await runCli(
        ["event", "emit", "--kind", KIND, "--payload", PAYLOAD, "--ref", REF, "--json"],
        { home: state.home, binary },
      );
      expect(emitted.code, `${emitted.stdout}\n${emitted.stderr}`).toBe(0);

      const woken = await waitForAnotherTurn(session.id, before);

      // What the woken turn started with: the rendered event, with the kind,
      // what happened, and where a person opens it.
      const delivered = JSON.stringify(woken.slice(first.length));
      expect(
        delivered,
        `the woken turn did not carry the event:\n${collectAssistantText(woken)}`,
      ).toContain(KIND);
      expect(delivered).toContain(TITLE);
      expect(delivered).toContain(PR_URL);
    },
    LOGIN_DEADLINE_MS + TURN_DEADLINE_MS + WAKE_DEADLINE_MS + 120_000,
  );
});
