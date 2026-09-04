/**
 * The Hydra Home: the global command-line options that locate it, and the
 * layout inside it (spec 15 sections 5 and 6).
 *
 * A leaf package on purpose. Every role needs to find the home, and the
 * dispatcher, the CLI and the runner must reach none of the controller's state
 * to do it (spec 15 section 3, ADR 0018).
 */
export { InvalidOptionError, parseGlobalOptions, type GlobalOptions } from "./args";
export {
  configFileIn,
  credentialsFileIn,
  DATABASE_FILE_NAME,
  DEFAULT_HOME_NAME,
  homePaths,
  resolveHomePath,
  setupUrlFileIn,
  type HomePaths,
} from "./paths";
