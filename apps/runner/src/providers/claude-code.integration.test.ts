/**
 * Proves the vendor SDK still hands back the shapes the stubbed tests beside
 * this one assume.
 *
 * The probe runs against a temporary config directory and never touches the
 * developer's own `~/.claude`. The session cannot: a login lives in the config
 * directory and nowhere else, and on macOS it is a Keychain item keyed by that
 * directory, so it cannot be copied into a temporary one. That test therefore
 * uses the developer's own login, spends a few tokens of it, and is opt-in.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Duration, Effect, Stream } from "effect";
import type { ProviderEvent, SessionSpec } from "@hydra/protocol";
import { PROBE_DEADLINE, claudeCode } from "./claude-code";
import type { ProviderRunnerContext } from "./index";

const binary = Bun.which("claude") ?? undefined;

const homes: Array<string> = [];

afterAll(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const emptyHome = (): string => {
  const home = mkdtempSync(join(tmpdir(), "hydra-claude-probe-"));
  homes.push(home);
  return home;
};

const installedVersion = async (path: string): Promise<string> => {
  const child = Bun.spawn([path, "--version"], { stdout: "pipe", stderr: "ignore" });
  const printed = await new Response(child.stdout).text();
  await child.exited;
  expect(child.exitCode, printed).toBe(0);
  return /\d+\.\d+\.\d+\S*/.exec(printed)?.[0] ?? printed.trim();
};

describe.skipIf(binary === undefined)("the real Claude adapter on this machine", () => {
  it("reports an empty config directory as not logged in, with the machine's version and models", async () => {
    const context: ProviderRunnerContext = {
      cwd: null,
      home: emptyHome(),
      binary: binary!,
      env: { PATH: process.env["PATH"] ?? "" },
    };

    const started = Date.now();
    const probed = await Effect.runPromise(claudeCode.probe(context, {}));
    const took = Date.now() - started;

    // Not `error`: an empty config dir is a machine nobody has logged in on,
    // and telling that apart from a broken harness is the whole point.
    expect(probed.auth.status, probed.auth.message ?? "").toBe("unauthenticated");
    expect(probed.auth.identity).toBeUndefined();
    expect(probed.harnessVersion).toBe(await installedVersion(binary!));
    // The catalogue is probed, never authored: an empty one would leave the
    // composer with nothing to offer on a perfectly good machine.
    expect(probed.models.length).toBeGreaterThan(0);
    for (const model of probed.models) expect(model.slug).not.toBe("");

    expect(took).toBeLessThan(Duration.toMillis(PROBE_DEADLINE));
  });
});

/**
 * The config directory the session runs against. Everything else about it stays
 * isolated: a throwaway cwd, no setting sources, no auto memory.
 */
const CONFIG_DIR = process.env["CLAUDE_CONFIG_DIR"] ?? join(homedir(), ".claude");

/**
 * Opt-in, because the alternative is that `pnpm test` on any developer's
 * machine quietly spends their subscription and takes a minute doing it.
 */
const wanted = process.env["HYDRA_LIVE_SESSION_TEST"] !== undefined;

const SESSION = "0199e0e7-0000-7000-8000-0000000000ff";

const SPEC: SessionSpec = {
  instanceId: "0199e0e7-0000-7000-8000-00000000000a",
  workspaceId: null,
  // The cheapest model that answers, and no tools: this test is about the
  // session's shape on the wire, not about what the model can do.
  modelSelection: { model: "claude-haiku-4-5", options: {} },
  accessMode: "approval-required",
};

/** Long enough for a cold CLI to start, connect and answer one short prompt. */
const TURN_DEADLINE = Duration.seconds(90);

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

/**
 * Whether this machine can run a session at all, asked the way the runner asks
 * it: the adapter's own probe against the very config directory the session
 * will use. `claude auth status --json` is not the check - with
 * `CLAUDE_CONFIG_DIR` set explicitly, even to the directory it already
 * defaults to, it answers about a different credential than the session gets.
 */
const authed =
  binary === undefined || !wanted
    ? false
    : (
        await Effect.runPromise(
          claudeCode.probe({ cwd: null, home: CONFIG_DIR, binary, env: process.env }, {}),
        )
      ).auth.status === "ok";

describe.skipIf(!authed)("a real Claude Code session on this machine", () => {
  it(
    "starts, answers one prompt inside a bracketed turn, and exits when stopped",
    async () => {
      const seen: Array<ProviderEvent> = [];
      Effect.runFork(
        Stream.runForEach(claudeCode.events, (event) => Effect.sync(() => void seen.push(event))),
      );

      const context: ProviderRunnerContext = {
        cwd: emptyHome(),
        home: CONFIG_DIR,
        binary: binary!,
        env: {
          PATH: process.env["PATH"] ?? "",
          HOME: homedir(),
          // The other route to an authenticated session, and the one that
          // works anywhere: an API key on the instance's environment.
          ...(process.env["ANTHROPIC_API_KEY"] === undefined
            ? {}
            : { ANTHROPIC_API_KEY: process.env["ANTHROPIC_API_KEY"] }),
        },
      };

      const binding = await Effect.runPromise(claudeCode.startSession(SESSION, SPEC, context));
      expect(binding.sessionId).toBe(SESSION);
      // The two ids are separate concepts, joined only by this binding.
      expect(binding.nativeSessionId).not.toBe(SESSION);

      await Effect.runPromise(
        claudeCode.sendInput(SESSION, {
          text: "Reply with the single word ready. Use no tools.",
        }),
      );

      await until(seen, "turn.completed");

      const tags = seen.map((event) => event._tag);
      expect(tags[0]).toBe("session.started");
      expect(tags.indexOf("turn.started")).toBeLessThan(tags.indexOf("turn.completed"));
      const done = seen.find((event) => event._tag === "turn.completed");
      expect(
        done?._tag === "turn.completed" ? done.state : undefined,
        done?._tag === "turn.completed" ? (done.error ?? "") : "",
      ).toBe("completed");
      // The answer arrived as deltas, not as one lump at the end.
      expect(tags).toContain("content.delta");
      expect(tags).toContain("session.usage.updated");

      await Effect.runPromise(claudeCode.stopSession(SESSION));
      await until(seen, "session.exited");
      const exited = seen.find((event) => event._tag === "session.exited");
      expect(exited?._tag === "session.exited" ? exited.reason : undefined).toBe("stopped");
      expect(await Effect.runPromise(claudeCode.listSessions)).toEqual([]);
    },
    Duration.toMillis(TURN_DEADLINE) * 2,
  );
});
