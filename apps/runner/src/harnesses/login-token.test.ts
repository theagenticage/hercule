/**
 * Tests making a subscription token with `claude setup-token`. The real
 * command is replaced by a script that draws what the real one draws in a
 * terminal (recorded from Claude Code 2.1.314): cursor moves instead of
 * spaces, the URL in a hyperlink, a refused code that leaves the command
 * waiting, and a token repainted cell by cell. The runner starts it in a real
 * pseudo-terminal, so the whole path from the terminal to the result is
 * exercised.
 *
 * The token in these tests is made up.
 */
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Duration, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { claudeCode } from "./claude-code";
import { codex } from "./codex/adapter";
import type { HarnessAdapter, HarnessRunnerContext } from "./index";
import { LOGIN_IDLE, makeLogins, type LoginCommand } from "./login";
import { spawnLogin } from "./process";
import { NO_CONTROLLER_UPLOADER } from "./testing";

const ACCOUNT_ID = "0199e0e7-0000-7000-8000-00000000000b";
const REQUEST = "0199e0e7-0000-7000-8000-0000000000b1";

const URL = "https://claude.com/cai/oauth/authorize?code=true&client_id=abc&state=s-t_1";
const TOKEN = "sk-ant-oat01-Abc123_-xyz789Q";

/**
 * Stands in for `claude`. The first argument must be `setup-token`. What it
 * does after it has drawn the sign-in screen and read one line depends on
 * `FAKE_MODE`:
 *
 * - `success`: draws the token screen, repainting the token cell by cell.
 * - `plain`: draws the token screen with the token written once.
 * - `refused`: draws the vendor's error and waits for Enter, as the real UI does.
 * - `no-token`: exits 0 without a token.
 * - `leaky-exit`: prints the token and exits 1.
 * - `silent`: draws the sign-in screen, then waits for ever.
 * - `split-url`: writes the URL in two pieces with a pause between, then
 *   waits for ever.
 * - `warned`: draws a "Failed to open browser" warning before it asks for the
 *   code, then behaves like `success`.
 *
 * It writes the folder it ran in, `CLAUDE_CONFIG_DIR`, and the credential
 * variables it saw to `FAKE_REPORT`, one per line.
 */
const FAKE_CLAUDE = `#!/bin/bash
[ "$1" = "setup-token" ] || exit 64
stty -echo
{ pwd -P; echo "$CLAUDE_CONFIG_DIR"; echo "key=\${ANTHROPIC_API_KEY-unset}"; echo "token=\${CLAUDE_CODE_OAUTH_TOKEN-unset}"; echo "auth=\${ANTHROPIC_AUTH_TOKEN-unset}"; } > "$FAKE_REPORT"
if [ "$FAKE_MODE" = split-url ]; then
  printf 'Use this url: %s' "\${FAKE_URL:0:30}"
  sleep 0.4
  printf '%s\\r\\n' "\${FAKE_URL:30}"
  exec sleep 600
fi
printf '\\033[?25l\\033[2GWelcome\\033[9Gto\\033[12GClaude\\r\\r\\n'
printf '\\033[2GBrowser\\033[10Gdidn\\047t\\033[16Gopen?\\033[22GUse\\033[26Gthe\\033[30Gurl\\r\\r\\n\\r\\n'
printf '\\033]8;id=a1;%s\\a%s\\033]8;;\\a\\r\\r\\n\\r\\n' "$FAKE_URL" "$FAKE_URL"
[ "$FAKE_MODE" = warned ] && printf '\\033[2GFailed\\033[9Gto\\033[12Gopen\\033[17Gbrowser\\r\\r\\n'
printf '\\033[2GPaste\\033[8Gcode\\033[13Ghere\\033[18G>\\r\\r\\n'
[ "$FAKE_MODE" = silent ] && exec sleep 600
read -r code
case "$FAKE_MODE" in
  refused)
    printf '\\033[2K\\033[1A\\033[2K\\033[G\\033[2GOAuth\\033[8Gerror:\\033[15GInvalid\\033[23Gcode.\\033[29GPlease\\033[36Gmake\\033[41Gsure\\r\\r\\n'
    printf '\\033[2GPress\\033[8GEnter\\033[14Gto\\033[17Gretry.\\r\\r\\n'
    exec sleep 600
    ;;
  no-token)
    printf '\\033[2GLogin\\033[8Gworked\\r\\r\\n'
    exit 0
    ;;
  leaky-exit)
    printf '\\033[2GBoom\\033[33m%s\\033[39m\\r\\r\\n' "$FAKE_TOKEN"
    exit 1
    ;;
  success|plain|warned)
    printf '\\033[2K\\033[1A\\033[2K\\033[G'
    printf '\\033[2G✓\\033[4GLong-lived\\033[15Gauthentication\\033[30Gtoken\\033[36Gcreated\\r\\r\\n\\r\\n'
    printf '\\033[2GYour\\033[7GOAuth\\033[13Gtoken\\033[19G(valid\\033[26Gfor\\033[30G1\\033[32Gyear):\\r\\r\\n\\r\\n'
    # The first paint has a wrong cell range, and the repaint writes only the
    # cells that changed, so no single write holds the token.
    if [ "$FAKE_MODE" = plain ]; then
      printf '\\033[2G\\033[33m%s\\033[39m\\r\\r\\n' "$FAKE_TOKEN"
    else
      printf '\\033[2G\\033[33m%s\\033[39m\\r\\r\\n' "\${FAKE_TOKEN/Abc123/Abc000}"
      printf '\\033[1A\\r\\033[18G123\\033[1B\\r'
    fi
    printf '\\033[2GStore\\033[8Gthis\\033[13Gtoken\\033[19Gsecurely.\\r\\r\\n'
    exit 0
    ;;
esac
`;

