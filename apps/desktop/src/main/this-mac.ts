/**
 * The ThisMac service: the work main does on this Mac for the renderer, by
 * running the Hercule binary, git and the folder dialog.
 *
 * Main imports the code behind it, `./this-mac-services`, only when the
 * first method is called. The first run and the New project dialog call the
 * methods; a usual launch of a set-up app calls none, so it loads none of
 * that code.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import type {
  FolderPickOutcome,
  LocalControllerFindOutcome,
  LocalControllerStartOutcome,
  SetupTokenReadOutcome,
} from "../ipc/contract";
import type { AppSettings, NoControllerSaved } from "./app-settings";
import type { ControllerConnection } from "./controller-connection";
import type { ControllerAlreadySaved, NoLogsFolderSeen } from "./local-controller";
import type { MainWindow } from "./main-window";

/**
 * Finds and starts Hercule on this Mac, shows its logs folder, reads the
 * saved controller's setup token, and asks the user for a project's folder.
 */
export class ThisMac extends Context.Service<
  ThisMac,
  {
    /** Looks for Hercule on this Mac; see LocalController's `find`. */
    readonly findLocalController: Effect.Effect<LocalControllerFindOutcome, ControllerAlreadySaved>;

    /** Starts Hercule on this Mac; see LocalController's `start`. */
    readonly startLocalController: Effect.Effect<
      LocalControllerStartOutcome,
      ControllerAlreadySaved
    >;

    /** Opens the Hercule Home's logs folder; see LocalController's `showLogsFolder`. */
    readonly showLogsFolder: Effect.Effect<void, NoLogsFolderSeen>;

    /** Reads the saved controller's setup token; see `readSetupToken`. */
    readonly readSetupToken: Effect.Effect<SetupTokenReadOutcome, NoControllerSaved>;

    /** Asks the user for a project's folder; see `pickFolder`. */
    readonly pickFolder: Effect.Effect<FolderPickOutcome>;
  }
>()("hercule/desktop/ThisMac") {}

/**
 * Builds the ThisMac service on the binary at `binaryPath`. `openFolder`
 * opens a folder in Finder. The code behind the methods is imported, and
 * its services built, by the first call; later calls reuse them. They are
 * built in this layer's scope, so they are released with main's runtime.
 */
export const makeThisMacLayer = (options: {
  readonly binaryPath: string;
  readonly openFolder: (path: string) => Effect.Effect<void>;
}): Layer.Layer<ThisMac, never, AppSettings | ControllerConnection | MainWindow> =>
  Layer.effect(ThisMac)(
    Effect.gen(function* () {
      const context = yield* Effect.context<
        AppSettings | ControllerConnection | MainWindow | Scope.Scope
      >();
      const loadMethods = yield* Effect.cached(
        Effect.promise(() => import("./this-mac-services")).pipe(
          Effect.flatMap((module) => module.makeThisMacMethods(options)),
          Effect.provideContext(context),
        ),
      );
      return ThisMac.of({
        findLocalController: Effect.flatMap(loadMethods, (methods) => methods.findLocalController),
        startLocalController: Effect.flatMap(
          loadMethods,
          (methods) => methods.startLocalController,
        ),
        showLogsFolder: Effect.flatMap(loadMethods, (methods) => methods.showLogsFolder),
        readSetupToken: Effect.flatMap(loadMethods, (methods) => methods.readSetupToken),
        pickFolder: Effect.flatMap(loadMethods, (methods) => methods.pickFolder),
      });
    }),
  );
