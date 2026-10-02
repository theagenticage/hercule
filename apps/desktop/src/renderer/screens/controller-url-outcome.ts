import type { ControllerUrlSaveOutcome } from "../../ipc/contract";

/** The address of a controller on this Mac at the default port, as the connect screen prefills it. */
export const LOCAL_CONTROLLER_URL = "http://127.0.0.1:4937";

/**
 * Returns the line that explains the outcome of saving a controller address,
 * or `null` for `Saved`, after which main reloads the window. A line names
 * the origin main checked, not the text the user typed, which may differ in
 * spaces, capitals, a trailing `/` or a default port.
 *
 * The connect screen and the first run's remote screen both show it.
 */
export const describeControllerUrlOutcome = (outcome: ControllerUrlSaveOutcome): string | null => {
  switch (outcome._tag) {
    case "Saved":
      return null;
    case "InvalidAddress":
      return `Enter the controller's address, such as ${LOCAL_CONTROLLER_URL}.`;
    case "Unreachable":
      return `Could not reach ${outcome.origin}. Check that the controller is running.`;
    case "Redirected":
      return `${outcome.origin} redirects to ${outcome.targetOrigin}. Connect to that address instead.`;
    case "NotController":
      return `${outcome.origin} answered, but it is not a Hercule controller.`;
    case "OriginNotAllowed":
      return `${outcome.origin} does not accept the desktop app yet. Update the controller.`;
    case "PreflightRefused": {
      const methods = new Intl.ListFormat("en", { type: "conjunction" }).format(outcome.methods);
      return `${outcome.origin} does not accept the desktop app's ${methods} requests. Update the controller, or check any proxy in front of it.`;
    }
  }
};
