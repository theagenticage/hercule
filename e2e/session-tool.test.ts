/**
 * Tests Hercule as a tool for agents, end to end through the release binary.
 *
 * A Thread is spawned under the shipped `worker` profile with a prompt that
 * asks for three things: create a task, update it, delete it. The first two are
 * grants `worker` holds, the third is not. Afterwards the user - a separate
 * credential, over the same public API - checks that:
 *
 * - the task exists with the edited description;
 * - its provenance entry and its `task.created` event log row are both
 *   stamped `session:<id>`;
 * - the session got the error `missing grant task.delete` rather than
 *   silently getting its way.
 *
 * Nothing is done behind the agent's back: each of those three commands is the
 * `hercule` binary the runner put on the session's PATH, run by the model from
 * a bare process, with the token the runner injected.
 *
 * Opt-in, like `session.test.ts`: it spends the developer's tokens and takes a
 * couple of minutes. Set `HERCULE_LIVE_SESSION_TEST=1` to run it.
 *
 * The login it runs on is provided for the run by either of the two routes
 * `e2e/harness.ts` documents; with neither, the case is skipped with a
 * message.
 *
 * ## What this test does not assert
 *
 * That the session's token gets 401 after `hercule session stop`. The test
 * deliberately cannot get the token: it exists only in the `SessionStart`
 * frame and in the session process's environment, and the only thing that
 * could print it - the agent - must never be asked to. Revocation on exit is
 * tested instead where the token is available, in the controller's own
 * `withServer` test: `apps/controller/src/http/session-actor.integration.test.ts`.
 * What is checked here is the visible half: the session is `exited` after the
 * stop.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  readApiKey,
  runCli,
  completeSetup,
  listInstances,
  parseJsonOutputOrFail,
  lendCredential,
  LENT_CREDENTIALS,
  isLiveSessionTestEnabled,
  isLoginAvailable,
  PASSWORD,
  ROOT,
  collectAssistantText,
  readSession,
  startController,
  createTemporaryHome,
  waitForTranscriptTag,
  USERNAME,
  type Controller,
  type Instance,
  type Session,
  type Snapshot,
} from "./harness";

/** Opt-in: `pnpm test:binary` on any machine must not silently spend a subscription. */
const wanted = isLiveSessionTestEnabled();

const state = createTemporaryHome();
const binary = join(ROOT, "hercule");

let controller: Controller;
let url: string;
let apiKey: string;

/**
 * Generous on purpose: the agent reads its skill, asks the CLI for help twice
 * and then runs three commands, each a cold start of the binary.
 */
const TURN_DEADLINE_MS = 240_000;

/**
 * Long enough for the runner to probe a config directory it has just been
 * given a credential for. The first probe of a fresh directory has been seen
 * to return `unauthenticated`, so probes are repeated rather than trusted
 * once.
 */
const LOGIN_DEADLINE_MS = 120_000;

const TITLE = "P011 proof";
const MADE = "made by a session";
const UPDATED = "updated by a session";

/**
 * The prompt spells out the provenance ref because the field has a format
 * (`system:kind:id`) the model would otherwise have to discover through
 * errors. Giving the ref does not affect what is tested: who the entry is
 * stamped with.
 */
const PROMPT =
  "Using the hercule CLI (run `hercule --help` first if needed): create a task titled " +
  `"${TITLE}" with description "${MADE}" and provenance {"ref":"hercule:proof:p011"}, then ` +
  `update its description to "${UPDATED}", then try to delete it. Report each command's ` +
  "output verbatim.";

interface Page<A> {
  readonly items: ReadonlyArray<A>;
}

/**
 * Waits for the controller's own runner to enrol and connect, and returns it.
 * On the way, the runner writes `runner.json` and its storage directory, which
 * the login is copied into, so nothing may read either before this returns.
 */
const waitForOwnRunner = async (): Promise<string> => {
  const deadline = Date.now() + LOGIN_DEADLINE_MS;
  for (;;) {
    const ran = await runCli(["runner", "list", "--json"], { home: state.home, binary });
    const id =
      ran.code === 0
        ? parseJsonOutputOrFail<Page<{ readonly id: string }>>(ran).items[0]?.id
        : undefined;
    if (id !== undefined && existsSync(join(state.home, "runner", "runner.json"))) return id;
    if (Date.now() > deadline)
      throw new Error(`no runner connected to the controller:\n${ran.stdout}`);
    await Bun.sleep(500);
  }
};

const findClaudeInstance = async (): Promise<Instance> => {
  const found = (await listInstances({ url, apiKey })).find(
    (one) => one.providerId === "claude-code",
  );
  if (found === undefined) throw new Error("no claude-code Provider Instance was seeded");
  return found;
};

/**
 * Probes the instance until a machine reports that the copied login works, and
 * returns that snapshot. The probe is repeated rather than trusted once: a
 * probe of a directory that was empty a moment ago has been seen to return
 * `unauthenticated`.
 */
