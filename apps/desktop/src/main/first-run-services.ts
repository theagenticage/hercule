/**
 * What the first run's IPC channels run, gathered in one module that
 * `./first-run` imports only when the first run first needs it, so none of
 * it is on the launch path.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { AppSettings } from "./app-settings";
import type { ControllerConnection } from "./controller-connection";
import { InstalledBinary, makeInstalledBinaryLayer } from "./installed-binary";
import { LocalController, makeLocalControllerLayer } from "./local-controller";
import { LoginShellLayer } from "./login-shell-path";

export { LocalController } from "./local-controller";
export { readSetupToken } from "./setup-token";
export { pickFolder } from "./folder-pick";

/**
 * Builds the services the first run uses: the binary at `binaryPath`, and
 * Hercule on this Mac, which opens its logs folder with `openFolder`.
 */
export const makeFirstRunServicesLayer = (options: {
  readonly binaryPath: string;
  readonly openFolder: (path: string) => Effect.Effect<void>;
}): Layer.Layer<InstalledBinary | LocalController, never, AppSettings | ControllerConnection> =>
  makeLocalControllerLayer(options.openFolder).pipe(
    Layer.provideMerge(makeInstalledBinaryLayer(options.binaryPath)),
    Layer.provide(LoginShellLayer),
  );
