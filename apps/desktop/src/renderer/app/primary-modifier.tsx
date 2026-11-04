import { createContext, use, useState, type JSX, type ReactNode } from "react";
import type { DesktopPlatform } from "../../ipc/platform/desktop-platform";

/** The modifier flags that a keyboard or a mouse event, from React or from the DOM, carries. */
interface ModifierFlags {
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
}

/**
 * Tells which of ⌘ and Ctrl is the key that starts a shortcut on the
 * platform the app runs on. On a Mac the primary modifier is ⌘, and Ctrl is
 * never one: Ctrl+F, Ctrl+A and the like are text-editing keys there. On
 * Linux it is Ctrl.
 */
export interface PrimaryModifier {
  /** Returns whether `event` has the primary modifier held. */
  readonly isHeld: (event: ModifierFlags) => boolean;
  /**
   * Returns whether `event` has held the one of ⌘ and Ctrl that is not the
   * primary modifier: Ctrl on a Mac, ⌘ on Linux. A shortcut that wants the
   * primary modifier alone refuses it.
   */
  readonly isOtherHeld: (event: ModifierFlags) => boolean;
}

/** Returns the `PrimaryModifier` of `platform`. */
export const buildPrimaryModifier = (platform: DesktopPlatform): PrimaryModifier =>
  platform === "mac"
    ? { isHeld: (event) => event.metaKey, isOtherHeld: (event) => event.ctrlKey }
    : { isHeld: (event) => event.ctrlKey, isOtherHeld: (event) => event.metaKey };

const PrimaryModifierContext = createContext<PrimaryModifier | null>(null);

/**
 * Offers the primary modifier of `platform` to `children`, which read it
 * with `usePrimaryModifier`. The app puts it above every route, so every
 * shortcut agrees on one platform.
 */
export function PrimaryModifierProvider({
  platform,
  children,
}: {
  readonly platform: DesktopPlatform;
  readonly children: ReactNode;
}): JSX.Element {
  const [modifier] = useState(() => buildPrimaryModifier(platform));
  return <PrimaryModifierContext value={modifier}>{children}</PrimaryModifierContext>;
}

/**
 * Returns the primary modifier of the platform the app runs on. Fails when
 * called outside a `PrimaryModifierProvider`.
 */
export function usePrimaryModifier(): PrimaryModifier {
  const modifier = use(PrimaryModifierContext);
  if (modifier === null) throw new Error("No PrimaryModifierProvider above this component");
  return modifier;
}
