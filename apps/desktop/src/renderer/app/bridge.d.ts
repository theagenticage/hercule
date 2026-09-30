import type { Bridge } from "../../ipc/bridge";

declare global {
  interface Window {
    /**
     * The functions main offers the page, one per IPC channel. The preload
     * puts them here before the page's own scripts run. Only boot reads it:
     * everything else receives the bridge through the router context, so a
     * test can pass a fake one.
     */
    readonly bridge: Bridge;
  }
}
