/**
 * AC-10: hydra-as-a-tool, proved end to end through the release binary.
 *
 * A Thread is spawned under the shipped `worker` profile with a prompt that
 * asks for three things: create a task, update it, delete it. The first two are
 * grants `worker` holds, the third is not. Afterwards the user - a separate
 * credential, over the same public API - reads back that the task exists with
 * the edited description, that its provenance entry and its `task.created`
 * event log row are both stamped `session:<id>`, and that the session was told
 * `missing grant task.delete` rather than quietly getting its way.
 *
 * Nothing here is arranged behind the agent's back: every one of those three
 * commands is the `hydra` binary the runner put on the session's PATH, called
 * by the model out of a bare process, against the token the runner injected.
 *
 * Opt-in, like `session.test.ts` beside it: it spends the developer's tokens
 * and takes a couple of minutes. `HYDRA_LIVE_SESSION_TEST=1` asks for it.
 *
 * ## The login (decision D-3)
 *
 * A session runs against the Provider Instance's own `CLAUDE_CONFIG_DIR` under
 * the runner's storage (spec 06 section 4.2), which in a throwaway Hydra Home
 * is empty, so nothing could start. The developer's own login is lent to it for
 * the run: on macOS the Claude CLI keeps it as a Keychain item and reads
 * `.credentials.json` in the config directory when the Keychain has none, so
 * the item is copied into the throwaway instance directory and the instance is
 * re-probed. The whole home, credential included, is deleted when the suite
 * ends. Without the Keychain item the case skips saying so.
 *
 * ## What this test does not assert
 *
 * That the session's token is 401 after `hydra session stop`. The token is
 * deliberately unreachable from out here: it exists in the `SessionStart` frame
 * and in the session process's environment, and the one thing that could print
 * it - the agent - must never be asked to. Revocation on exit is proved instead
 * where the token is in hand, by the controller's own `withServer` test (slice
 * 1, `apps/controller/src/http/session-actor.integration.test.ts`, "dies with
 * the session the machine reports has exited"). What is asserted here is the
 * observable half: the session reads `exited` after the stop.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PASSWORD,
  ROOT,
  USERNAME,
  apiKeyIn,
  cli,
  completeSetup,
  instancesOf,
  jsonOk,
  saidIn,
  sessionOf,
  startController,
  temporaryHome,
  untilTag,
  type Controller,
  type Instance,
  type Session,
  type Snapshot,
} from "./harness";

/** Opt-in: `pnpm test:binary` on any machine must not quietly spend a subscription. */
const wanted = process.env["HYDRA_LIVE_SESSION_TEST"] !== undefined;

const state = temporaryHome();
const binary = join(ROOT, "hydra");

let controller: Controller;
let url: string;
let apiKey: string;

/**
 * Generous on purpose: the agent reads its skill, asks the CLI for help twice
 * and then runs three commands, each a cold start of the binary.
 */
const TURN_DEADLINE_MS = 240_000;

/**
 * Long enough for the runner to answer a probe of a config directory it has
 * just been handed a credential for. The first probe of a fresh directory has
 * been seen to answer `unauthenticated`, so probes are repeated rather than
 * believed once.
 */
const LOGIN_DEADLINE_MS = 120_000;

const TITLE = "P011 proof";
const MADE = "made by a session";
const UPDATED = "updated by a session";

/**
 * The provenance ref is spelled out because the field has a grammar
 * (`system:kind:id`) the model would otherwise have to discover by being
 * refused. Everything the criterion is about - who the entry is stamped for -
 * is untouched by naming it.
 */
const PROMPT =
  "Using the hydra CLI (run `hydra --help` first if needed): create a task titled " +
  `"${TITLE}" with description "${MADE}" and provenance {"ref":"hydra:proof:p011"}, then ` +
  `update its description to "${UPDATED}", then try to delete it. Report each command's ` +
  "output verbatim.";

/**
 * The developer's own Claude Code login as the CLI stores it on macOS, or
 * `undefined` on a machine that has none.
 */
const keychainLogin = (): string | undefined => {
  const ran = Bun.spawnSync(
    ["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"],
    {
      stdout: "pipe",
      stderr: "ignore",
    },
  );
  if (ran.exitCode !== 0) return undefined;
  const text = new TextDecoder().decode(ran.stdout).trim();
  return text === "" ? undefined : text;
};

/**
 * `<home>/runner/<storage>/providers/<instanceId>`: the instance's private
 * config directory, named by the storage directory this runner's identity owns.
 */
const instanceDir = (instanceId: string): string => {
  const file = JSON.parse(readFileSync(join(state.home, "runner", "runner.json"), "utf8")) as {
    readonly storageDirectory: string;
  };
  return join(state.home, "runner", file.storageDirectory, "providers", instanceId);
};

