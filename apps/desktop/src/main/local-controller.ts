/**
 * Hercule on this Mac: at a launch with no controller URL saved, main looks
 * for Hercule's controller running here, and on the user's request starts
 * it as a Service Unit, through the installed binary. Spec 17 (§First run)
 * owns the rules.
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type { LocalControllerFindOutcome, LocalControllerStartOutcome } from "../ipc/contract";
import { AppSettings } from "./app-settings";
import { ControllerConnection } from "./controller-connection";
import { InstalledBinary, type ServiceReport } from "./installed-binary";
import { LoginShell } from "./login-shell-path";

/**
 * The error `find` and `start` fail with when a controller URL is saved:
 * the first run looks for Hercule only before one is. The message completes
 * a sentence, such as a refused IPC message's.
 */
export class ControllerAlreadySaved extends Data.TaggedError("ControllerAlreadySaved")<{
  readonly message: string;
}> {
  constructor() {
    super({
      message: "a controller URL is saved, and the app looks for Hercule only before one is",
    });
  }
}

/** The error `start` fails with while another start runs. */
export class StartAlreadyRunning extends Data.TaggedError("StartAlreadyRunning")<{
  readonly message: string;
}> {
  constructor() {
    super({ message: "Hercule is already being started; wait for that start to finish" });
  }
}

/** The error `showLogsFolder` fails with before the binary has reported a logs folder. */
export class NoLogsFolderSeen extends Data.TaggedError("NoLogsFolderSeen")<{
  readonly message: string;
}> {
  constructor() {
    super({ message: "the Hercule binary has not reported a logs folder yet" });
  }
}

/**
 * How long `hercule service install` may run. The command gives up by
 * itself after about a minute; this limit is for a command that hangs.
 */
const INSTALL_LIMIT = "90 seconds";

/** How long main waits for Hercule to answer once it was started. */
const ANSWER_LIMIT_MILLIS = 30_000;

/** How long main waits between two checks of whether Hercule answers. */
const ANSWER_POLL_INTERVAL = "500 millis";

/** Hercule on this Mac. */
export class LocalController extends Context.Service<
  LocalController,
  {
    /**
     * Looks for Hercule's controller on this Mac with `hercule service
     * status`. When the Service Unit runs it, or the default Hercule Home
     * names a controller that answers, main saves its URL and reloads the
     * window. Returns what main found; see LocalControllerFindOutcome.
     *
     * Fails with ControllerAlreadySaved when a controller URL is saved.
     */
    readonly find: Effect.Effect<LocalControllerFindOutcome, ControllerAlreadySaved>;

    /**
     * Starts Hercule's controller on this Mac with `hercule service install`,
     * with the `PATH` of the user's login shell, then waits up to 30 seconds
     * for it to answer and saves its URL. Installs nothing when the Service
     * Unit runs a runner. Returns what happened; see
     * LocalControllerStartOutcome.
     *
     * Fails with ControllerAlreadySaved when a controller URL is saved, and
     * with StartAlreadyRunning while another start runs: two installs at
     * once would race on one Service Unit.
     */
    readonly start: Effect.Effect<
      LocalControllerStartOutcome,
      ControllerAlreadySaved | StartAlreadyRunning
    >;

    /**
     * Opens in Finder the logs folder the binary last reported. Fails with
     * NoLogsFolderSeen before it has reported one.
     */
    readonly showLogsFolder: Effect.Effect<void, NoLogsFolderSeen>;
  }
>()("hercule/desktop/LocalController") {}

/**
 * Builds the service on the installed binary, the login shell and the
 * controller connection. `openFolder` opens a folder in Finder.
 */
export const makeLocalControllerLayer = (
  openFolder: (path: string) => Effect.Effect<void>,
): Layer.Layer<
  LocalController,
  never,
  AppSettings | ControllerConnection | InstalledBinary | LoginShell
