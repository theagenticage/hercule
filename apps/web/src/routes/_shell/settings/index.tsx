import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * `/settings` is the section, not a screen. It lands on the first screen of the
 * sub-navigation, so a link to the section shows something.
 */
export const Route = createFileRoute("/_shell/settings/")({
  beforeLoad: () => {
    // A thrown redirect is how the router is told to go elsewhere, and what it
    // carries is a plain descriptor rather than an error.
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw redirect({ to: "/settings/profile", replace: true });
  },
});
