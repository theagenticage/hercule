/**
 * The bootstrap config in `config.toml`: the four keys every role may need
 * before anything else starts (spec 15 section 6). The controller reads all
 * four, the runner reads `log.level`, and `hercule service` reads `data.dir`
 * to find the controller database.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Context, Effect, Schema } from "effect";
import { locateConfigFile } from "./paths";
import { formatToml, parseToml, type TomlScalar } from "./toml";

/** `config.toml` could not be read, or is not the TOML subset Hercule writes. */
export class ConfigFileError extends Schema.TaggedError<ConfigFileError>()("ConfigFileError", {
  path: Schema.String,
  message: Schema.String,
}) {}

/** A bootstrap key holds a value Hercule cannot use (spec 15 section 6). */
export class ConfigValueError extends Schema.TaggedError<ConfigValueError>()("ConfigValueError", {
  message: Schema.String,
}) {}

/** The log levels `log.level` accepts, ordered most to least severe. */
export const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * The bootstrap config: the only keys Hercule needs before the database can open
 * (spec 15 section 6). Everything else is controller state.
 *
 * `dataDir` is the value as configured, which may be relative: it is resolved
 * against the Hercule Home by `buildHomePaths`, so a home that moves takes its Data
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
>()("hercule/home/BootstrapConfig") {}

/** The four bootstrap keys, in dotted TOML form. Nothing else may be added (spec 15 section 6). */
export const BOOTSTRAP_KEYS = ["data.dir", "bind.host", "bind.port", "log.level"] as const;

export type BootstrapKey = (typeof BOOTSTRAP_KEYS)[number];

/**
 * Returns the env var name for a bootstrap key: uppercase, dots to
 * underscores, and a `HERCULE_` prefix.
 */
export function buildEnvName(key: BootstrapKey): string {
  return `HERCULE_${key.toUpperCase().replaceAll(".", "_")}`;
}

/**
 * The values a first run writes into `config.toml`, with their TOML types.
 * `data.dir` is relative on purpose: the file must not be tied to the home it
 * was written in.
 */
export const DEFAULTS: Record<BootstrapKey, TomlScalar> = {
  "data.dir": "data",
  "bind.host": "127.0.0.1",
  "bind.port": 4937,
  "log.level": "info",
};

/**
 * Checks that a bind host is only a host: no scheme, no port, no path, no user.
 * `URL` is lenient enough to parse `foo/bar` as the host `foo` with a path on
 * the end, which would quietly produce a setup URL nobody can open. So the
 * check parses the value and verifies that nothing but the host was set.
 *
 * The check does not compare the parsed hostname with the input, because `URL`
 * also canonicalizes: it parses `127.1` as `127.0.0.1` and `0:0:0:0:0:0:0:1` as
 * `[::1]`, and both of those are hosts Hercule can bind.
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

/** The schema of each key's value, applied to the string chosen from the sources. */
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
 * Writes `config.toml` with the four keys at their defaults when it is absent,
 * so a controller's first run leaves behind the file it would have read (spec
 * 15 sections 6 and 7). Does nothing when the file exists. Fails with
 * `ConfigFileError` when the file cannot be written.
 *
 * Only the controller calls this. A runner or a `hercule service` command
 * reads the file when it is there and uses the defaults when it is not.
 */
export const writeDefaultConfigFile = Effect.fn("writeDefaultConfigFile")(function* (
  configFile: string,
) {
  if (existsSync(configFile)) return;
  yield* Effect.try({
    try: () => writeFileSync(configFile, formatToml(DEFAULTS)),
    catch: () => new ConfigFileError({ path: configFile, message: "could not be written" }),
  });
});

/**
 * Reads `config.toml` and returns the keys it sets, as strings. Returns no keys
 * when the file is absent. Fails with `ConfigFileError` when the file cannot be
 * read or parsed, or holds an unknown key.
 */
export const readConfigFile = Effect.fn("readConfigFile")(function* (configFile: string) {
  const createConfigFileError = (message: string) =>
    new ConfigFileError({ path: configFile, message });

  if (!existsSync(configFile)) return {};

  const text = yield* Effect.try({
    try: () => readFileSync(configFile, "utf8"),
    catch: () => createConfigFileError("could not be read"),
  });

  const parsed = yield* Effect.fromResult(parseToml(text)).pipe(
    Effect.mapError(createConfigFileError),
  );

  const values: Partial<Record<BootstrapKey, string>> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!isBootstrapKey(key)) {
      return yield* createConfigFileError(
        `unknown key ${key}; bootstrap config holds only ${keyList}`,
      );
    }
    values[key] = String(value);
  }
  return values;
});

/**
 * Chooses the value of every bootstrap key, then validates it, and returns the
 * `BootstrapConfig`. A `-c` flag beats an environment variable, which beats the
 * file, which beats the default (spec 15 section 6).
 *
 * Fails with `ConfigValueError` when:
 *
 * - a `-c` flag sets anything other than a bootstrap key, rather than silently
 *   ignoring the flag;
 * - a value is invalid, and the error message includes the source that set it.
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

  /** Returns a key's value and its source, so an error about the value can include the source. */
  const chooseValue = (key: BootstrapKey): { readonly value: string; readonly source: string } => {
    const flag = flags[key];
    if (flag !== undefined) return { value: flag, source: `-c ${key}` };
    const fromEnv = options.env[buildEnvName(key)];
    if (fromEnv !== undefined) return { value: fromEnv, source: buildEnvName(key) };
    const fromFile = options.file[key];
    if (fromFile !== undefined)
      return { value: fromFile, source: `${key} in ${options.configFile}` };
    return { value: String(DEFAULTS[key]), source: `the default for ${key}` };
  };

  const decode = <K extends BootstrapKey>(key: K): Effect.Effect<Value<K>, ConfigValueError> => {
    const { value, source } = chooseValue(key);
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

/**
 * Reads the bootstrap config of a Hercule Home: `config.toml` when it exists,
 * then the `-c` overrides and the `HERCULE_*` environment variables on top.
 * Returns the `BootstrapConfig`. Fails with `ConfigFileError` or
 * `ConfigValueError`, as `readConfigFile` and `resolveConfig` do.
 */
export const loadBootstrapConfig = Effect.fn("loadBootstrapConfig")(function* (options: {
  readonly home: string;
  readonly overrides: ReadonlyArray<readonly [key: string, value: string]>;
  readonly env: Readonly<Record<string, string | undefined>>;
}) {
  const configFile = locateConfigFile(options.home);
  const file = yield* readConfigFile(configFile);
  return yield* resolveConfig({
    overrides: options.overrides,
    env: options.env,
    file,
    configFile,
  });
});
