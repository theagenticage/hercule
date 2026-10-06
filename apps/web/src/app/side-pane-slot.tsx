/**
 * The shell's side-pane slot: a place to the right of the main column, full
 * window height, outside the scrolling `main`, that a screen can fill.
 *
 * The shell owns the element and knows nothing about what goes in it. A
 * screen fills it by rendering `SidePaneSlot`, which draws its children into
 * the slot through a portal. The children stay part of the screen's React
 * tree, so they read the same router and query context as the screen, and
 * they leave the slot when the screen unmounts.
 *
 * It lives here rather than in `shell/`, because a screen may not import the
 * shell, and the shell and the screens both need it.
 */
import { createContext, useContext, type JSX, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * The slot's element, or null until the shell has mounted it. The shell
 * provides it.
 */
export const SidePaneSlotContext = createContext<HTMLElement | null>(null);

/**
 * Renders `children` into the shell's side-pane slot. Renders nothing until
 * the slot has mounted, which is one render after the shell's first, and
 * nothing outside a shell.
 */
export function SidePaneSlot({ children }: { readonly children: ReactNode }): JSX.Element | null {
  const slot = useContext(SidePaneSlotContext);
  return slot === null ? null : createPortal(children, slot);
}
