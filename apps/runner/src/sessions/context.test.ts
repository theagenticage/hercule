/**
 * What a session gets on this machine. Every assertion here is a leak the spec
 * names: a cwd the harness would read instruction files out of, a config
 * directory shared with another instance or with the user's own, and an
 * environment where instance config could take `HYDRA_SESSION` away from the
 * `hydra` CLI the session calls.
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
import type { SessionStart } from "@hydra/protocol";
import { resolve, type Machine } from "./context";

const roots: Array<string> = [];

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const root = (): string => {
  const made = mkdtempSync(join(tmpdir(), "hydra-sessions-"));
  roots.push(made);
  return made;
};

const INSTANCE = "0199e0e7-0000-7000-8000-00000000000a";
const SESSION = "0199e0e7-0000-7000-8000-0000000000ff";

const machining = (overrides: Partial<Machine> = {}): Machine => {
  const under = root();
  return {
    providersDir: join(under, "providers"),
    scratchDir: join(under, "scratch"),
    binDir: join(under, "runner", "bin"),
    hydraTool: { skill: "# hydra", claudePluginDir: join(under, "claude-plugin") },
    controllerUrl: "https://controller.example:4938",
    baseEnv: { PATH: "/usr/bin", HOME: "/home/somebody" },
    binaryOf: (name) => `/usr/local/bin/${name}`,
    ...overrides,
  };
};

const starting = (overrides: Partial<SessionStart> = {}): SessionStart => ({
  _tag: "sessionStart",
  sessionId: SESSION,
  providerId: "claude-code",
  config: {},
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

const resolving = (frame: SessionStart, machine: Machine) =>
  Effect.runSync(Effect.result(resolve(frame, machine, "claude")));

describe("what a workspace-less session runs in", () => {
  it("gets a scratch directory of its own, and it is empty", () => {
    const machine = machining();

    const outcome = resolving(starting(), machine);

    expect(outcome._tag).toBe("Success");
    const resolved = outcome._tag === "Success" ? outcome.success : undefined;
    // Its own, so no two sessions read each other's files, and empty, because
    // every harness reads instruction files out of its cwd (spec 06 section 9.1).
    expect(resolved?.ctx.cwd).toBe(join(machine.scratchDir, SESSION));
    expect(readdirSync(resolved!.ctx.cwd!)).toEqual([]);
    expect(resolved?.scratch).toBe(resolved?.ctx.cwd);
  });

  it("gets the instance's own config directory, made private", () => {
    const machine = machining();

    const resolved = resolving(starting(), machine);

    const home = join(machine.providersDir, INSTANCE);
    expect(resolved._tag === "Success" ? resolved.success.ctx.home : undefined).toBe(home);
    // A login lives in here, so nobody else on the machine reads it.
    expect(statSync(home).mode & 0o777).toBe(0o700);
  });

  it("keeps a config directory another instance already made", () => {
    const machine = machining();
    const outcome = resolving(starting(), machine);
    expect(outcome._tag).toBe("Success");
    const home = join(machine.providersDir, INSTANCE);
    writeFileSync(join(home, ".credentials.json"), "the login");

    // The second session of the same instance must find the same login rather
    // than a fresh directory nobody is authenticated in.
    resolving(starting({ sessionId: crypto.randomUUID() }), machine);

    expect(existsSync(join(home, ".credentials.json"))).toBe(true);
  });

  it("empties a scratch directory a previous session of the same id left", () => {
    const machine = machining();
    const first = resolving(starting(), machine);
    expect(first._tag).toBe("Success");
    const scratch = join(machine.scratchDir, SESSION);
    writeFileSync(join(scratch, "CLAUDE.md"), "instructions nobody asked for");

    resolving(starting(), machine);

    // Empty is the whole property: a file left here is one the harness reads.
    expect(readdirSync(scratch)).toEqual([]);
  });

  it("takes the harness this machine probed", () => {
    const outcome = resolving(starting(), machining({ binaryOf: () => undefined }));

    // Not a guess at a path: a machine without the harness is the adapter's to
    // refuse, by name.
    expect(outcome._tag === "Success" ? outcome.success.ctx.binary : "").toBeUndefined();
  });
});

describe("the environment a session runs with", () => {
  const envOf = (frame: SessionStart, machine: Machine): Record<string, string | undefined> => {
    const outcome = resolving(frame, machine);
    expect(outcome._tag).toBe("Success");
    return outcome._tag === "Success" ? { ...outcome.success.ctx.env } : {};
  };

  it("layers the machine's own, then the instance's, then Hydra's", () => {
    const env = envOf(
      starting({
        config: { env: { ANTHROPIC_BASE_URL: "https://gateway.example", PATH: "/opt" } },
      }),
      machining(),
    );

    // The instance's routing reaches the harness: that is what instance config
    // is for (spec 06 section 2.1). Its `PATH` does not, because the session
    // would then have no `hydra` to call.
    expect(env["ANTHROPIC_BASE_URL"]).toBe("https://gateway.example");
    expect(env["HOME"]).toBe("/home/somebody");
  });

  it("tells the session where the API is and that it is one", () => {
    const env = envOf(starting(), machining());

    expect(env["HYDRA_API_URL"]).toBe("https://controller.example:4938");
    // The `hydra` CLI refuses the user's stored key under this (spec 15 section 2).
    expect(env["HYDRA_SESSION"]).toBe("1");
    // The credential the session calls Hydra with: the very token the frame
    // carried, never one the runner invented (spec 06 section 9.3).
    expect(env["HYDRA_TOKEN"]).toBe("a-session-token");
  });

  it("puts the runner's own bin directory at the front of PATH", () => {
    const machine = machining();

    const env = envOf(starting(), machine);

    // `which hydra` has to work, and the machine's own tools have to keep
    // working after it (spec 15 section 2).
    expect(env["PATH"]).toBe(`${machine.binDir}:/usr/bin`);
  });

  it("is the bin directory alone where the machine gave the runner no PATH", () => {
    const machine = machining({ baseEnv: { HOME: "/home/somebody" } });

    const env = envOf(starting(), machine);

    // Never a stray colon: an empty entry on PATH is the current directory,
    // which is a scratch directory the session writes into.
    expect(env["PATH"]).toBe(machine.binDir);
  });

  it("does not let instance config take those away", () => {
    const machine = machining();
    const env = envOf(
      starting({
        config: {
          env: {
            HYDRA_SESSION: "0",
            HYDRA_API_URL: "http://attacker.example",
            HYDRA_TOKEN: "a token nobody minted",
            PATH: "/opt",
          },
        },
      }),
      machine,
    );

    // Instance config is the user's routing, not a way to point the session's
    // credential, its controller or its `hydra` at something else.
    expect(env["HYDRA_SESSION"]).toBe("1");
    expect(env["HYDRA_API_URL"]).toBe("https://controller.example:4938");
    expect(env["HYDRA_TOKEN"]).toBe("a-session-token");
    expect(env["PATH"]).toBe(`${machine.binDir}:/usr/bin`);
  });

  it("does not let instance config move HOME", () => {
    // Relocating it makes the Claude CLI report another account's login, or
    // none: on macOS the Keychain item is keyed by the real home (spec 06
    // section 9.1). Isolation is the config directory's job, not HOME's.
    const env = envOf(starting({ config: { env: { HOME: "/somewhere/else" } } }), machining());

    expect(env["HOME"]).toBe("/home/somebody");
  });

  it("ignores config that is not an environment rather than refusing to start", () => {
    // No shipped provider declares one, so what arrives is `{}` today.
    const env = envOf(starting({ config: { env: { PORT: 8080 } } }), machining());

    expect(env["PORT"]).toBeUndefined();
    expect(env["HYDRA_SESSION"]).toBe("1");
    expect(envOf(starting({ config: "nonsense" }), machining())["HYDRA_SESSION"]).toBe("1");
  });
});

describe("a session the runner cannot place", () => {
  it("says a workspace is not something it can provision yet", () => {
    const machine = machining();

    const outcome = resolving(
      starting({
        spec: { ...starting().spec, workspaceId: "0199e0e7-0000-7000-8000-00000000000b" },
      }),
      machine,
    );

    // Never a silent fallback to a scratch directory: the session would run
    // somewhere the user did not choose.
    expect(outcome._tag).toBe("Failure");
    expect(outcome._tag === "Failure" ? outcome.failure : "").toContain("0199e0e7");
    expect(existsSync(machine.scratchDir)).toBe(false);
  });
});

describe("where the session's token is written", () => {
  /** Every regular file under a directory, symlinks left unread. */
  const filesUnder = (dir: string): ReadonlyArray<string> =>
    !existsSync(dir)
      ? []
      : readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
          entry.isDirectory()
            ? filesUnder(join(dir, entry.name))
            : entry.isFile()
              ? [join(dir, entry.name)]
              : [],
        );

  it("is nowhere on disk: the token lives in the process environment alone", () => {
    const under = root();
    const machine = machining({
      providersDir: join(under, "providers"),
      scratchDir: join(under, "scratch"),
      binDir: join(under, "bin"),
      hydraTool: { skill: "# hydra", claudePluginDir: join(under, "claude-plugin") },
    });
    const token = `hydra-token-${crypto.randomUUID()}`;

    const outcome = resolving(starting({ token }), machine);

    expect(outcome._tag).toBe("Success");
    expect(outcome._tag === "Success" ? outcome.success.ctx.env["HYDRA_TOKEN"] : "").toBe(token);
    // A token on disk outlives the session that held it; the whole point of
    // one is that it dies with the process (spec 06 section 9.3).
    const leaked = filesUnder(under).filter((path) => readFileSync(path, "utf8").includes(token));
    expect(leaked).toEqual([]);
  });
});
