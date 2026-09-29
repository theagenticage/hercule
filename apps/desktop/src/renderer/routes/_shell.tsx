import type { JSX } from "react";
import { createFileRoute, Outlet } from "@tanstack/react-router";
import { Shell } from "../shell";

/**
 * The shell's layout route. Every screen inside the app is a child of this
 * route, so the sidebar is mounted once and stays mounted across navigation.
 */
export const Route = createFileRoute("/_shell")({
  // The app starts on this route, so it is not split into a chunk of its own:
  // a split route costs two more requests (its script and its stylesheet)
  // before the first render.
  codeSplitGroupings: [],
  component: ShellLayout,
});

function ShellLayout(): JSX.Element {
  return (
    <Shell>
      <Outlet />
    </Shell>
  );
}