/** Lends the login to the throwaway instance (D-3). */
const lend = (instanceId: string, credential: string): void => {
  const dir = instanceDir(instanceId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, ".credentials.json");
  writeFileSync(path, credential, { mode: 0o600 });
  chmodSync(path, 0o600);
};

interface Page<A> {
  readonly items: ReadonlyArray<A>;
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
 * Probes the instance until a machine says the lent login works, and answers
 * with that snapshot. Repeated rather than trusted once: a probe of a directory
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

  const login = await cli(
    ["login", url, "--username", USERNAME, "--password-stdin", "--name", "e2e-session-tool"],
    { home: state.home, binary, stdin: PASSWORD },
  );
  expect(login.code, `${login.stdout}\n${login.stderr}`).toBe(0);
  apiKey = apiKeyIn(state.home);
}, 120_000);

afterAll(async () => {
  await controller?.stop().catch(() => -1);
  // The lent credential lives in here, so this is not housekeeping.
  state.remove();
});

describe.skipIf(!wanted)("an agent reaching Hydra from inside a session", () => {
  it(
    "creates and updates a task as itself, is refused the delete its profile withholds",
    async (ctx) => {
      const credential = keychainLogin();
      if (credential === undefined) {
        ctx.skip(
          'no "Claude Code-credentials" Keychain item on this machine. A session runs against ' +
            "the Provider Instance's own CLAUDE_CONFIG_DIR, which is empty in a throwaway " +
            "home, so this test lends the developer's own login to it for the run (D-3).",
        );
        return;
      }

      const runnerId = await enrolledRunner();
      const instance = await claudeInstance();
      lend(instance.id, credential);
      const snapshot = await probedLoggedIn(runnerId, instance.id);

      // The cheapest model that answers, when this machine reported one.
      const haiku = snapshot.models.find((model) => model.slug.includes("haiku"))?.slug;

      const worker = jsonOk<Page<Profile>>(
        await cli(["profile", "list", "--json", "--all"], { home: state.home, binary }),
      ).items.find((profile) => profile.name === "worker");
      expect(worker, "the shipped worker profile is not seeded").not.toBe(undefined);

      const session = jsonOk<Session>(
        await cli(
          [
            "session",
            "spawn",
            "--profile",
            worker!.id,
            ...(haiku === undefined ? [] : ["--model", haiku]),
            // The session runs unattended, and every one of its three commands
            // is a command approval nobody is there to answer.
            "--access-mode",
            "full-access",
            "--json",
          ],
          { home: state.home, binary, stdin: PROMPT },
        ),
      );
      expect(session.permissionProfileId).toBe(worker!.id);

      const rows = await untilTag({
        home: state.home,
        binary,
        id: session.id,
        tag: "turn.completed",
        timeoutMs: TURN_DEADLINE_MS,
      });

      const actor = `session:${session.id}`;

      // The task the agent made, read back by the user over the same API.
      const tasks = jsonOk<Page<Task>>(
        await cli(["task", "list", "--json", "--all"], { home: state.home, binary }),
      ).items;
      const mine = tasks.find((task) => task.title === TITLE);
      // Read after the turn, so a task that is here is a task the refused
      // delete did not take away.
      expect(mine, `no task titled ${TITLE}. What the session said was:\n${saidIn(rows)}`).not.toBe(
        undefined,
      );
      // The update landed on the task the create made, not on a second one.
      expect(mine!.description).toBe(UPDATED);
      expect(mine!.provenance.map((entry) => entry.actor)).toContain(actor);

      // The event log says the same thing about who did it.
      const created = jsonOk<Page<Event>>(
        await cli(["event", "list", "--kind", "task.created", "--json", "--all"], {
          home: state.home,
          binary,
        }),
      ).items;
      expect(created.length).toBeGreaterThan(0);
      expect(created.map((event) => event.actor)).toContain(actor);

      // The delete was refused, and the refusal named the grant to ask for
      // rather than failing anonymously.
      const said = saidIn(rows);
      expect(said, `the session never reported a refused delete. It said:\n${said}`).toContain(
        "missing grant task.delete",
      );
      const stopped = jsonOk<Session>(
        await cli(["session", "stop", session.id, "--json"], { home: state.home, binary }),
      );
      expect(stopped.id).toBe(session.id);
      // The stop is a request to the runner, so the row reaches `exited` when
      // the machine says the process went away, not when the command returns.
      const deadline = Date.now() + 60_000;
      let after = await sessionOf({ home: state.home, binary, id: session.id });
      while (after.status !== "exited" && Date.now() < deadline) {
        await Bun.sleep(500);
        after = await sessionOf({ home: state.home, binary, id: session.id });
      }
      expect(after.status).toBe("exited");
    },
    LOGIN_DEADLINE_MS + TURN_DEADLINE_MS + 120_000,
  );
});
