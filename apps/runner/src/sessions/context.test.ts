/**
 * What a session gets on this machine. Every assertion here is a leak the spec
 * names: a cwd the harness would read instruction files out of, a config
 * directory shared with another instance or with the user's own, and an
 * environment where instance config could take `HERCULE_SESSION` away from the
 * `hercule` CLI the session calls.
 */
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Effect } from "effect";
import type { SessionStart } from "@hercule/protocol";
import { resolveSessionContext, type Machine } from "./context";
import { makeWorkspaces } from "../workspaces";
import {
  addBranch,
  buildCheckout,
  cleanTemporaries,
  runGitOrThrow,
  createId,
  makeRemote,
  buildProvisionFrame,
} from "../workspaces/testing";

const roots: Array<string> = [];

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  cleanTemporaries();
});

const createRoot = (): string => {
  const made = mkdtempSync(join(tmpdir(), "hercule-sessions-"));
  roots.push(made);
  return made;
};

const INSTANCE = "0199e0e7-0000-7000-8000-00000000000a";
const SESSION = "0199e0e7-0000-7000-8000-0000000000ff";

const buildMachine = (overrides: Partial<Machine> = {}): Machine => {
  const under = createRoot();
  return {
    providersDir: join(under, "providers"),
    scratchDir: join(under, "scratch"),
    binDir: join(under, "runner", "bin"),
    herculeTool: { skill: "# hercule", claudePluginDir: join(under, "claude-plugin") },
    controllerUrl: "https://controller.example:4938",
    baseEnv: { PATH: "/usr/bin", HOME: "/home/somebody" },
    binaryOf: (name) => `/usr/local/bin/${name}`,
    workspaces: makeWorkspaces({ storageDir: join(under, "storage") }),
    socketPath: join(under, "daemon.sock"),
    ...overrides,
  };
};

const buildSessionStart = (overrides: Partial<SessionStart> = {}): SessionStart => ({
  _tag: "sessionStart",
  sessionId: SESSION,
  providerId: "claude-code",
  config: {},
  secrets: {},
  token: "a-session-token",
  spec: {
    instanceId: INSTANCE,
    workspaceId: null,
    modelSelection: { model: "claude-haiku-4-5", options: {} },
    accessMode: "approval-required",
    timeouts: { inactivityMs: 1_800_000, absoluteMs: 28_800_000 },
  },
  ...overrides,
});

const resolveSync = (frame: SessionStart, machine: Machine) =>
  Effect.runSync(Effect.result(resolveSessionContext(frame, machine, "claude")));

/** The same, for the cases where resolving a workspace reaches real git. */
const resolveAsync = (frame: SessionStart, machine: Machine) =>
  Effect.runPromise(Effect.result(resolveSessionContext(frame, machine, "claude")));

describe("what a workspace-less session runs in", () => {
  it("gets a scratch directory of its own, and it is empty", () => {
    const machine = buildMachine();

    const outcome = resolveSync(buildSessionStart(), machine);

    expect(outcome._tag).toBe("Success");
    const resolved = outcome._tag === "Success" ? outcome.success : undefined;
    // Its own, so no two sessions read each other's files, and empty, because
    // every harness reads instruction files out of its cwd (spec 06 section 9.1).
    expect(resolved?.ctx.cwd).toBe(join(machine.scratchDir, SESSION));
    expect(readdirSync(resolved!.ctx.cwd!)).toEqual([]);
    expect(resolved?.scratch).toBe(resolved?.ctx.cwd);
  });

  it("gets the instance's own config directory, made private", () => {
    const machine = buildMachine();

    const resolved = resolveSync(buildSessionStart(), machine);

    const home = join(machine.providersDir, INSTANCE);
    expect(resolved._tag === "Success" ? resolved.success.ctx.home : undefined).toBe(home);
    // A login lives in here, so nobody else on the machine reads it.
    expect(statSync(home).mode & 0o777).toBe(0o700);
  });

  it("keeps a config directory another instance already made", () => {
    const machine = buildMachine();
    const outcome = resolveSync(buildSessionStart(), machine);
    expect(outcome._tag).toBe("Success");
    const home = join(machine.providersDir, INSTANCE);
    writeFileSync(join(home, ".credentials.json"), "the login");

    // The second session of the same instance must find the same login rather
    // than a fresh directory nobody is authenticated in.
    resolveSync(buildSessionStart({ sessionId: crypto.randomUUID() }), machine);

    expect(existsSync(join(home, ".credentials.json"))).toBe(true);
  });

  it("empties a scratch directory a previous session of the same id left", () => {
    const machine = buildMachine();
    const first = resolveSync(buildSessionStart(), machine);
    expect(first._tag).toBe("Success");
    const scratch = join(machine.scratchDir, SESSION);
    writeFileSync(join(scratch, "CLAUDE.md"), "instructions nobody asked for");

    resolveSync(buildSessionStart(), machine);

    // Empty is the whole property: a file left here is one the harness reads.
    expect(readdirSync(scratch)).toEqual([]);
  });

  it("takes the harness this machine probed", () => {
    const outcome = resolveSync(buildSessionStart(), buildMachine({ binaryOf: () => undefined }));

    // Not a guess at a path: a machine without the harness is the adapter's to
    // refuse, by name.
    expect(outcome._tag === "Success" ? outcome.success.ctx.binary : "").toBeUndefined();
  });
});

