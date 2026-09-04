import type { JSX } from "react";
import { createFileRoute, Link, Outlet } from "@tanstack/react-router";
import { SETTINGS_NAV } from "../../shell";

/** The nine settings screens share one sub-navigation above them. */
export const Route = createFileRoute("/_shell/settings")({
  component: SettingsLayout,
});

function SettingsLayout(): JSX.Element {
  return (
    <>
      <nav
        className="mb-5 flex flex-wrap gap-x-2.5 gap-y-1 text-row text-muted"
        aria-label="Settings"
      >
        {SETTINGS_NAV.map((item) => (
          <Link
            key={item.to}
            to={item.to}
            activeProps={{ className: "bg-line-soft font-emph text-ink" }}
            className="rounded-control px-2 py-[3px] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-live"
          >
            {item.label}
          </Link>
        ))}
      </nav>
      <Outlet />
    </>
  );
}