> =>
  Layer.effect(LocalController)(
    Effect.gen(function* () {
      const settings = yield* AppSettings;
      const connection = yield* ControllerConnection;
      const binary = yield* InstalledBinary;
      const loginShell = yield* LoginShell;
      // The logs folder the binary reported last, from any command.
      let logsDir: string | null = null;
      let starting = false;

      /** Remembers the logs folder `report` names, and returns `report`. */
      const rememberLogsFolder = (report: ServiceReport): ServiceReport => {
        logsDir = report.logsDir;
        return report;
      };

      const refuseWhenSaved = Effect.gen(function* () {
        if ((yield* settings.readControllerUrl) !== null) {
          return yield* new ControllerAlreadySaved();
        }
      });

      /**
       * Checks `origin` every half second, for up to 30 seconds, until
       * Hercule answers there, and saves its URL then. Returns whether it
       * saved it.
       */
      const waitForAnswer = (origin: string): Effect.Effect<boolean> =>
        Effect.gen(function* () {
          const deadline = (yield* Clock.currentTimeMillis) + ANSWER_LIMIT_MILLIS;
          while (true) {
            if (yield* connection.saveIfAnswering(origin)) return true;
            if ((yield* Clock.currentTimeMillis) >= deadline) return false;
            yield* Effect.sleep(ANSWER_POLL_INTERVAL);
          }
        });

      /** Starts Hercule; see `start`. Runs once the checks have passed. */
      const startOnce: Effect.Effect<LocalControllerStartOutcome> = Effect.gen(function* () {
        const status = yield* binary.readStatus.pipe(Effect.map(rememberLogsFolder), Effect.result);
        if (status._tag === "Failure") {
          return status.failure._tag === "BinaryNotFound"
            ? ({ _tag: "NotInstalled" } as const)
            : ({ _tag: "StartError", line: status.failure.line } as const);
        }
        // Installing over a runner would restart it and end its sessions.
        if (status.success.role === "runner") {
          return { _tag: "Runner", running: status.success.running } as const;
        }

        const path = yield* loginShell.readPath.pipe(Effect.result);
        if (path._tag === "Failure")
          return { _tag: "StartError", line: path.failure.reason } as const;

        const installed = yield* binary
          .install(path.success)
          .pipe(Effect.map(rememberLogsFolder), Effect.timeoutOption(INSTALL_LIMIT), Effect.result);
        if (installed._tag === "Failure") {
          return installed.failure._tag === "BinaryNotFound"
            ? ({ _tag: "NotInstalled" } as const)
            : ({ _tag: "StartError", line: installed.failure.line } as const);
        }
        if (Option.isNone(installed.success)) {
          // The command hung and was stopped, so it reported nothing; the
          // Home's address is the one the status reported before.
          const address = status.success.controllerUrl;
          return address === null
            ? ({
                _tag: "StartError",
                line: "`hercule service install` did not finish within 90 seconds, so the app stopped it.",
              } as const)
            : ({ _tag: "NoAnswer", address, logsDir: status.success.logsDir } as const);
        }
        const report = installed.success.value;
        if (report.role === "runner") return { _tag: "Runner", running: report.running } as const;
        if (report.controllerUrl === null) {
          return {
            _tag: "StartError",
            line: "Hercule was started, but its config.toml names no address the app can open. Run `hercule service status` in Terminal to see why.",
          } as const;
        }
        return (yield* waitForAnswer(report.controllerUrl))
          ? ({ _tag: "Saved", origin: report.controllerUrl } as const)
          : ({ _tag: "NoAnswer", address: report.controllerUrl, logsDir: report.logsDir } as const);
      });

      return LocalController.of({
        find: Effect.gen(function* () {
          yield* refuseWhenSaved;
          const status = yield* binary.readStatus.pipe(
            Effect.map(rememberLogsFolder),
            Effect.result,
          );
          if (status._tag === "Failure") {
            return {
              _tag: "Fresh",
              problem: status.failure._tag === "BinaryNotFound" ? null : status.failure.line,
            } as const;
          }
          const { role, running, controllerUrl } = status.success;
          if (role === "runner") return { _tag: "Runner", running } as const;
          if (controllerUrl === null) return { _tag: "Fresh", problem: null } as const;
          return (yield* connection.saveIfAnswering(controllerUrl))
            ? ({ _tag: "Saved", origin: controllerUrl } as const)
            : ({ _tag: "Fresh", problem: null } as const);
        }),
        start: Effect.gen(function* () {
          yield* refuseWhenSaved;
          if (starting) return yield* new StartAlreadyRunning();
          starting = true;
          return yield* startOnce.pipe(
            Effect.ensuring(
              Effect.sync(() => {
                starting = false;
              }),
            ),
          );
        }),
        showLogsFolder: Effect.suspend(() =>
          logsDir === null ? Effect.fail(new NoLogsFolderSeen()) : openFolder(logsDir),
        ),
      });
    }),
  );
