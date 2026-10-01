/**
 * The Hercule Home: the global command-line options that locate it, the layout
 * inside it, and the bootstrap config in its `config.toml`. Also the binary
 * every role runs as, so that a role can start another one.
 *
 * This package has no Hercule dependencies on purpose. Every role needs to find
 * the home, and the dispatcher, the CLI and the runner must not import any of
 * the controller's state to do it.
 */
export { locateCompiledBinary } from "./binary";
export { InvalidOptionError, parseGlobalOptions, type GlobalOptions } from "./args";
export {
  locateConfigFile,
  locateCredentialsFile,
  DATABASE_FILE_NAME,
  DEFAULT_HOME_NAME,
  buildHomePaths,
  resolveHomePath,
  locateLogsDir,
  locateProcessLogFile,
  locateRunnerDir,
  locateRunnerFile,
  locateSetupUrlFile,
  type HomePaths,
  type ProcessLogName,
} from "./paths";
export {
  BOOTSTRAP_KEYS,
  BootstrapConfig,
  ConfigFileError,
  ConfigValueError,
  buildEnvName,
  loadBootstrapConfig,
  writeDefaultConfigFile,
  type LogLevel,
} from "./config";
