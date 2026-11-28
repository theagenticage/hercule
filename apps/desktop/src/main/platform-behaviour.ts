/**
 * What differs in main between the operating systems the app runs on. Main
 * reads `process.platform` once, at start, and passes the `DesktopPlatform`
 * to the window and the menu, which look their behaviour up here. Nothing
 * else in main tests the platform.
 *
 * This module imports no Electron, so unit tests can use it.
 */
import type { DesktopPlatform } from "../ipc/platform/desktop-platform";

/** How the window and the menu behave on one platform. */
export interface PlatformBehaviour {
  /**
   * True when the page fills the whole window, title bar included, and the
   * system draws only the window's buttons over it. False when the window
   * has the system's own frame and title bar.
   */
  readonly insetTitleBar: boolean;

  /**
   * What closing the window does. "hides" keeps the app running, so the
   * Dock can bring the window back. "quits" ends the app, because the
   * platform has no Dock to bring a hidden window back from.
   */
  readonly closingWindow: "hides" | "quits";

  /**
   * True when the menu bar has what only macOS has: the app menu that macOS
   * names itself, and the items Services, Hide, Hide Others, Show All,
   * Substitutions and Speech. False when the app menu is an ordinary menu
   * with a label of its own, and those items are left out.
   */
  readonly hasMacMenu: boolean;

  /**
   * What the platform calls the place that keeps the key which encrypts the
   * login token, as the user knows it: the Keychain on macOS, the keyring on
   * Linux. Messages to the user and the log name it.
   */
  readonly keyStoreName: "Keychain" | "keyring";

  /**
   * True when Undo and Redo from the Edit menu may step a native control that
   * no web contents of the app owns, such as the search field of the folder
   * sheet, by sending the action to the first responder. Only macOS has the
   * first responder chain. False when such a step does nothing, because the
   * call does not exist there.
   */
  readonly stepsNativeControls: boolean;
}

/** The behaviour of each platform. */
export const PLATFORM_BEHAVIOUR: { readonly [Platform in DesktopPlatform]: PlatformBehaviour } = {
  mac: {
    insetTitleBar: true,
    closingWindow: "hides",
    hasMacMenu: true,
    keyStoreName: "Keychain",
    stepsNativeControls: true,
  },
  linux: {
    insetTitleBar: false,
    closingWindow: "quits",
    hasMacMenu: false,
    keyStoreName: "keyring",
    stepsNativeControls: false,
  },
};
