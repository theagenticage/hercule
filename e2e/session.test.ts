/**
 * Tests one real Claude Code session through the release binary: spawned by
 * the CLI, hosted by the runner the controller starts for itself, and read
 * back as a transcript.
 *
 * Opt-in, for the same reason as the adapter's own live test: it spends the
 * developer's tokens and takes a minute. Set `HERCULE_LIVE_SESSION_TEST=1` to
 * run it.
 *
 * A session runs against the instance's own `CLAUDE_CONFIG_DIR` under the
 * runner's storage (spec 06 section 4.2), which in a throwaway Hercule Home is
 * empty. The developer's own `~/.claude` login cannot be copied into it - on
 * macOS it is a Keychain item keyed by that directory - so this test needs
 * `ANTHROPIC_API_KEY` in the environment. Without a logged-in instance, the
 * case is skipped with a message stating which of the two is missing.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PASSWORD,
  ROOT,
  USERNAME,
  runCli,
  completeSetup,
  startController,
  type Controller,
} from "../scripts/controller-process";
import {
  readApiKey,
  listInstances,
  parseJsonOutputOrFail,
  isLiveSessionTestEnabled,
  readSession,
  createTemporaryHome,
  waitForTranscriptTag,
  type Instance,
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

/** Long enough for a cold harness to start, connect and reply to one short prompt. */
const TURN_DEADLINE_MS = 120_000;

/** Long enough for a machine to probe the instance and report that it is logged in. */
const LOGIN_DEADLINE_MS = 60_000;

/**
 * Waits for a machine to probe the Claude instance, and returns it. Returns
 * `undefined` if no machine reported a usable login for it in time.
 */
const waitForLoggedInInstance = async (): Promise<Instance | undefined> => {
  const deadline = Date.now() + LOGIN_DEADLINE_MS;
  for (;;) {
    const claude = (await listInstances({ url, apiKey })).find(
      (one) => one.providerId === "claude-code",
    );
    if (claude?.snapshots.some((snapshot) => snapshot.auth.status === "ok") === true) return claude;
    if (Date.now() > deadline) return undefined;
    await Bun.sleep(500);
  }
};

const read = (id: string): Promise<Session> => readSession({ home: state.home, binary, id });

const waitForTag = (id: string, tag: string) =>
  waitForTranscriptTag({ home: state.home, binary, id, tag, timeoutMs: TURN_DEADLINE_MS });

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
    ["login", url, "--username", USERNAME, "--password-stdin", "--name", "e2e-session"],
    { home: state.home, binary, stdin: PASSWORD },
  );
  expect(login.code, `${login.stdout}\n${login.stderr}`).toBe(0);
  apiKey = readApiKey(state.home);
}, 120_000);

afterAll(async () => {
  await controller?.stop().catch(() => -1);
  state?.remove();
});

describe.skipIf(!wanted)("a real Claude Code session through the binary", () => {
  it(
    "spawns a workspace-less thread, answers one prompt, and reads back as a bracketed turn",
    async (ctx) => {
      const instance = await waitForLoggedInInstance();
      if (instance === undefined) {
        ctx.skip(
          "no machine reports a logged-in claude-code instance. A session runs against the " +
            "instance's own CLAUDE_CONFIG_DIR, which is empty in a throwaway home, so this " +
            "test needs ANTHROPIC_API_KEY on the environment.",
        );
        return;
      }

      // The cheapest model that works, when this machine reported one.
      const slugs = instance.snapshots.flatMap((snapshot) =>
        snapshot.models.map((model) => model.slug),
      );
      const haiku = slugs.find((slug) => slug.includes("haiku"));

      const ran = await runCli(
        ["session", "spawn", ...(haiku === undefined ? [] : ["--model", haiku]), "--json"],
        { home: state.home, binary, stdin: "Reply with the single word ready. Use no tools." },
      );
      const session = parseJsonOutputOrFail<Session>(ran);
      expect(session.status).toBe("starting");

      const rows = await waitForTag(session.id, "turn.completed");

      // The turn has a start and a completion: a completion the controller
      // could not pair with a start would not be a turn at all.
      const started = rows.findIndex((row) => row.event._tag === "turn.started");
      const completed = rows.findIndex((row) => row.event._tag === "turn.completed");
      expect(started, rows.map((row) => row.event._tag).join(", ")).toBeGreaterThanOrEqual(0);
      expect(started).toBeLessThan(completed);
      expect(rows[0]!.event._tag).toBe("session.started");
      expect(rows.map((row) => row.position)).toEqual(rows.map((_, index) => index + 1));
      // The reply is in the store as coalesced text, never as one row per token.
      expect(rows.map((row) => row.event._tag)).toContain("content.delta");
      expect(rows.find((row) => row.event._tag === "turn.completed")!.event["state"]).toBe(
        "completed",
      );

      // The turn is over, so the session is idle again and the record holds
      // the binding the harness started with.
      const after = await read(session.id);
      expect(after.status).toBe("idle");
      expect(after.nativeSessionId).not.toBeNull();
    },
    // The timeout covers the wait for a logged-in instance, the wait for the
    // turn, and the CLI calls between them: a timeout that only covers the
    // longest wait leaves no time for the others.
    LOGIN_DEADLINE_MS + TURN_DEADLINE_MS + 60_000,
  );

  it(
    "teaches the command that reads the session back",
    async (ctx) => {
      if ((await waitForLoggedInInstance()) === undefined) {
        ctx.skip("no machine reports a logged-in claude-code instance");
        return;
      }

      const ran = await runCli(["session", "spawn"], {
        home: state.home,
        binary,
        stdin: "Reply with the single word ready. Use no tools.",
      });

      expect(ran.code, `${ran.stdout}\n${ran.stderr}`).toBe(0);
      expect(ran.stdout).toContain("hercule transcript read");
      // The timeout covers the wait for a logged-in instance plus the spawn
      // after it: a timeout that only covers the first wait leaves no time for
      // what the case actually tests.
    },
    LOGIN_DEADLINE_MS + 30_000,
  );
});
