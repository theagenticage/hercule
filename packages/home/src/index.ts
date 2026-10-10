/**
 * The Hercule Home: the global command-line options that locate it, the layout
 * inside it, the bootstrap config in its `config.toml`, and the address a
 * process on this machine opens the controller at. Also the binary every role
 * runs as, so that a role can start another one.
 *
 * This package has no Hercule dependencies on purpose. Every role needs to find
 * the home, and the dispatcher, the CLI and the runner must not import any of
 * the controller's state to do it.
 */
export { locateCompiledBinary } from "./binary";
export { buildControllerOrigin, isLoopbackHost, isWildcardHost } from "./origin";
export {
  InvalidOptionError,
  parseGlobalOptions,
  type ConfigOverrides,
  type Env,
  type GlobalOptions,
} from "./args";
export {
  locateConfigFile,
  locateCredentialsFile,
  DATABASE_FILE_NAME,
  DEFAULT_HOME_NAME,
  buildHomePaths,
  resolveHomePath,
  resolveHomePathToActOn,
  isInSession,
  locateLogsDir,
  locateProcessLogFile,
  locateRunnerDir,
  locateRunnerFile,
  locateSetupUrlFile,
  locateStderrLogFile,
  type DaemonRole,
  type HomePaths,
} from "./paths";
export {
  BOOTSTRAP_KEYS,
  BootstrapConfig,
  ConfigFileError,
  ConfigValueError,
  buildEnvName,
  holdsControllerDatabase,
  loadBootstrapConfig,
  writeDefaultConfigFile,
  type LogLevel,
} from "./config";
