import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Context, Effect, Schema } from "effect";
import { ConfigFileError, ConfigValueError } from "./errors";
import { formatToml, parseToml, type TomlScalar } from "./toml";

/** The log levels `log.level` accepts, ordered most to least severe. */
export const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * The bootstrap config: the only keys Hercule needs before the database can open
 * (spec 15 section 6). Everything else is controller state.
 *
 * `dataDir` is the value as configured, which may be relative: it is resolved
 * against the Hercule Home by `homePaths`, so a home that moves takes its Data
 * Root with it (spec 04, Relocatable Data Root).
 */
export class BootstrapConfig extends Context.Service<
  BootstrapConfig,
  {
    readonly dataDir: string;
    readonly bindHost: string;
    readonly bindPort: number;
    readonly logLevel: LogLevel;
  }
>()("hercule/controller/config/BootstrapConfig") {}

/** The four bootstrap keys, in dotted TOML form. Nothing else may be added (spec 15 section 6). */
export const BOOTSTRAP_KEYS = ["data.dir", "bind.host", "bind.port", "log.level"] as const;

export type BootstrapKey = (typeof BOOTSTRAP_KEYS)[number];

/** The env form of a bootstrap key: uppercase, dots to underscores, `HERCULE_` prefix. */
export function envName(key: BootstrapKey): string {
  return `HERCULE_${key.toUpperCase().replaceAll(".", "_")}`;
}

/**
 * The values a first run writes into `config.toml`, TOML-typed. `data.dir` is
 * relative on purpose: the file must not pin the home it was written in.
 */
export const DEFAULTS: Record<BootstrapKey, TomlScalar> = {
  "data.dir": "data",
  "bind.host": "127.0.0.1",
  "bind.port": 4937,
  "log.level": "info",
};

/**
 * A bind host is a whole host and nothing else: no scheme, no port, no path, no
 * user. `URL` is lenient enough to read `foo/bar` as the host `foo` with a path
 * on the end, which would quietly turn the setup URL into one nobody can open,
 * so what it made of the value is checked against what it was given.
 *
 * The check is structural rather than an equality on the hostname, because
 * `URL` also canonicalizes: it reads `127.1` as `127.0.0.1` and `0:0:0:0:0:0:0:1`
 * as `[::1]`, and both of those are hosts Hercule can bind.
 */
const isBindHost = (host: string): boolean => {
  const authority = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  try {
    const url = new URL(`http://${authority}:4937`);
    return (
      url.hostname !== "" &&
      url.port === "4937" &&
      url.pathname === "/" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
};

/** The schema of each key's value, applied to the string the sources agreed on. */
const SCHEMAS = {
  "data.dir": Schema.NonEmptyString,
  "bind.host": Schema.NonEmptyString.check(
    Schema.makeFilter(
      (host: string) =>
        isBindHost(host) ||
        "a bind host is a hostname or an IP address on its own, with no scheme, port, path or user",
    ),
  ),
  "bind.port": Schema.NumberFromString.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 1, maximum: 65535 }),
  ),
  "log.level": Schema.Literals(LOG_LEVELS),
} as const;

type Value<K extends BootstrapKey> = Schema.Schema.Type<(typeof SCHEMAS)[K]>;

const isBootstrapKey = (key: string): key is BootstrapKey =>
  (BOOTSTRAP_KEYS as ReadonlyArray<string>).includes(key);

const keyList = BOOTSTRAP_KEYS.join(", ");

/**
 * Read `config.toml`, writing it with the four keys at their defaults when it is
 * absent: a first run leaves behind the file it would have read (spec 15
 * sections 6 and 7). Returns the keys the file sets, as strings.
 */
export const loadConfigFile = Effect.fn("loadConfigFile")(function* (configFile: string) {
  const fail = (message: string) => new ConfigFileError({ path: configFile, message });

  if (!existsSync(configFile)) {
    yield* Effect.try({
      try: () => writeFileSync(configFile, formatToml(DEFAULTS)),
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
 * an error, never a silently ignored flag, and a value that will not do names
 * the source that set it.
 */
export const resolveConfig = Effect.fn("resolveConfig")(function* (options: {
  readonly overrides: ReadonlyArray<readonly [key: string, value: string]>;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly file: Partial<Record<BootstrapKey, string>>;
  readonly configFile: string;
}) {
  const flags: Partial<Record<BootstrapKey, string>> = {};
  for (const [key, value] of options.overrides) {
    if (!isBootstrapKey(key)) {
      return yield* new ConfigValueError({
        message: `-c ${key}=${value} is not a bootstrap key; bootstrap config holds only ${keyList}`,
      });
    }
    flags[key] = value;
  }

  /** Where a key's value came from, so an unusable one names its source. */
  const chosen = (key: BootstrapKey): { readonly value: string; readonly source: string } => {
    const flag = flags[key];
    if (flag !== undefined) return { value: flag, source: `-c ${key}` };
    const fromEnv = options.env[envName(key)];
    if (fromEnv !== undefined) return { value: fromEnv, source: envName(key) };
    const fromFile = options.file[key];
    if (fromFile !== undefined)
      return { value: fromFile, source: `${key} in ${options.configFile}` };
    return { value: String(DEFAULTS[key]), source: `the default for ${key}` };
  };

  const decode = <K extends BootstrapKey>(key: K): Effect.Effect<Value<K>, ConfigValueError> => {
    const { value, source } = chosen(key);
    const schema = SCHEMAS[key] as unknown as Schema.Codec<Value<K>, string>;
    return Schema.decodeUnknownEffect(schema)(value).pipe(
      Effect.mapError(
        (error) =>
          new ConfigValueError({
            message: `${source} is ${JSON.stringify(value)}, which Hercule cannot use: ${error.message}`,
          }),
      ),
    );
  };

  return BootstrapConfig.of({
    dataDir: yield* decode("data.dir"),
    bindHost: yield* decode("bind.host"),
    bindPort: yield* decode("bind.port"),
    logLevel: yield* decode("log.level"),
  });
});
