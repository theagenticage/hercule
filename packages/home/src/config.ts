/**
 * The bootstrap config in `config.toml`: the five keys every role may need
 * before anything else starts (spec 15 section 6). The controller reads all
 * five, and the runner reads `log.level`. `hercule service` reads `data.dir`
 * to find the controller database, and `bind.host` and `bind.port` to report
 * the address the controller is opened at.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Context, Effect, Schema } from "effect";
import type { ConfigOverrides, Env } from "./args";
import { bracketIpv6 } from "./origin";
import { buildHomePaths, locateConfigFile } from "./paths";
import { formatToml, parseToml, type TomlScalar } from "./toml";

/**
 * `config.toml` could not be read, or is not the TOML subset Hercule writes.
 * The message starts with the path of the file, so every role prints it as it
 * is.
 */
export class ConfigFileError extends Schema.TaggedError<ConfigFileError>()("ConfigFileError", {
  message: Schema.String,
}) {}

/** A bootstrap key holds a value Hercule cannot use (spec 15 section 6). */
export class ConfigValueError extends Schema.TaggedError<ConfigValueError>()("ConfigValueError", {
  message: Schema.String,
}) {}

/** The log levels `log.level` accepts, ordered most to least severe. */
const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace"] as const;

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
    /**
     * Where to send traces over OTLP/HTTP, as the collector's base URL, such as
     * `http://127.0.0.1:4318`; traces go to `<base>/v1/traces`. Undefined when
     * telemetry is off, which is the default.
     */
    readonly otlpEndpoint: string | undefined;
  }
>()("hercule/home/BootstrapConfig") {}

/**
 * The five bootstrap keys, in dotted TOML form. Nothing may be added unless a
 * role needs it before the database opens (spec 15 section 6).
 * `telemetry.otlp_endpoint` meets that test: tracing has to start before the
 * database opens, so that the boot and the migrations are traced too.
 */
export const BOOTSTRAP_KEYS = [
  "data.dir",
  "bind.host",
  "bind.port",
  "log.level",
  "telemetry.otlp_endpoint",
] as const;

type BootstrapKey = (typeof BOOTSTRAP_KEYS)[number];

/**
 * Returns the env var name for a bootstrap key: uppercase, dots to
 * underscores, and a `HERCULE_` prefix.
 */
export function buildEnvName(key: BootstrapKey): string {
  return `HERCULE_${key.toUpperCase().replaceAll(".", "_")}`;
}

/**
 * The OpenTelemetry standard's environment variable for a bootstrap key, when
 * the standard has one. It is read after every Hercule source, so a value set
 * the Hercule way wins. An empty value counts as unset, as the OpenTelemetry
 * specification says.
 */
const STANDARD_ENV_NAMES: Partial<Record<BootstrapKey, string>> = {
  "telemetry.otlp_endpoint": "OTEL_EXPORTER_OTLP_ENDPOINT",
};

/**
 * Every environment variable that sets a bootstrap key, with the key it sets:
 * the `HERCULE_` variable of each key, and the OpenTelemetry standard's
 * variable where there is one. `emptyIsUnset` is true for the standard's,
 * whose empty value counts as unset. A service unit runs with none of them,
 * so `hercule service` refuses each one that is set and the systemd unit
 * unsets them all.
 */
export const BOOTSTRAP_ENV_VARIABLES: ReadonlyArray<{
  readonly key: BootstrapKey;
  readonly name: string;
  readonly emptyIsUnset: boolean;
}> = BOOTSTRAP_KEYS.flatMap((key) => {
  const standard = STANDARD_ENV_NAMES[key];
  return [
    { key, name: buildEnvName(key), emptyIsUnset: false },
    ...(standard === undefined ? [] : [{ key, name: standard, emptyIsUnset: true }]),
  ];
});

/**
 * The values a first run writes into `config.toml`, with their TOML types.
 * `data.dir` is relative on purpose: the file must not be tied to the home it
 * was written in. `telemetry.otlp_endpoint` has no default: telemetry is off
 * until a user turns it on, so the file is written without it.
 */
const DEFAULTS = {
  "data.dir": "data",
  "bind.host": "127.0.0.1",
  "bind.port": 4937,
  "log.level": "info",
} as const satisfies Partial<Record<BootstrapKey, TomlScalar>>;

