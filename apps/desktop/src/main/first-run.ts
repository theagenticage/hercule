/**
 * The first run, as main's IPC handlers use it: the FirstRun service. Each
 * method runs code from `./first-run-services`, which main imports, and
 * whose services it builds, only when the first method is called. Once a
 * controller is saved and set up, the app never calls them, so a usual launch
 * loads none of it.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import type {
  FolderPickOutcome,
  LocalControllerFindOutcome,
  LocalControllerStartOutcome,
  SetupTokenReadOutcome,
} from "../ipc/contract";
import type { AppSettings, NoControllerSaved } from "./app-settings";
import type { ControllerConnection } from "./controller-connection";
import type { InstalledBinary } from "./installed-binary";
import type { ControllerAlreadySaved, LocalController, NoLogsFolderSeen } from "./local-controller";
import type { MainWindow } from "./main-window";

type FirstRunServicesModule = typeof import("./first-run-services");

/** The first run's work in main. */
export class FirstRun extends Context.Service<
  FirstRun,
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
>()("hercule/desktop/FirstRun") {}

/**
 * Builds the first run on the binary at `binaryPath`. `openFolder` opens a
 * folder in Finder. The services are built in this layer's scope, so they
 * are released with main's runtime.
 */
export const makeFirstRunLayer = (options: {
  readonly binaryPath: string;
  readonly openFolder: (path: string) => Effect.Effect<void>;
}): Layer.Layer<FirstRun, never, AppSettings | ControllerConnection | MainWindow> =>
  Layer.effect(FirstRun)(
    Effect.gen(function* () {
      const context = yield* Effect.context<AppSettings | ControllerConnection | MainWindow>();
      const scope = yield* Scope.Scope;
      // Imported and built once, by the first call; later calls reuse them.
      const loadFirstRunServices = yield* Effect.cached(
        Effect.gen(function* () {
          const module = yield* Effect.promise(() => import("./first-run-services"));
          const services = yield* Layer.buildWithScope(
            module.makeFirstRunServicesLayer(options),
            scope,
          );
          return { module, context: Context.merge(context, services) };
        }).pipe(Effect.provideContext(context)),
      );

      /** Runs what `use` returns with the first run's module and services. */
      const runWithFirstRunServices = <A, E>(
        use: (
          module: FirstRunServicesModule,
        ) => Effect.Effect<
          A,
          E,
          AppSettings | ControllerConnection | MainWindow | InstalledBinary | LocalController
        >,
      ): Effect.Effect<A, E> =>
        Effect.flatMap(loadFirstRunServices, ({ module, context }) =>
          use(module).pipe(Effect.provideContext(context)),
        );

      return FirstRun.of({
        findLocalController: runWithFirstRunServices((module) =>
          module.LocalController.use((local) => local.find),
        ),
        startLocalController: runWithFirstRunServices((module) =>
          module.LocalController.use((local) => local.start),
        ),
        showLogsFolder: runWithFirstRunServices((module) =>
          module.LocalController.use((local) => local.showLogsFolder),
        ),
        readSetupToken: runWithFirstRunServices((module) => module.readSetupToken),
        pickFolder: runWithFirstRunServices((module) => module.pickFolder),
      });
    }),
  );
