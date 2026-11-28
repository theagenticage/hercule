import type { DesktopPlatform } from "../../ipc/platform/desktop-platform";

/** The modifier flags that a keyboard or a mouse event, from React or from the DOM, carries. */
interface ModifierFlags {
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
}

/**
 * Returns whether `event` has the key that starts a shortcut on `platform`
 * held: ⌘ on a Mac, Ctrl on Linux. Ctrl is never the primary modifier on a
 * Mac, because Ctrl+F, Ctrl+A and the like are text-editing keys there.
 */
export const isPrimaryModifierHeld = (event: ModifierFlags, platform: DesktopPlatform): boolean =>
  platform === "mac" ? event.metaKey : event.ctrlKey;

/**
 * Returns whether `event` has the one of ⌘ and Ctrl that is not the primary
 * modifier of `platform` held: Ctrl on a Mac, ⌘ on Linux. A shortcut that
 * wants the primary modifier alone refuses it.
 */
export const isOtherModifierHeld = (event: ModifierFlags, platform: DesktopPlatform): boolean =>
  platform === "mac" ? event.ctrlKey : event.metaKey;

/** Returns how the Undo key reads on `platform`: ⌘Z on a Mac, Ctrl Z elsewhere. */
export const describeUndoKey = (platform: DesktopPlatform): string =>
  platform === "mac" ? "⌘Z" : "Ctrl Z";