let workFolder: string;
let fakeClaude: string;
let reportPath: string;

beforeAll(() => {
  workFolder = mkdtempSync(join(tmpdir(), "hercule-token-test-"));
  fakeClaude = join(workFolder, "claude");
  reportPath = join(workFolder, "report.txt");
  writeFileSync(fakeClaude, FAKE_CLAUDE);
  chmodSync(fakeClaude, 0o755);
});

afterAll(() => {
  rmSync(workFolder, { recursive: true, force: true });
});

const contextFor = (mode: string, overrides: Partial<HarnessRunnerContext> = {}) =>
  ({
    cwd: null,
    attachmentsDir: null,
    editMarks: null,
    attachmentUploader: NO_CONTROLLER_UPLOADER,
    home: join(workFolder, "harness-home"),
    binary: fakeClaude,
    env: {
      PATH: process.env["PATH"],
      HOME: "/home/rogier",
      FAKE_MODE: mode,
      FAKE_REPORT: reportPath,
      FAKE_URL: URL,
      FAKE_TOKEN: TOKEN,
      // The runner's own credentials, which the account must not sign in with.
      ANTHROPIC_API_KEY: "sk-ant-api03-from-the-runner",
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-from-the-runner",
      ANTHROPIC_AUTH_TOKEN: "auth-token-from-the-runner",
    },
    modelArgument: "{model}",
    credentialVariables: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
    herculeTool: { orientation: "", skill: "", claudePluginDir: "/unused" },
    ...overrides,
  }) satisfies HarnessRunnerContext;

/** Reads the report the fake wrote: its folder, `CLAUDE_CONFIG_DIR`, and the credential variables it saw. */
const readReport = (): {
  readonly folder: string;
  readonly configDir: string;
  readonly lines: ReadonlyArray<string>;
} => {
  const lines = readFileSync(reportPath, "utf8").trim().split("\n");
  return { folder: lines[0]!, configDir: lines[1]!, lines: lines.slice(2) };
};

const run = <A>(effect: Effect.Effect<A>): Promise<A> => Effect.runPromise(effect);

const startToken = (
  driver: ReturnType<typeof makeLogins>,
  mode: string,
  adapter: HarnessAdapter = claudeCode,
) => driver.start(REQUEST, ACCOUNT_ID, adapter, contextFor(mode), "create-token");

