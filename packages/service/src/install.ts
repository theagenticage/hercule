/**
 * Installing the unit: the refusals that run before the Supervisor is asked,
 * and the two steps `hercule service install` and `hercule runner join` share.
 */
import { statSync } from "node:fs";
import { dirname } from "node:path";
import { Effect } from "effect";
import {
  BOOTSTRAP_KEYS,
  buildEnvName,
  locateConfigFile,
  type ConfigOverrides,
  type Env,
} from "@hercule/home";
import { ServiceError, Supervisor, type ServiceStatus } from "./supervisor";
import { buildServicePath, buildServiceUnit, type ServiceRole, type ServiceUnit } from "./unit";

/** What `installService` installs, and the command line it was asked from. */
export interface ServiceInstallRequest {
  readonly role: ServiceRole;
  /** The absolute Hercule Home the unit runs. */
  readonly home: string;
  readonly overrides: ConfigOverrides;
  readonly env: Env;
  /** The compiled binary the unit runs, from `locateCompiledBinary`. */
  readonly program: string | undefined;
}

/**
 * Fails when the command line has a `-c` flag. A flag changes only the
 * process it is given to, and the service process reads only `config.toml`,
 * so the user would not get the setting they asked for.
 */
export const refuseConfigFlags = (
  home: string,
  overrides: ConfigOverrides,
): Effect.Effect<void, ServiceError> => {
  const flag = overrides[0];
  if (flag === undefined) return Effect.void;
  const [key, value] = flag;
  return Effect.fail(
    new ServiceError({
      message: `-c ${key}=${value} applies only to this command, and the service reads only ${locateConfigFile(home)}. Put ${key} in that file instead, then run this again without -c.`,
    }),
  );
};

/**
 * Fails when the environment sets a bootstrap key. The unit runs with none of
 * them, so the service would quietly run with other settings than the ones
 * the user has.
 *
 * `HERCULE_HOME` is not a bootstrap key: it chooses the Home, and the unit
 * carries the Home it was installed for.
 */
const refuseConfigVariables = (home: string, env: Env): Effect.Effect<void, ServiceError> => {
  const key = BOOTSTRAP_KEYS.find((each) => env[buildEnvName(each)] !== undefined);
  if (key === undefined) return Effect.void;
  const name = buildEnvName(key);
  return Effect.fail(
    new ServiceError({
      message: `${name} is set, and the service reads only ${locateConfigFile(home)}. Put ${key} in that file instead, then unset ${name} and run this again.`,
    }),
  );
};

/**
 * Fails when a path has a control character. A line break in a path would
 * end the line of a systemd unit early and let the rest of the path add a
 * setting of its own.
 */
const refuseControlCharacters = (label: string, path: string): Effect.Effect<void, ServiceError> =>
  [...path].some((character) => character < " " || character === "\x7f")
    ? Effect.fail(
        new ServiceError({
          message: `${label} ${JSON.stringify(path)} has a control character, which a unit file cannot hold. Use a path without one.`,
        }),
      )
    : Effect.void;

/**
 * Checks whether every user of this machine can write to a path. Returns
 * false for a path that cannot be read, because it holds no program the
 * service could run.
 */
const isWorldWritable = (path: string): boolean => {
  try {
    return (statSync(path).mode & 0o002) !== 0;
  } catch {
    return false;
  }
};

/**
 * Fails when other users of this machine could change what the service runs:
 * when they can write to the binary, to its folder, or to a folder on the
 * PATH the service runs with. The service runs as this user, so a program
 * another user put there would run with this user's credentials.
 *
 * A folder that only a group can write to passes, because Homebrew's
 * `/usr/local/bin` is writable by the `admin` group.
 */
const refuseWorldWritablePaths = (unit: ServiceUnit): Effect.Effect<void, ServiceError> =>
  Effect.gen(function* () {
    for (const path of [unit.program, dirname(unit.program)]) {
      if (isWorldWritable(path)) {
        return yield* new ServiceError({
          message: `Every user on this machine can write to ${path}, so anyone could change the program the service runs. Run \`chmod o-w ${path}\`, then run this again.`,
        });
      }
    }
    const folder = unit.path.split(":").find(isWorldWritable);
    if (folder !== undefined) {
      return yield* new ServiceError({
        message: `${folder} is on the PATH the service runs with, and every user on this machine can write to it, so anyone could put a program there that the service runs. Remove ${folder} from PATH, or run \`chmod o-w ${folder}\`, then run this again.`,
      });
    }
  });

/**
 * Validates a request without asking the Supervisor, and returns the unit it
 * installs. Fails with `ServiceError` when:
 *
 * - Hercule runs from a source checkout rather than the compiled binary;
 * - a `-c` flag or a `HERCULE_*` bootstrap variable is set;
 * - the binary, the Home or the PATH has a control character;
 * - other users can write to the binary, its folder, or a folder on the PATH.
 *
 * The unit is built once here, so the PATH these checks read is the PATH the
 * unit is written with.
 */
const validateServiceInstall = (
  request: ServiceInstallRequest,
): Effect.Effect<ServiceUnit, ServiceError> =>
  Effect.gen(function* () {
    const program = request.program;
    if (program === undefined) {
      return yield* new ServiceError({
        message:
          "A service runs the compiled hercule binary, and this Hercule runs from a source checkout. Build the binary with `pnpm build:binary` and run `./hercule service install`.",
      });
    }
    yield* refuseConfigFlags(request.home, request.overrides);
    yield* refuseConfigVariables(request.home, request.env);
    const unit = buildServiceUnit({
      role: request.role,
      program,
      home: request.home,
      path: buildServicePath(request.env["PATH"]),
    });
    yield* refuseControlCharacters("The binary", unit.program);
    yield* refuseControlCharacters("The Hercule Home", unit.home);
    yield* refuseControlCharacters("The PATH", unit.path);
    yield* refuseWorldWritablePaths(unit);
    return unit;
  });

/**
 * Runs every check `installService` runs, and the Supervisor's `prepare`,
 * without writing a unit. `hercule runner join` runs this before it spends
 * its join token, so a refusal leaves the token unused. On Linux, `prepare`
 * turns lingering on. Fails with the errors of `installService`.
 */
export const prepareServiceInstall = (
  request: ServiceInstallRequest,
): Effect.Effect<void, ServiceError, Supervisor> =>
  Effect.gen(function* () {
    const unit = yield* validateServiceInstall(request);
    const supervisor = yield* Supervisor;
    yield* supervisor.prepare(unit);
  });

/**
 * Installs and (re)starts the unit that runs `request.role` for
 * `request.home`, and returns the status once the process runs. Fails with
 * `ServiceError` when a check in `validateServiceInstall` refuses the request,
 * or when the Supervisor refuses or fails, for example because the installed
 * unit runs another Hercule Home.
 */
export const installService = (
  request: ServiceInstallRequest,
): Effect.Effect<ServiceStatus, ServiceError, Supervisor> =>
  Effect.gen(function* () {
    const unit = yield* validateServiceInstall(request);
    const supervisor = yield* Supervisor;
    return yield* supervisor.install(unit);
  });
