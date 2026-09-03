import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Context, Effect, Schema } from "effect";
import { ConfigFileError, ConfigValueError } from "./errors";
import { formatToml, parseToml, type TomlScalar } from "./toml";

/** The log levels `log.level` accepts, ordered most to least severe. */
export const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * The bootstrap config: the only keys Hydra needs before the database can open
 * (spec 15 section 6). Everything else is controller state.
 */
export class BootstrapConfig extends Context.Service<
  BootstrapConfig,
  {
    readonly dataDir: string;
    readonly bindHost: string;
    readonly bindPort: number;
    readonly logLevel: LogLevel;
  }
>()("hydra/controller/config/BootstrapConfig") {}

/** The four bootstrap keys, in dotted TOML form. Nothing else may be added (spec 15 section 6). */
export const BOOTSTRAP_KEYS = ["data.dir", "bind.host", "bind.port", "log.level"] as const;

export type BootstrapKey = (typeof BOOTSTRAP_KEYS)[number];

/** The env form of a bootstrap key: uppercase, dots to underscores, `HYDRA_` prefix. */
export function envName(key: BootstrapKey): string {
  return `HYDRA_${key.toUpperCase().replaceAll(".", "_")}`;
}

/**
 * The defaults for a given home. `data.dir` is the only one that depends on it;
 * the values are TOML-typed, because these are what a first run writes into
 * `config.toml`.
 */
export function defaults(home: string): Record<BootstrapKey, TomlScalar> {
  return {
    "data.dir": join(home, "data"),
    "bind.host": "127.0.0.1",
    "bind.port": 4937,
    "log.level": "info",
  };
}

const BootstrapSchema = Schema.Struct({
  "data.dir": Schema.NonEmptyString,
  "bind.host": Schema.NonEmptyString,
  "bind.port": Schema.NumberFromString.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 1, maximum: 65535 }),
  ),
  "log.level": Schema.Literals(LOG_LEVELS),
});

const isBootstrapKey = (key: string): key is BootstrapKey =>
  (BOOTSTRAP_KEYS as ReadonlyArray<string>).includes(key);

const keyList = BOOTSTRAP_KEYS.join(", ");

/**
 * Read `config.toml`, writing it with the four keys at their defaults when it is
 * absent: a first run leaves behind the file it would have read (spec 15
 * sections 6 and 7). Returns the keys the file sets, as strings.
 */
export const loadConfigFile = Effect.fn("loadConfigFile")(function* (
  configFile: string,
  fileDefaults: Record<BootstrapKey, TomlScalar>,
) {
  const fail = (message: string) => new ConfigFileError({ path: configFile, message });

  if (!existsSync(configFile)) {
    yield* Effect.try({
      try: () => writeFileSync(configFile, formatToml(fileDefaults)),
      catch: () => fail("could not be written"),
    });
  }

  const text = yield* Effect.try({
    try: () => readFileSync(configFile, "utf8"),
    catch: () => fail("could not be read"),
  });

  const parsed = yield* Effect.fromResult(parseToml(text)).pipe(Effect.mapError(fail));

  const values: Partial<Record<BootstrapKey, string>> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!isBootstrapKey(key)) {
      return yield* fail(`unknown key ${key}; bootstrap config holds only ${keyList}`);
    }
    values[key] = String(value);
  }
  return values;
});

/**
 * Decide every bootstrap key: flag beats env beats file beats default (spec 15
 * section 6), then validate. A `-c` override of anything but a bootstrap key is
 * an error, never a silently ignored flag.
 */
export const resolveConfig = Effect.fn("resolveConfig")(function* (options: {
  readonly overrides: ReadonlyArray<readonly [key: string, value: string]>;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly file: Partial<Record<BootstrapKey, string>>;
  readonly defaults: Record<BootstrapKey, TomlScalar>;
}) {
  const flags: Partial<Record<BootstrapKey, string>> = {};
  for (const [key, value] of options.overrides) {
    if (!isBootstrapKey(key)) {
      return yield* new ConfigValueError({
        message: `-c ${key}=... is not a bootstrap key; bootstrap config holds only ${keyList}`,
      });
    }
    flags[key] = value;
  }

  const merged = Object.fromEntries(
    BOOTSTRAP_KEYS.map((key) => [
      key,
      flags[key] ?? options.env[envName(key)] ?? options.file[key] ?? String(options.defaults[key]),
    ]),
  );

  const decoded = yield* Schema.decodeUnknownEffect(BootstrapSchema)(merged).pipe(
    Effect.mapError((error) => new ConfigValueError({ message: error.message })),
  );

  return BootstrapConfig.of({
    dataDir: decoded["data.dir"],
    bindHost: decoded["bind.host"],
    bindPort: decoded["bind.port"],
    logLevel: decoded["log.level"],
  });
});