const expectFolderRemoved = async (folder: string): Promise<void> => {
  await vi.waitFor(() => {
    expect(existsSync(folder)).toBe(false);
  });
};

describe("making a token", () => {
  it("relays the URL from the terminal screen, with no credential of the runner's in its environment", async () => {
    const driver = makeLogins(spawnLogin);
    const answer = await run(startToken(driver, "silent"));

    expect(answer).toEqual({ _tag: "loginUrl", url: URL });
    const { folder, configDir, lines } = readReport();
    expect(lines).toEqual(["key=unset", "token=unset", "auth=unset"]);
    // The command runs in a folder of its own, not in the account's Harness Home.
    expect(realpathSync(configDir)).toBe(realpathSync(folder));
    expect(existsSync(folder)).toBe(true);

    await run(driver.stopAll);
    await expectFolderRemoved(folder);
  });

  it("writes the code followed by Enter, returns the token and removes the folder", async () => {
    const driver = makeLogins(spawnLogin);
    await run(startToken(driver, "success"));
    const { folder } = readReport();

    const answer = await run(driver.submit(ACCOUNT_ID, "the-pasted-code#state"));

    // The token was repainted cell by cell, so only the screen holds it whole.
    expect(answer).toEqual({ _tag: "loginResult", ok: true, token: TOKEN });
    await expectFolderRemoved(folder);
  });

  it("reads a URL and a token that the terminal wrapped across lines", async () => {
    const narrow: HarnessAdapter = {
      ...claudeCode,
      login: (ctx, binary, method) => ({
        ...claudeCode.login!(ctx, binary, method)!,
        terminal: { cols: 20, rows: 60 },
      }),
    };
    const driver = makeLogins(spawnLogin);

    const url = await run(startToken(driver, "plain", narrow));
    const answer = await run(driver.submit(ACCOUNT_ID, "code"));

    expect(url).toEqual({ _tag: "loginUrl", url: URL });
    expect(answer).toEqual({ _tag: "loginResult", ok: true, token: TOKEN });
    await expectFolderRemoved(readReport().folder);
  });

  it("relays a URL that arrives in two pieces whole, never the first half", async () => {
    const driver = makeLogins(spawnLogin);

    const answer = await run(startToken(driver, "split-url"));

    expect(answer).toEqual({ _tag: "loginUrl", url: URL });
    await run(driver.stopAll);
  });

  it("does not take a warning drawn before the code was asked for as a refusal of the code", async () => {
    const driver = makeLogins(spawnLogin);
    await run(startToken(driver, "warned"));

    const answer = await run(driver.submit(ACCOUNT_ID, "the-pasted-code#state"));

    expect(answer).toEqual({ _tag: "loginResult", ok: true, token: TOKEN });
  });

  it("fails and says to start again when the vendor refuses the code, and removes the folder", async () => {
    const driver = makeLogins(spawnLogin);
    await run(startToken(driver, "refused"));
    const { folder } = readReport();

    const answer = await run(driver.submit(ACCOUNT_ID, "wrong"));

    // Not a rejected code that leaves the login waiting: this login is over.
    expect(answer).toEqual({
      _tag: "loginFailed",
      message:
        "OAuth error: Invalid code. Please make sure. This sign-in cannot take another code; start it again for a new link.",
    });
    await expectFolderRemoved(folder);
    // The login is over, so a second code has nothing to go to.
    expect(await run(driver.submit(ACCOUNT_ID, "again"))).toEqual({
      _tag: "loginFailed",
      message: "no login in progress",
    });
  });

  it("fails when the command exits cleanly without printing a token", async () => {
    const driver = makeLogins(spawnLogin);
    await run(startToken(driver, "no-token"));
    const { folder } = readReport();

    const answer = await run(driver.submit(ACCOUNT_ID, "code"));

    expect(answer).toEqual({
      _tag: "loginResult",
      ok: false,
      message: "the login finished without printing a token",
    });
    await expectFolderRemoved(folder);
  });

  it("keeps a token out of the failure message of a command that fails after printing it", async () => {
    const driver = makeLogins(spawnLogin);
    await run(startToken(driver, "leaky-exit"));
    const { folder } = readReport();

    const answer = await run(driver.submit(ACCOUNT_ID, "code"));

    expect(answer).toMatchObject({ _tag: "loginResult", ok: false });
    const message = (answer as { message: string }).message;
    expect(message).toContain("Boom");
    expect(message).toContain("[token removed]");
    expect(message).not.toContain("sk-ant-oat");
    await expectFolderRemoved(folder);
  });

  it("removes the folder when the login sits idle until its time is up", async () => {
    const driver = makeLogins(spawnLogin);
    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const starting = yield* Effect.forkChild(startToken(driver, "silent"));
          yield* TestClock.adjust(Duration.zero);
          yield* Fiber.join(starting);
          yield* TestClock.adjust(LOGIN_IDLE);
        }),
        TestClock.layer(),
      ),
    );

    await expectFolderRemoved(readReport().folder);
  });

  it("removes the folder of the login that a new login for the same account replaces", async () => {
    const driver = makeLogins(spawnLogin);
    await run(startToken(driver, "silent"));
    const first = readReport().folder;

    await run(startToken(driver, "silent"));

    await expectFolderRemoved(first);
    const second = readReport().folder;
    expect(second).not.toBe(first);
    await run(driver.stopAll);
    await expectFolderRemoved(second);
  });

  it("removes the folder when the command cannot be started", async () => {
    let folder: string | undefined;
    const failing: HarnessAdapter = {
      ...claudeCode,
      login: (): LoginCommand => {
        folder = mkdtempSync(join(tmpdir(), "hercule-token-test-start-"));
        return {
          command: ["claude"],
          env: {},
          scratchFolder: folder,
          terminal: { cols: 80, rows: 24 },
        };
      },
    };
    const driver = makeLogins(() => {
      throw new Error("spawn failed");
    });

    await expect(run(startToken(driver, "success", failing))).rejects.toThrow();

    expect(existsSync(folder!)).toBe(false);
  });

  it("answers a failed login when the harness has no way to make a token", async () => {
    const driver = makeLogins(() => {
      throw new Error("must not start anything");
    });

    const answer = await run(startToken(driver, "success", codex));

    expect(answer).toEqual({
      _tag: "loginFailed",
      message: "The harness codex/codex cannot create a token in this runner build",
    });
  });
});

