/**
 * Hercule on this Mac: at a launch with no controller URL saved, main looks
 * for Hercule's controller running here, and on the user's request starts
 * it as a Service Unit, through the installed binary. Spec 17 (§First run)
 * owns the rules.
 */
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import type { LocalControllerFindOutcome, LocalControllerStartOutcome } from "../ipc/contract";
import { AppSettings } from "./app-settings";
import { ControllerConnection, isAnswering } from "./controller-connection";
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
const INSTALL_TIME_LIMIT = "90 seconds";

/** How long main waits for Hercule to answer once it was started. */
const ANSWER_TIME_LIMIT = "30 seconds";

/** How long main waits between two checks of whether Hercule answers. */
const ANSWER_CHECK_INTERVAL = "500 millis";

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
     * Unit runs a runner, or runs Hercule already: installing would restart
     * it, and end the sessions it hosts. Returns what happened; see
     * LocalControllerStartOutcome.
     *
     * Fails with ControllerAlreadySaved when a controller URL is saved.
     */
    readonly start: Effect.Effect<LocalControllerStartOutcome, ControllerAlreadySaved>;

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
 *
 * `find` and `start` run one at a time, and a second waits for the first.
 * A reload of the window while Hercule starts runs `find` again, and both
 * would otherwise save the URL and reload the window. The second one then
 * finds the URL saved, and is refused.
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
      const oneAtATime = yield* Semaphore.make(1);
      // The logs folder the binary reported last, from any command.
      let logsFolder: string | null = null;

      /** Remembers the logs folder `report` names, and returns `report`. */
      const rememberLogsFolder = (report: ServiceReport): ServiceReport => {
        logsFolder = report.logsDir;
        return report;
      };

      const refuseWhenControllerSaved = Effect.gen(function* () {
        if ((yield* settings.readControllerUrl) !== null) {
          return yield* new ControllerAlreadySaved();
        }
      });

      /**
       * Looks for Hercule's controller on this Mac, as `find` does, and saves
       * nothing. Returns `Answering` with the controller's origin when the
       * connect check passes there, set up or not.
       */
      const findController: Effect.Effect<
        | Exclude<LocalControllerFindOutcome, { readonly _tag: "Saved" }>
        | { readonly _tag: "Answering"; readonly origin: string }
      > = Effect.gen(function* () {
        const status = yield* binary.readStatus.pipe(Effect.map(rememberLogsFolder), Effect.result);
        if (status._tag === "Failure") {
          return {
            _tag: "NotFound",
            line: status.failure._tag === "BinaryNotFound" ? null : status.failure.line,
          } as const;
        }
        const { role, running, controllerUrl } = status.success;
        if (role === "runner") return { _tag: "Runner", running } as const;
        if (controllerUrl === null) return { _tag: "NotFound", line: null } as const;
        return isAnswering(yield* connection.check(controllerUrl))
          ? ({ _tag: "Answering", origin: controllerUrl } as const)
          : ({ _tag: "NotFound", line: null } as const);
      });

      /**
       * Checks the controller `report` names every half second, while
       * nothing answers, for up to 30 seconds, and saves its URL once it
       * answers. Returns `Saved`; `NoAnswer` when nothing answered in time;
       * the check's outcome when something answered that is not a
       * controller the app can connect to; or `StartFailed` when `report`
       * names no controller.
       */
      const saveWhenAnswering = (
        report: ServiceReport,
      ): Effect.Effect<LocalControllerStartOutcome> =>
        Effect.gen(function* () {
          const origin = report.controllerUrl;
          if (origin === null) {
            return {
              _tag: "StartFailed",
              line: "Hercule was started, but its config.toml names no address the app can open. Run `hercule service status` in Terminal to see why.",
            } as const;
          }
          const outcome = yield* connection.check(origin).pipe(
            Effect.repeat({
              while: (outcome) => outcome._tag === "Unreachable",
              schedule: Schedule.spaced(ANSWER_CHECK_INTERVAL),
            }),
            Effect.timeoutOrElse({
              duration: ANSWER_TIME_LIMIT,
              orElse: () => Effect.succeed({ _tag: "Unreachable" } as const),
            }),
          );
          if (outcome._tag === "Unreachable") {
            return { _tag: "NoAnswer", origin, logsFolder: report.logsDir } as const;
          }
          if (!isAnswering(outcome)) return { ...outcome, origin };
          yield* connection.saveAndReload(origin);
          return { _tag: "Saved", origin } as const;
        });

      /** Starts Hercule's controller; see `start`. */
      const startController: Effect.Effect<LocalControllerStartOutcome> = Effect.gen(function* () {
        const status = yield* binary.readStatus.pipe(Effect.map(rememberLogsFolder), Effect.result);
        if (status._tag === "Failure") {
          return status.failure._tag === "BinaryNotFound"
            ? ({ _tag: "NotInstalled" } as const)
            : ({ _tag: "StartFailed", line: status.failure.line } as const);
        }
        const { role, running } = status.success;
        // Installing over a runner would restart it and end its sessions.
        if (role === "runner") return { _tag: "Runner", running } as const;
        // Installing again would restart Hercule, and end the sessions its
        // local runner hosts, so a running Hercule is only checked.
        if (role === "serve" && running) return yield* saveWhenAnswering(status.success);

        const path = yield* loginShell.readPath.pipe(Effect.result);
        if (path._tag === "Failure") {
          return { _tag: "StartFailed", line: path.failure.reason } as const;
        }
        const installed = yield* binary
          .install(path.success)
          .pipe(
            Effect.map(rememberLogsFolder),
            Effect.timeoutOption(INSTALL_TIME_LIMIT),
            Effect.result,
          );
        if (installed._tag === "Failure") {
          return installed.failure._tag === "BinaryNotFound"
            ? ({ _tag: "NotInstalled" } as const)
            : ({ _tag: "StartFailed", line: installed.failure.line } as const);
        }
        if (Option.isNone(installed.success)) {
          // The command hung and was stopped, so it reported nothing; the
          // Home's address is the one the status reported before.
          const origin = status.success.controllerUrl;
          return origin === null
            ? ({
                _tag: "StartFailed",
                line: `\`hercule service install\` did not finish within ${String(Duration.toSeconds(INSTALL_TIME_LIMIT))} seconds, so the app stopped it.`,
              } as const)
            : ({ _tag: "NoAnswer", origin, logsFolder: status.success.logsDir } as const);
        }
        const report = installed.success.value;
        if (report.role === "runner") return { _tag: "Runner", running: report.running } as const;
        return yield* saveWhenAnswering(report);
      });

      return LocalController.of({
        find: oneAtATime.withPermit(
          Effect.gen(function* () {
            yield* refuseWhenControllerSaved;
            const found = yield* findController;
            if (found._tag !== "Answering") return found;
            yield* connection.saveAndReload(found.origin);
            return { _tag: "Saved", origin: found.origin } as const;
          }),
        ),
        start: oneAtATime.withPermit(Effect.andThen(refuseWhenControllerSaved, startController)),
        showLogsFolder: Effect.suspend(() =>
          logsFolder === null ? Effect.fail(new NoLogsFolderSeen()) : openFolder(logsFolder),
        ),
      });
    }),
  );
