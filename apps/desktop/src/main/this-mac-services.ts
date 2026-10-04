/**
 * The code behind the ThisMac service, in one module that `./this-mac`
 * imports only when one of its methods is first called, so none of it is on
 * the launch path.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import type { AppSettings } from "./app-settings";
import type { ControllerConnection } from "./controller-connection";
import { pickFolder } from "./folder-pick";
import { makeInstalledBinaryLayer } from "./installed-binary";
import { LocalController, makeLocalControllerLayer } from "./local-controller";
import { LoginShellLayer } from "./login-shell-path";
import type { MainWindow } from "./main-window";
import { readSetupToken } from "./setup-token";
import type { ThisMac } from "./this-mac";

/**
 * Builds ThisMac's methods on the binary at `binaryPath`. `openFolder` opens
 * a folder in Finder. The services the methods use are built in the scope
 * the effect runs in, and released when that scope closes.
 */
export const makeThisMacMethods = (options: {
  readonly binaryPath: string;
  readonly openFolder: (path: string) => Effect.Effect<void>;
}): Effect.Effect<
  ThisMac["Service"],
  never,
  AppSettings | ControllerConnection | MainWindow | Scope.Scope
> =>
  Effect.gen(function* () {
    const services = yield* Layer.build(
      makeLocalControllerLayer(options.openFolder).pipe(
        Layer.provideMerge(makeInstalledBinaryLayer(options.binaryPath)),
        Layer.provide(LoginShellLayer),
      ),
    );
    const context = Context.merge(
      yield* Effect.context<AppSettings | ControllerConnection | MainWindow>(),
      services,
    );
    const localController = Context.get(services, LocalController);
    return {
      findLocalController: localController.find,
      startLocalController: localController.start,
      showLogsFolder: localController.showLogsFolder,
      readSetupToken: Effect.provideContext(readSetupToken, context),
      pickFolder: Effect.provideContext(pickFolder, context),
    };
  });