describe("the environment a session runs with", () => {
  const resolveEnv = (
    frame: SessionStart,
    machine: Machine,
  ): Record<string, string | undefined> => {
    const outcome = resolveSync(frame, machine);
    expect(outcome._tag).toBe("Success");
    return outcome._tag === "Success" ? { ...outcome.success.ctx.env } : {};
  };

  it("layers the machine's own, then the instance's, then Hercule's", () => {
    const env = resolveEnv(
      buildSessionStart({
        config: { env: { ANTHROPIC_BASE_URL: "https://gateway.example", PATH: "/opt" } },
      }),
      buildMachine(),
    );

    // The instance's routing reaches the harness: that is what instance config
    // is for (spec 06 section 2.1). Its `PATH` does not, because the session
    // would then have no `hercule` to call.
    expect(env["ANTHROPIC_BASE_URL"]).toBe("https://gateway.example");
    expect(env["HOME"]).toBe("/home/somebody");
  });

  it("tells the session where the API is and that it is one", () => {
    const env = resolveEnv(buildSessionStart(), buildMachine());

    expect(env["HERCULE_API_URL"]).toBe("https://controller.example:4938");
    // The `hercule` CLI refuses the user's stored key under this (spec 15 section 2).
    expect(env["HERCULE_SESSION"]).toBe("1");
    // The credential the session calls Hercule with: the very token the frame
    // carried, never one the runner invented (spec 06 section 9.3).
    expect(env["HERCULE_TOKEN"]).toBe("a-session-token");
  });

  it("puts the runner's own bin directory at the front of PATH", () => {
    const machine = buildMachine();

    const env = resolveEnv(buildSessionStart(), machine);

    // `which hercule` has to work, and the machine's own tools have to keep
    // working after it (spec 15 section 2).
    expect(env["PATH"]).toBe(`${machine.binDir}:/usr/bin`);
  });

  it("is the bin directory alone where the machine gave the runner no PATH", () => {
    const machine = buildMachine({ baseEnv: { HOME: "/home/somebody" } });

    const env = resolveEnv(buildSessionStart(), machine);

    // Never a stray colon: an empty entry on PATH is the current directory,
    // which is a scratch directory the session writes into.
    expect(env["PATH"]).toBe(machine.binDir);
  });

  it("does not let instance config take those away", () => {
    const machine = buildMachine();
    const env = resolveEnv(
      buildSessionStart({
        config: {
          env: {
            HERCULE_SESSION: "0",
            HERCULE_API_URL: "http://attacker.example",
            HERCULE_TOKEN: "a token nobody minted",
            PATH: "/opt",
          },
        },
      }),
      machine,
    );

    // Instance config is the user's routing, not a way to point the session's
    // credential, its controller or its `hercule` at something else.
    expect(env["HERCULE_SESSION"]).toBe("1");
    expect(env["HERCULE_API_URL"]).toBe("https://controller.example:4938");
    expect(env["HERCULE_TOKEN"]).toBe("a-session-token");
    expect(env["PATH"]).toBe(`${machine.binDir}:/usr/bin`);
  });

  it("does not let instance config move HOME", () => {
    // Relocating it makes the Claude CLI report another account's login, or
    // none: on macOS the Keychain item is keyed by the real home (spec 06
    // section 9.1). Isolation is the config directory's job, not HOME's.
    const env = resolveEnv(
      buildSessionStart({ config: { env: { HOME: "/somewhere/else" } } }),
      buildMachine(),
    );

    expect(env["HOME"]).toBe("/home/somebody");
  });

  it("ignores config that is not an environment rather than refusing to start", () => {
    // No shipped provider declares one, so what arrives is `{}` today.
    const env = resolveEnv(buildSessionStart({ config: { env: { PORT: 8080 } } }), buildMachine());

    expect(env["PORT"]).toBeUndefined();
    expect(env["HERCULE_SESSION"]).toBe("1");
    expect(
      resolveEnv(buildSessionStart({ config: "nonsense" }), buildMachine())["HERCULE_SESSION"],
    ).toBe("1");
  });
});