const waitForLoggedInSnapshot = async (runnerId: string, instanceId: string): Promise<Snapshot> => {
  const deadline = Date.now() + LOGIN_DEADLINE_MS;
  let last: string;
  for (;;) {
    const ran = await runCli(["runner", "probe", runnerId, "--instance", instanceId, "--json"], {
      home: state.home,
      binary,
    });
    if (ran.code === 0) {
      const snapshot = parseJsonOutputOrFail<Snapshot>(ran);
      if (snapshot.auth.status === "ok") return snapshot;
      last = `${snapshot.auth.status}: ${snapshot.auth.message ?? "no message"}`;
    } else {
      last = `${ran.stdout}\n${ran.stderr}`;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `the lent login never probed ok within ${String(LOGIN_DEADLINE_MS / 1000)}s: ${last}`,
      );
    }
    await Bun.sleep(2_000);
  }
};

interface Provenance {
  readonly ref?: string;
  readonly actor: string;
}

interface Task {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly provenance: ReadonlyArray<Provenance>;
}

interface Event {
  readonly kind: string;
  readonly actor: string;
}

interface Profile {
  readonly id: string;
  readonly name: string;
}

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
    ["login", url, "--username", USERNAME, "--password-stdin", "--name", "e2e-session-tool"],
    { home: state.home, binary, stdin: PASSWORD },
  );
  expect(login.code, `${login.stdout}\n${login.stderr}`).toBe(0);
  apiKey = readApiKey(state.home);
}, 120_000);

afterAll(async () => {
  await controller?.stop().catch(() => -1);
  // The copied credential is in here, so removing the home matters for security, not just tidiness.
  state.remove();
});

describe.skipIf(!wanted)("an agent reaching Hercule from inside a session", () => {
  it(
    "creates and updates a task as itself, and is not allowed the delete its profile does not grant",
    async (ctx) => {
      if (!isLoginAvailable()) {
        ctx.skip(
          "no login for the claude-code instance: name a credentials file in " +
            "HERCULE_E2E_CLAUDE_CREDENTIALS, or put ANTHROPIC_API_KEY on the environment.",
        );
        return;
      }

      const runnerId = await waitForOwnRunner();
      const instance = await findClaudeInstance();
      if (LENT_CREDENTIALS !== undefined) lendCredential(state.home, instance.id);
      const snapshot = await waitForLoggedInSnapshot(runnerId, instance.id);

      // The cheapest model that works, when this machine reported one.
      const haiku = snapshot.models.find((model) => model.slug.includes("haiku"))?.slug;

      const worker = parseJsonOutputOrFail<Page<Profile>>(
        await runCli(["profile", "list", "--json", "--all"], { home: state.home, binary }),
      ).items.find((profile) => profile.name === "worker");
      expect(worker, "the shipped worker profile is not seeded").not.toBe(undefined);

      const session = parseJsonOutputOrFail<Session>(
        await runCli(
          [
            "session",
            "spawn",
            "--profile",
            worker!.id,
            ...(haiku === undefined ? [] : ["--model", haiku]),
            // The session runs unattended, and each of its three commands would
            // otherwise wait for an approval nobody is there to give.
            "--access-mode",
            "full-access",
            "--json",
          ],
          { home: state.home, binary, stdin: PROMPT },
        ),
      );
      expect(session.permissionProfileId).toBe(worker!.id);

      const rows = await waitForTranscriptTag({
        home: state.home,
        binary,
        id: session.id,
        tag: "turn.completed",
        timeoutMs: TURN_DEADLINE_MS,
      });

      const actor = `session:${session.id}`;

      // The task the agent made, read back by the user over the same API.
      const tasks = parseJsonOutputOrFail<Page<Task>>(
        await runCli(["task", "list", "--json", "--all"], { home: state.home, binary }),
      ).items;
      const mine = tasks.find((task) => task.title === TITLE);
      // Read after the turn, so a task found here is one the rejected delete
      // did not remove.
      expect(
        mine,
        `no task titled ${TITLE}. What the session said was:\n${collectAssistantText(rows)}`,
      ).not.toBe(undefined);
      // The update changed the task the create made, not a second one.
      expect(mine!.description).toBe(UPDATED);
      expect(mine!.provenance.map((entry) => entry.actor)).toContain(actor);

      // The event log records the same actor.
      const created = parseJsonOutputOrFail<Page<Event>>(
        await runCli(["event", "list", "--kind", "task.created", "--json", "--all"], {
          home: state.home,
          binary,
        }),
      ).items;
      expect(created.length).toBeGreaterThan(0);
      expect(created.map((event) => event.actor)).toContain(actor);

      // The delete was rejected, and the error named the missing grant rather
      // than failing without a reason.
      const said = collectAssistantText(rows);
      expect(said, `the session never reported a rejected delete. It said:\n${said}`).toContain(
        "missing grant task.delete",
      );
      const stopped = parseJsonOutputOrFail<Session>(
        await runCli(["session", "stop", session.id, "--json"], { home: state.home, binary }),
      );
      expect(stopped.id).toBe(session.id);
      // The stop is a request to the runner, so the row becomes `exited` when
      // the machine reports that the process ended, not when the command
      // returns.
      const deadline = Date.now() + 60_000;
      let after = await readSession({ home: state.home, binary, id: session.id });
      while (after.status !== "exited" && Date.now() < deadline) {
        await Bun.sleep(500);
        after = await readSession({ home: state.home, binary, id: session.id });
      }
      expect(after.status).toBe("exited");
    },
    LOGIN_DEADLINE_MS + TURN_DEADLINE_MS + 120_000,
  );
});
