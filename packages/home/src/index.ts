/**
 * The Hercule Home: the global command-line options that locate it, the layout
 * inside it, and the bootstrap config in its `config.toml`.
 *
 * This package has no Hercule dependencies on purpose. Every role needs to find
 * the home, and the dispatcher, the CLI and the runner must not import any of
 * the controller's state to do it.
 */
export { InvalidOptionError, parseGlobalOptions, type GlobalOptions } from "./args";
export {
  locateConfigFile,
  locateCredentialsFile,
  DATABASE_FILE_NAME,
  DEFAULT_HOME_NAME,
  buildHomePaths,
  resolveHomePath,
  locateLogsDir,
  locateRunnerDir,
  locateSetupUrlFile,
  type HomePaths,
} from "./paths";
export {
  BOOTSTRAP_KEYS,
  BootstrapConfig,
  ConfigFileError,
  ConfigValueError,
  DEFAULTS,
  LOG_LEVELS,
  buildEnvName,
  loadBootstrapConfig,
  readConfigFile,
  resolveConfig,
  writeDefaultConfigFile,
  type BootstrapKey,
  type LogLevel,
} from "./config";
export { formatToml, parseToml, type TomlScalar } from "./toml";