describe("a session the runner cannot place", () => {
  it("refuses a workspace this machine does not hold, by id", async () => {
    const machine = buildMachine();
    const workspaceId = "0199e0e7-0000-7000-8000-00000000000b";

    const outcome = await resolveAsync(
      buildSessionStart({ spec: { ...buildSessionStart().spec, workspaceId } }),
      machine,
    );

    // Never a silent fallback to a scratch directory: the session would run
    // somewhere the user did not choose.
    expect(outcome._tag).toBe("Failure");
    expect(outcome._tag === "Failure" ? outcome.failure : "").toContain(workspaceId);
    expect(existsSync(machine.scratchDir)).toBe(false);
  });
});

describe("a session that has a workspace", () => {
  it("runs in the workspace's directory, with no scratch of its own", async () => {
    const remote = makeRemote();
    const machine = buildMachine();
    const workspaceId = createId();
    await machine.workspaces.provision(
      buildProvisionFrame({
        workspaceId,
        kind: "ephemeral",
        checkouts: [
          buildCheckout({
            resourceId: createId(),
            remote: remote.url,
            branch: "hercule/run-9c9c9c9c",
          }),
        ],
      }),
    );

    const outcome = await resolveAsync(
      buildSessionStart({ spec: { ...buildSessionStart().spec, workspaceId } }),
      machine,
    );

    expect(outcome._tag).toBe("Success");
    const resolved = outcome._tag === "Success" ? outcome.success : undefined;
    expect(resolved?.ctx.cwd).toBe(machine.workspaces.resolve(workspaceId)?.cwd);
    // Nothing to remove on exit: the workspace outlives the session.
    expect(resolved?.scratch).toBeUndefined();
  });

  it("switches a primary's checkout to the branch the frame names, before it starts", async () => {
    const remote = makeRemote();
    addBranch(remote, "release");
    const machine = buildMachine();
    const workspaceId = createId();
    const resourceId = createId();
    await machine.workspaces.provision(
      buildProvisionFrame({
        workspaceId,
        kind: "primary",
        checkouts: [buildCheckout({ resourceId, remote: remote.url })],
      }),
    );
    const folder = machine.workspaces.resolve(workspaceId)!.cwd;

    const outcome = await resolveAsync(
      buildSessionStart({
        spec: { ...buildSessionStart().spec, workspaceId },
        checkoutBranch: "release",
      }),
      machine,
    );

    expect(outcome._tag).toBe("Success");
    expect(runGitOrThrow(folder, "rev-parse", "--abbrev-ref", "HEAD")).toBe("release");
  });

  it("refuses the session with git's own words when the branch cannot be switched to", async () => {
    const remote = makeRemote();
    const machine = buildMachine();
    const workspaceId = createId();
    const resourceId = createId();
    await machine.workspaces.provision(
      buildProvisionFrame({
        workspaceId,
        kind: "primary",
        checkouts: [buildCheckout({ resourceId, remote: remote.url })],
      }),
    );
    const folder = machine.workspaces.resolve(workspaceId)!.cwd;

    const outcome = await resolveAsync(
      buildSessionStart({
        spec: { ...buildSessionStart().spec, workspaceId },
        checkoutBranch: "no-such-branch",
      }),
      machine,
    );

    // A forced switch would lose the user's uncommitted work, so it is a
    // failure the user reads, not something the runner works around.
    expect(outcome._tag).toBe("Failure");
    expect(outcome._tag === "Failure" ? outcome.failure : "").toContain("no-such-branch");
    expect(runGitOrThrow(folder, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  });
});

describe("the git credential environment a session runs with", () => {
  /** The `GIT_CONFIG_*` triple, read back as the ordered pairs git would see. */
  const readGitConfig = (
    env: Record<string, string | undefined>,
  ): ReadonlyArray<readonly [string | undefined, string | undefined]> =>
    Array.from({ length: Number(env["GIT_CONFIG_COUNT"] ?? "0") }, (_, n) => [
      env[`GIT_CONFIG_KEY_${String(n)}`],
      env[`GIT_CONFIG_VALUE_${String(n)}`],
    ]);

  it("points git at this runner's helper and drops the machine's own", async () => {
    const machine = buildMachine();

    const outcome = await resolveAsync(buildSessionStart({ token: "the-session-token" }), machine);
    const env = outcome._tag === "Success" ? { ...outcome.success.ctx.env } : {};

    expect(env["HERCULE_RUNNER_SOCKET"]).toBe(machine.socketPath);
    // The helper authenticates as this session, and nothing else.
    expect(env["HERCULE_TOKEN"]).toBe("the-session-token");
    const pairs = readGitConfig(env);
    // The empty entry comes first: an inherited helper would otherwise answer
    // with the machine owner's credentials, for any repository.
    expect(pairs[0]).toEqual(["credential.helper", ""]);
    expect(pairs[1]?.[0]).toBe("credential.helper");
    expect(pairs[1]?.[1] ?? "").toContain("git-credential");
    expect((pairs[1]?.[1] ?? "").startsWith("/")).toBe(true);
    // Without it the token of one repository would be sent to another host's.
    expect(pairs).toContainEqual(["credential.useHttpPath", "true"]);
    expect(pairs.length).toBe(Number(env["GIT_CONFIG_COUNT"]));
  });

  it("commits as the account the credential comes from, when the frame names one", async () => {
    const outcome = await resolveAsync(
      buildSessionStart({
        gitIdentity: { name: "octocat", email: "octocat@users.noreply.github.com" },
      }),
      buildMachine(),
    );
    const env = outcome._tag === "Success" ? { ...outcome.success.ctx.env } : {};

    const pairs = readGitConfig(env);
    expect(pairs).toContainEqual(["user.name", "octocat"]);
    expect(pairs).toContainEqual(["user.email", "octocat@users.noreply.github.com"]);
    expect(pairs.length).toBe(Number(env["GIT_CONFIG_COUNT"]));
  });

  it("leaves the identity to the machine's own git when the frame names none", async () => {
    const outcome = await resolveAsync(buildSessionStart(), buildMachine());
    const env = outcome._tag === "Success" ? { ...outcome.success.ctx.env } : {};

    // A session without a workspace has no Connection behind it, and an empty
    // `user.name` would make every commit fail rather than fall back.
    expect(readGitConfig(env).map((pair) => pair[0])).not.toContain("user.name");
  });

  it("keeps the machine owner's own git out of the session", async () => {
    const outcome = await resolveAsync(
      buildSessionStart(),
      buildMachine({
        baseEnv: {
          PATH: "/usr/bin",
          HOME: "/home/somebody",
          SSH_AUTH_SOCK: "/private/tmp/ssh-agent.socket",
          // What the person who started the daemon exported for themselves.
          GIT_ASKPASS: "/usr/bin/say-the-password",
          SSH_ASKPASS: "/usr/bin/say-the-password",
          GIT_CONFIG_GLOBAL: "/home/somebody/.gitconfig",
        },
      }),
    );
    const env = outcome._tag === "Success" ? { ...outcome.success.ctx.env } : {};

    // Either of these would answer for the agent, with the machine owner's own
    // credentials, for any repository.
    expect(env["GIT_ASKPASS"]).toBeUndefined();
    expect(env["SSH_ASKPASS"]).toBeUndefined();
    // And this would take the helper away by pointing git at another file.
    expect(env["GIT_CONFIG_GLOBAL"]).toBeUndefined();
    // The agent still reaches its ssh keys and its home.
    expect(env["SSH_AUTH_SOCK"]).toBe("/private/tmp/ssh-agent.socket");
    expect(env["HOME"]).toBe("/home/somebody");
    expect(env["GIT_TERMINAL_PROMPT"]).toBe("0");
    expect(readGitConfig(env)[1]?.[0]).toBe("credential.helper");
  });

  it("carries GH_TOKEN only when the frame does", async () => {
    const withToken = await resolveAsync(
      buildSessionStart({ ghToken: "ghp_for_gh_cli" }),
      buildMachine(),
    );
    const without = await resolveAsync(buildSessionStart(), buildMachine());

    expect(withToken._tag === "Success" ? withToken.success.ctx.env["GH_TOKEN"] : undefined).toBe(
      "ghp_for_gh_cli",
    );
    // An empty one reads to `gh` as a credential that failed.
    expect(
      without._tag === "Success" ? without.success.ctx.env["GH_TOKEN"] : "set",
    ).toBeUndefined();
  });
});

describe("where the session's token is written", () => {
  /** Every regular file under a directory, symlinks left unread. */
  const listFiles = (dir: string): ReadonlyArray<string> =>
    !existsSync(dir)
      ? []
      : readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
          entry.isDirectory()
            ? listFiles(join(dir, entry.name))
            : entry.isFile()
              ? [join(dir, entry.name)]
              : [],
        );

  it("is nowhere on disk: the token lives in the process environment alone", () => {
    const under = createRoot();
    const machine = buildMachine({
      providersDir: join(under, "providers"),
      scratchDir: join(under, "scratch"),
      binDir: join(under, "bin"),
      herculeTool: { skill: "# hercule", claudePluginDir: join(under, "claude-plugin") },
    });
    const token = `hercule-token-${crypto.randomUUID()}`;

    const outcome = resolveSync(buildSessionStart({ token }), machine);

    expect(outcome._tag).toBe("Success");
    expect(outcome._tag === "Success" ? outcome.success.ctx.env["HERCULE_TOKEN"] : "").toBe(token);
    // A token on disk outlives the session that held it; the whole point of
    // one is that it dies with the process (spec 06 section 9.3).
    const leaked = listFiles(under).filter((path) => readFileSync(path, "utf8").includes(token));
    expect(leaked).toEqual([]);
  });
});