/** A bootstrap key that has a default, so it always has a value. */
type DefaultedKey = keyof typeof DEFAULTS;

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
  try {
    const url = new URL(`http://${bracketIpv6(host)}:4937`);
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

/**
 * Checks that an OTLP endpoint is an `http` or `https` URL with nothing after
 * its path: the traces path is appended to it, so a query or a fragment would
 * end up in the wrong place.
 */
const isOtlpEndpoint = (endpoint: string): boolean => {
  try {
    const url = new URL(endpoint);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
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
  "telemetry.otlp_endpoint": Schema.NonEmptyString.check(
    Schema.makeFilter(
      (endpoint: string) =>
        isOtlpEndpoint(endpoint) ||
        "an OTLP endpoint is the collector's http or https URL, such as http://127.0.0.1:4318, with no query",
    ),
  ),
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
    catch: () => new ConfigFileError({ message: `${configFile} could not be written` }),
  });
});

/**
 * Reads `config.toml` and returns the keys it sets, as strings. Returns no keys
 * when the file is absent. Fails with `ConfigFileError` when the file cannot be
 * read or parsed, or holds an unknown key.
 */
const readConfigFile = Effect.fn("readConfigFile")(function* (configFile: string) {
  const createConfigFileError = (reason: string) =>
    new ConfigFileError({ message: `${configFile} ${reason}` });

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
 * file, which beats the OpenTelemetry standard's variable for the key, if it
 * has one, which beats the default (spec 15 section 6). A key with no value
 * from any source and no default, `telemetry.otlp_endpoint`, is undefined.
 *
 * Fails with `ConfigValueError` when:
 *
 * - a `-c` flag sets anything other than a bootstrap key, rather than silently
 *   ignoring the flag;
 * - a value is invalid, and the error message includes the source that set it.
 */
const resolveConfig = Effect.fn("resolveConfig")(function* (options: {
  readonly overrides: ConfigOverrides;
  readonly env: Env;
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

  /**
   * Returns the value a source sets for a key, with the source, so an error
   * about the value can name it. Returns undefined when no source sets it.
   */
  const chooseSetValue = (
    key: BootstrapKey,
  ): { readonly value: string; readonly source: string } | undefined => {
    const flag = flags[key];
    if (flag !== undefined) return { value: flag, source: `-c ${key}` };
    const fromEnv = options.env[buildEnvName(key)];
    if (fromEnv !== undefined) return { value: fromEnv, source: buildEnvName(key) };
    const fromFile = options.file[key];
    if (fromFile !== undefined)
      return { value: fromFile, source: `${key} in ${options.configFile}` };
    const standard = STANDARD_ENV_NAMES[key];
    const fromStandard = standard === undefined ? undefined : options.env[standard];
    if (standard !== undefined && fromStandard !== undefined && fromStandard !== "")
      return { value: fromStandard, source: standard };
    return undefined;
  };

  /** Decodes a value chosen for `key`, naming its source when the value is invalid. */
  const decodeChosen = <K extends BootstrapKey>(
    key: K,
    { value, source }: { readonly value: string; readonly source: string },
  ): Effect.Effect<Value<K>, ConfigValueError> => {
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

  /** Decodes a key that has a default, so it always has a value. */
  const decode = <K extends DefaultedKey>(key: K): Effect.Effect<Value<K>, ConfigValueError> =>
    decodeChosen(
      key,
      chooseSetValue(key) ?? { value: String(DEFAULTS[key]), source: `the default for ${key}` },
    );

  /** Decodes a key with no default. Returns undefined when no source sets it. */
  const decodeOptional = <K extends BootstrapKey>(
    key: K,
  ): Effect.Effect<Value<K> | undefined, ConfigValueError> => {
    const chosen = chooseSetValue(key);
    return chosen === undefined ? Effect.succeed(undefined) : decodeChosen(key, chosen);
  };

  return BootstrapConfig.of({
    dataDir: yield* decode("data.dir"),
    bindHost: yield* decode("bind.host"),
    bindPort: yield* decode("bind.port"),
    logLevel: yield* decode("log.level"),
    otlpEndpoint: yield* decodeOptional("telemetry.otlp_endpoint"),
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
  readonly overrides: ConfigOverrides;
  readonly env: Env;
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

/**
 * Checks whether a Hercule Home holds a controller database. Fails with
 * `ConfigFileError` or `ConfigValueError` when the Home's `config.toml`
 * cannot be used.
 *
 * The database is located with `config.toml` alone, without `-c` flags or
 * environment variables, because a service unit sees only `config.toml`.
 */
export const holdsControllerDatabase = (
  home: string,
): Effect.Effect<boolean, ConfigFileError | ConfigValueError> =>
  Effect.map(loadBootstrapConfig({ home, overrides: [], env: {} }), (config) =>
    existsSync(buildHomePaths(home, config.dataDir).databaseFile),
  );
