import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * `/settings` is the section, not a screen. It redirects to the first screen
 * of the sub-navigation, so a link to the section shows something.
 */
export const Route = createFileRoute("/_shell/settings/")({
  beforeLoad: () => {
    // The router redirects by throwing, and the thrown value is a plain
    // redirect object rather than an Error.
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw redirect({ to: "/settings/profile", replace: true });
  },
});
