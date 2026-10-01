import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Effect, Result } from "effect";
import { BootstrapConfig, layer, HerculeHome } from "./index";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "hercule-home-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** Resolves config the way `hercule serve` does, against the temporary home. */
const load = (argv: ReadonlyArray<string> = [], env: Record<string, string | undefined> = {}) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return { home: yield* HerculeHome, config: yield* BootstrapConfig };
    }).pipe(Effect.provide(layer(["--home", home, ...argv], env)), Effect.result),
  );

const loadOrFail = async (
  argv: ReadonlyArray<string> = [],
  env: Record<string, string | undefined> = {},
) => {
  const result = await load(argv, env);
  if (Result.isFailure(result)) throw new Error(`unexpected failure: ${result.failure.message}`);
  return result.success;
};

const loadAndReadFailure = async (
  argv: ReadonlyArray<string> = [],
  env: Record<string, string | undefined> = {},
) => {
  const result = await load(argv, env);
  if (Result.isSuccess(result)) throw new Error("expected a failure");
  return result.failure;
};

describe("the config layer", () => {
  it("uses the default for every key and writes the config file it would have read", async () => {
    const { config, home: paths } = await loadOrFail();

    expect(config).toEqual({
      dataDir: "data",
      bindHost: "127.0.0.1",
      bindPort: 4937,
      logLevel: "info",
    });
    // Relative, so the file holds no absolute path and a home that moves keeps
    // working (spec 04, Relocatable Data Root).
    expect(readFileSync(paths.configFile, "utf8")).toBe(
      [
        'data.dir = "data"',
        'bind.host = "127.0.0.1"',
        "bind.port = 4937",
        'log.level = "info"',
        "",
      ].join("\n"),
    );
    expect(paths.dataDir).toBe(join(home, "data"));
  });

  it("creates the home layout, and creating it again changes nothing", async () => {
    const first = await loadOrFail();
    const marker = join(first.home.logsDir, "keep-me");
    writeFileSync(marker, "");

    const second = await loadOrFail();
    for (const directory of [
      second.home.dataDir,
      second.home.runnerDir,
      second.home.logsDir,
      second.home.backupsDir,
      second.home.tlsDir,
    ]) {
      expect(existsSync(directory)).toBe(true);
    }
    expect(existsSync(marker)).toBe(true);
  });

  it("prefers a flag over an env var over the file over the default", async () => {
    writeFileSync(join(home, "config.toml"), '[bind]\nhost = "10.0.0.1"\nport = 5000\n');

    const fromFile = await loadOrFail();
    expect(fromFile.config.bindHost).toBe("10.0.0.1");
    expect(fromFile.config.bindPort).toBe(5000);

    const fromEnv = await loadOrFail([], {
      HERCULE_BIND_HOST: "10.0.0.2",
      HERCULE_BIND_PORT: "5001",
    });
    expect(fromEnv.config.bindHost).toBe("10.0.0.2");
    expect(fromEnv.config.bindPort).toBe(5001);

    const fromFlag = await loadOrFail(["-c", "bind.host=10.0.0.3", "-c", "bind.port=5002"], {
      HERCULE_BIND_HOST: "10.0.0.2",
      HERCULE_BIND_PORT: "5001",
    });
    expect(fromFlag.config.bindHost).toBe("10.0.0.3");
    expect(fromFlag.config.bindPort).toBe(5002);
  });

  it("lets the last -c for a key win", async () => {
    const { config } = await loadOrFail(["-c", "bind.port=5000", "-c", "bind.port=5001"]);
    expect(config.bindPort).toBe(5001);
  });

  it("accepts --home=<dir> as well as --home <dir>", async () => {
    const result = await Effect.runPromise(
      HerculeHome.pipe(Effect.provide(layer([`--home=${home}`], {})), Effect.result),
    );
    expect(Result.isSuccess(result) && result.success.home).toBe(home);
  });

  it("puts the Data Root where data.dir says, and creates nothing else", async () => {
    const elsewhere = join(home, "elsewhere");
    const { home: paths } = await loadOrFail(["-c", `data.dir=${elsewhere}`]);

    expect(paths.dataDir).toBe(elsewhere);
    expect(existsSync(elsewhere)).toBe(true);
    expect(existsSync(join(home, "data"))).toBe(false);
  });

  it("reports a malformed config file with its path and the parser's error", async () => {
    writeFileSync(join(home, "config.toml"), "bind.host = ?\n");

    const error = await loadAndReadFailure();
    expect(error._tag).toBe("ConfigFileError");
    expect(error).toMatchObject({ path: join(home, "config.toml") });
    expect(error.message).toContain("Expected a value");
  });

  it("reports a key the bootstrap config does not hold", async () => {
    writeFileSync(join(home, "config.toml"), 'bind.hots = "127.0.0.1"\n');

    const fromFile = await loadAndReadFailure();
    expect(fromFile._tag).toBe("ConfigFileError");
    expect(fromFile.message).toContain("bind.hots");

    rmSync(join(home, "config.toml"));
    const fromFlag = await loadAndReadFailure(["-c", "retention.events=30d"]);
    expect(fromFlag._tag).toBe("ConfigValueError");
    expect(fromFlag.message).toContain("retention.events");
  });

  it("reports the source and the value of an invalid setting", async () => {
    const error = await loadAndReadFailure(["-c", "bind.port=nope"]);
    expect(error._tag).toBe("ConfigValueError");
    expect(error.message).toContain("-c bind.port");
    expect(error.message).toContain('"nope"');

    const fromEnv = await loadAndReadFailure([], { HERCULE_LOG_LEVEL: "chatty" });
    expect(fromEnv.message).toContain("HERCULE_LOG_LEVEL");
    expect(fromEnv.message).toContain('"chatty"');

    writeFileSync(join(home, "config.toml"), "bind.port = 0\n");
    const fromFile = await loadAndReadFailure();
    expect(fromFile.message).toContain(join(home, "config.toml"));
    rmSync(join(home, "config.toml"));

    expect((await loadAndReadFailure(["-c", "bind.port=nope"]))._tag).toBe("ConfigValueError");
    expect((await loadAndReadFailure(["-c", "bind.port=0"]))._tag).toBe("ConfigValueError");
    expect((await loadAndReadFailure(["-c", "bind.port=4937.5"]))._tag).toBe("ConfigValueError");
    expect((await loadAndReadFailure(["-c", "log.level=chatty"]))._tag).toBe("ConfigValueError");
    expect((await loadAndReadFailure(["-c", "data.dir="]))._tag).toBe("ConfigValueError");
  });

  it("rejects a bind host that is not only a host", async () => {
    // `new URL` would parse this as the host `foo` with `/bar` on the end, and
    // the setup URL would be one nobody can open.
    const error = await loadAndReadFailure(["-c", "bind.host=foo/bar"]);
    expect(error._tag).toBe("ConfigValueError");
    expect(error.message).toContain("bind.host");
    expect(error.message).toContain('"foo/bar"');

    expect((await loadAndReadFailure(["-c", "bind.host=user@host"]))._tag).toBe("ConfigValueError");
    expect((await loadAndReadFailure(["-c", "bind.host=127.0.0.1:8080"]))._tag).toBe(
      "ConfigValueError",
    );
    expect((await loadAndReadFailure(["-c", "bind.host=http://127.0.0.1"]))._tag).toBe(
      "ConfigValueError",
    );
  });

  it("accepts the hosts hercule can actually bind", async () => {
    for (const host of ["127.0.0.1", "0.0.0.0", "::", "::1", "localhost", "hercule.local"]) {
      const config = await Effect.runPromise(
        BootstrapConfig.pipe(
          Effect.provide(layer(["--home", home, "-c", `bind.host=${host}`], {})),
        ),
      );
      expect(config.bindHost).toBe(host);
    }
  });

  it("rejects an argument hercule serve does not have", async () => {
    const result = await Effect.runPromise(
      HerculeHome.pipe(Effect.provide(layer(["--home", home, "--version"], {})), Effect.result),
    );
    expect(Result.isFailure(result) && result.failure._tag).toBe("InvalidOptionError");
    expect(Result.isFailure(result) && result.failure.message).toContain("usage: hercule serve");
    expect(existsSync(join(home, "config.toml"))).toBe(false);
  });

  it("reports a malformed global option", async () => {
    const result = await Effect.runPromise(
      HerculeHome.pipe(Effect.provide(layer(["--home", home, "-c", "oops"], {})), Effect.result),
    );
    expect(Result.isFailure(result) && result.failure._tag).toBe("InvalidOptionError");
  });
});
