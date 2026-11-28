/**
 * The operating systems the desktop app runs on, and how to tell which one
 * this is. Main, the preload and the renderer all name the platform with
 * `DesktopPlatform`. The file imports nothing, so the preload can load it at
 * run time without loading the IPC contract or Effect.
 */

/** The operating systems the desktop app runs on. */
export type DesktopPlatform = "mac" | "linux";

/**
 * Returns the `DesktopPlatform` for a Node platform name, such as
 * `process.platform`. Throws for any other operating system: the app has no
 * code for it, and guessing the nearest platform would silently give the
 * user the wrong window, menu and shortcuts.
 */
export const readDesktopPlatform = (nodePlatform: string): DesktopPlatform => {
  switch (nodePlatform) {
    case "darwin":
      return "mac";
    case "linux":
      return "linux";
    default:
      throw new Error(
        `The desktop app runs on macOS and Linux only, and this is "${nodePlatform}". Run it on one of those.`,
      );
  }
};
