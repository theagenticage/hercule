/**
 * The long-wait pattern, end to end, out of the release binary: a real session
 * subscribes to an External Ref and ends its turn, a person emits an event
 * carrying that ref from a terminal, and the session's next turn opens with the
 * rendered event.
 *
 * Nothing is arranged behind the agent's back. The subscription is created by
 * the `hercule` binary the runner put on the session's PATH, called by the
 * model out of a bare process against the token the runner injected; the emit
 * is a separate credential over the same public API.
 *
 * Opt-in, like `session.test.ts` beside it: it spends the developer's tokens
 * and takes a couple of minutes. `HERCULE_LIVE_SESSION_TEST=1` asks for it.
 *
 * The login it runs on is lent for the run, by either of the two routes
 * `e2e/harness.ts` documents; with neither the case skips saying so.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  apiKeyIn,
  cli,
  completeSetup,
  instancesOf,
  jsonOk,
  lendCredential,
  LENT_CREDENTIALS,
  liveSessionsAsked,
  loginLent,
  PASSWORD,
  ROOT,
  saidIn,
  sessionOf,
  startController,
  temporaryHome,
  transcriptOf,
  untilTag,
  USERNAME,
  type Controller,
  type Instance,
  type Row,
  type Session,
  type Snapshot,
} from "./harness";

/** Opt-in: `pnpm test:binary` on any machine must not quietly spend a subscription. */
const wanted = liveSessionsAsked();

const state = temporaryHome();
const binary = join(ROOT, "hercule");

let controller: Controller;
let url: string;
let apiKey: string;

/** Long enough for a cold harness to start, subscribe and end its turn. */
const TURN_DEADLINE_MS = 240_000;

/** Long enough for the runner to enrol and to probe a directory it was just handed. */
const LOGIN_DEADLINE_MS = 120_000;

/** Long enough for one matcher tick, the delivery, and the woken turn. */
const WAKE_DEADLINE_MS = 240_000;

/** What the session waits for, and the event that arrives carrying it. */
const REF = "github:pr:o/r#87";
const KIND = "github.pr.merged";
const TITLE = "P019 proof: the lid closes";
const PR_URL = "https://github.com/o/r/pull/87";
const PAYLOAD = JSON.stringify({
  subject: { repo: "o/r", number: 87, title: TITLE, url: PR_URL },
});

/**
 * The command is spelled out because the point of the case is the wake-up, not
 * whether the model can find the command; what it does on its own is end the
 * turn instead of waiting, which is the whole pattern.
 */
const PROMPT =
  "Using the hercule CLI on your PATH, run exactly this command: " +
  `hercule subscription create ${REF}\n` +
  "Report its output verbatim, then end your turn. Do not poll, do not sleep, " +
  "and do not run any other command.";

interface Page<A> {
  readonly items: ReadonlyArray<A>;
}

interface Profile {
  readonly id: string;
  readonly name: string;
}

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

/** Everything that has to exist before a session can be spawned. */
interface Ready {
  readonly profileId: string;
  readonly model: string | undefined;
}

let ready: Ready | undefined;

const prepare = async (): Promise<Ready> => {
  const runnerId = await enrolledRunner();
  const instance = await claudeInstance();
  if (LENT_CREDENTIALS !== undefined) lendCredential(state.home, instance.id);
  const snapshot = await probedLoggedIn(runnerId, instance.id);
  const profiles = jsonOk<Page<Profile>>(
    await cli(["profile", "list", "--json", "--all"], { home: state.home, binary }),
  ).items;
  // `worker` holds `subscription.write`, which is the grant the pattern needs.
  const worker = profiles.find((one) => one.name === "worker");
  expect(worker, "the shipped worker profile is not seeded").not.toBe(undefined);
  return {
    profileId: worker!.id,
    // The cheapest model that answers, when this machine reported one.
    model: snapshot.models.find((one) => one.slug.includes("haiku"))?.slug,
  };
};

/** Waits until the session is idle, which is the turn ending for good. */
const untilIdle = async (id: string): Promise<void> => {
  const deadline = Date.now() + TURN_DEADLINE_MS;
  for (;;) {
    const session = await sessionOf({ home: state.home, binary, id });
    if (session.status === "idle") return;
    if (Date.now() > deadline) {
      throw new Error(`the session read ${session.status} rather than idle`);
    }
    await Bun.sleep(1_000);
  }
};

/** How many turns the transcript holds, which is what a wake-up adds one to. */
const turnsIn = (rows: ReadonlyArray<Row>): number =>
  rows.filter((row) => row.event._tag === "turn.started").length;

/** The transcript once a turn after `before` has started. */
const untilAnotherTurn = async (id: string, before: number): Promise<ReadonlyArray<Row>> => {
  const deadline = Date.now() + WAKE_DEADLINE_MS;
  for (;;) {
    const rows = await transcriptOf({ home: state.home, binary, id });
    if (turnsIn(rows) > before) return rows;
    if (Date.now() > deadline) {
      const session = await sessionOf({ home: state.home, binary, id });
      throw new Error(
        `no second turn within ${String(WAKE_DEADLINE_MS / 1000)}s: the session reads ` +
          `${session.status} and said:\n${saidIn(rows)}`,
      );
    }
    await Bun.sleep(1_000);
  }
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
    ["login", url, "--username", USERNAME, "--password-stdin", "--name", "e2e-subscription-wake"],
    { home: state.home, binary, stdin: PASSWORD },
  );
  expect(login.code, `${login.stdout}\n${login.stderr}`).toBe(0);
  apiKey = apiKeyIn(state.home);

  if (!loginLent()) return;
  ready = await prepare();
}, LOGIN_DEADLINE_MS * 2);

afterAll(async () => {
  await controller?.stop().catch(() => -1);
  // The lent credential lives in here, so this is not housekeeping.
  state.remove();
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

      const session = jsonOk<Session>(
        await cli(
          [
            "session",
            "spawn",
            "--profile",
            ready.profileId,
            ...(ready.model === undefined ? [] : ["--model", ready.model]),
            // The session runs unattended, and its one command is an approval
            // nobody is there to answer.
            "--access-mode",
            "full-access",
            "--json",
          ],
          { home: state.home, binary, stdin: PROMPT },
        ),
      );

      const first = await untilTag({
        home: state.home,
        binary,
        id: session.id,
        tag: "turn.completed",
        timeoutMs: TURN_DEADLINE_MS,
      });
      // The agent ended its turn rather than waiting, which is the pattern.
      await untilIdle(session.id);
      const before = turnsIn(first);

      // The user's own credential, from a terminal, with no session involved.
      const emitted = await cli(
        ["event", "emit", "--kind", KIND, "--payload", PAYLOAD, "--ref", REF, "--json"],
        { home: state.home, binary },
      );
      expect(emitted.code, `${emitted.stdout}\n${emitted.stderr}`).toBe(0);

      const woken = await untilAnotherTurn(session.id, before);

      // What the woken turn was opened with: the rendered event, carrying the
      // kind, what happened, and where a person opens it.
      const delivered = JSON.stringify(woken.slice(first.length));
      expect(delivered, `the woken turn did not carry the event:\n${saidIn(woken)}`).toContain(
        KIND,
      );
      expect(delivered).toContain(TITLE);
      expect(delivered).toContain(PR_URL);
    },
    LOGIN_DEADLINE_MS + TURN_DEADLINE_MS + WAKE_DEADLINE_MS + 120_000,
  );
});
