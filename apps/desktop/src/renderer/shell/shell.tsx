import { useEffect, useLayoutEffect, useRef, type JSX, type ReactNode } from "react";
import { useRouteContext } from "@tanstack/react-router";
import { SidebarIcon } from "../icons/sidebar";
import { drawSidebarWidth, SidebarHandle } from "./sidebar-handle";
import { Sidebar } from "./sidebar";
import { toggleSidebar, useSidebarLayout } from "./use-sidebar-layout";
import "./shell.css";

/**
 * Renders the shell: the sidebar on the left, and beside it the main pane,
 * which holds the open screen (`children`). The shell fills the window and
 * never scrolls itself. The sidebar's New thread calls `onNewThread`.
 *
 * The user resizes the sidebar by the handle on its right edge, and hides
 * and shows it by the sidebar's Hide button, the Show button that takes its
 * place in the main pane, View > Toggle Sidebar (⌘B), or Enter on the
 * handle. The shell keeps the layout on this device; see `useSidebarLayout`.
 *
 * The shell owns the window's drag strip, the band along the top of the
 * window by which it is dragged, as by a title bar. No other element in the
 * shell is a drag region, so the sidebar and every screen can be dragged by
 * their top edge without drawing anything for it. The strip comes first in
 * the document, so a control that sits over it comes later, and its
 * `no-drag` takes precedence over the strip's `drag`.
 */
export function Shell({
  onNewThread,
  children,
}: {
  readonly onNewThread: () => void;
  readonly children: ReactNode;
}): JSX.Element {
  const { bridge } = useRouteContext({ from: "/_connected" });
  const { width, collapsed } = useSidebarLayout();
  const shellRef = useRef<HTMLDivElement>(null);
  const slotRef = useRef<HTMLDivElement>(null);
  const showRef = useRef<HTMLButtonElement>(null);

  useEffect(
    () =>
      bridge.menu.onCommand((command) => {
        if (command === "toggleSidebar") toggleSidebar();
      }),
    [bridge],
  );

  // The shown sidebar is drawn at the stored width before the frame paints.
  // A hidden one is left at the width it showed, so it slides shut from
  // there, also when a drag let go at a width that was not stored.
  useLayoutEffect(() => {
    if (!collapsed) drawSidebarWidth(shellRef.current!, width);
  }, [width, collapsed]);

  // The sidebar's box, which slides, follows `collapsed` one frame late, in
  // its own attribute: the click or key is drawn in one frame, and the box
  // starts to slide in the next. The click's work then never shares a frame
  // with the slide's start. After the window has been still, the frame that
  // draws a click starts 4 to 5 ms late, so even a small render can miss that
  // frame's deadline and drop the slide's first frame. Intake's split does
  // the same (spec 17, §Measured). React does not render the attribute, so
  // setting it draws nothing but the box. Under Reduce motion nothing moves,
  // and when the shell first draws nothing slides, so the box follows at once.
  useLayoutEffect(() => {
    const shell = shellRef.current!;
    const box = collapsed ? "closed" : "open";
    if (
      shell.dataset["sidebarBox"] === undefined ||
      matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      shell.dataset["sidebarBox"] = box;
      return;
    }
    // The first callback runs before the frame that draws the click, the
    // second one in the frame after it.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        shell.dataset["sidebarBox"] = box;
      });
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [collapsed]);

  // A hidden sidebar cannot hold the focus, and the handle goes away with it.
  // So the focus inside the sidebar, or on the handle that hid it, would fall
  // to the page's body, where no key reaches a screen, once the sidebar has
  // slid shut. The focus goes to the Show button instead, and back to the handle when
  // the sidebar shows again from the Show button. Focus anywhere else, such
  // as in a screen when ⌘B is pressed, stays where it is. Nothing moves the
  // focus when the shell first draws.
  const collapsedBefore = useRef(collapsed);
  useLayoutEffect(() => {
    if (collapsed === collapsedBefore.current) return;
    collapsedBefore.current = collapsed;
    const focused = document.activeElement;
    const lost =
      focused === null ||
      focused === document.body ||
      (slotRef.current?.contains(focused) ?? false);
    if (collapsed && lost) showRef.current?.focus();
    if (!collapsed && lost) shellRef.current?.querySelector<HTMLElement>(".side-handle")?.focus();
  }, [collapsed]);

  return (
    <div ref={shellRef} className="app" data-sidebar={collapsed ? "closed" : "open"}>
      <div className="drag-strip" />
      <div ref={slotRef} className="side-slot">
        <Sidebar onNewThread={onNewThread} />
      </div>
      <main className="main">{children}</main>
      {collapsed ? (
        <button
          ref={showRef}
          type="button"
          className="icon-btn side-show"
          title="Show the sidebar ⌘B"
          onClick={toggleSidebar}
        >
          <SidebarIcon />
        </button>
      ) : (
        <SidebarHandle shellRef={shellRef} width={width} />
      )}
    </div>
  );
}
