/**
 * `hercule service`: the one OS service unit per machine that keeps Hercule
 * running across logins and reboots (spec 15 section 4). A launchd
 * LaunchAgent on macOS, a systemd user unit on Linux.
 *
 * This package is a role of the binary: the dispatcher hands it every
 * `hercule service` command line through `run`. `hercule runner join`
 * installs the runner's unit through `prepareServiceInstall` and
 * `installService`. This package links only `@hercule/home` and `effect`,
 * because the runner's import graph reaches it.
 */
export { describeStatus, run } from "./command";
export { installService, prepareServiceInstall, type ServiceInstallRequest } from "./install";
export { makeSupervisorLayer } from "./platform";
export { ServiceError, Supervisor } from "./supervisor";