describe("the Claude Code token login command", () => {
  it("runs setup-token in a wide terminal and a folder of its own", () => {
    const ctx = contextFor("success");
    const command = claudeCode.login!(ctx, fakeClaude, "create-token")!;
    try {
      expect(command.command).toEqual([fakeClaude, "setup-token"]);
      expect(command.terminal).toEqual({ cols: 1000, rows: 60 });
      expect(command.env["CLAUDE_CONFIG_DIR"]).toBe(command.scratchFolder);
      expect(command.scratchFolder).not.toBe(ctx.home);
      expect(command.env["BROWSER"]).toBe("false");
      expect(command.env["ANTHROPIC_API_KEY"]).toBeUndefined();
      expect(command.env["CLAUDE_CODE_OAUTH_TOKEN"]).toBeUndefined();
      expect(command.env["ANTHROPIC_AUTH_TOKEN"]).toBeUndefined();
      expect(command.tokenPattern!.exec(`x ${TOKEN} y`)?.[0]).toBe(TOKEN);
    } finally {
      rmSync(command.scratchFolder!, { recursive: true, force: true });
    }
  });

  it("keeps the sign-in command as it was", () => {
    const ctx = contextFor("success");
    const command = claudeCode.login!(ctx, fakeClaude, "sign-in")!;
    expect(command.command).toEqual([fakeClaude, "auth", "login"]);
    expect(command.terminal).toBeUndefined();
    expect(command.scratchFolder).toBeUndefined();
    expect(command.env["CLAUDE_CONFIG_DIR"]).toBe(ctx.home);
  });
});
