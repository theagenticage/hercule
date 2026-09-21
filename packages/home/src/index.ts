/**
 * The Hercule Home: the global command-line options that locate it, and the
 * layout inside it.
 *
 * A leaf package on purpose. Every role needs to find the home, and the
 * dispatcher, the CLI and the runner must reach none of the controller's state
 * to do it.
 */
export { InvalidOptionError, parseGlobalOptions, type GlobalOptions } from "./args";
export {
  configFileIn,
  credentialsFileIn,
  DATABASE_FILE_NAME,
  DEFAULT_HOME_NAME,
  homePaths,
  resolveHomePath,
  runnerDirIn,
  setupUrlFileIn,
  type HomePaths,
} from "./paths";
