import { createFileRoute, redirect } from "@tanstack/react-router";
import { readLastSettingsSection } from "../../../../app/last-settings-section";

/**
 * `/settings` itself, which the sidebar's Settings button and the app menu's
 * Settings open. It shows nothing: it goes to the section opened last while
 * the app runs, or to the first section the first time (spec 17 §Settings,
 * The way in). The redirect replaces `/settings` in the history.
 */
export const Route = createFileRoute("/_connected/_shell/settings/")({
  beforeLoad: () => {
    // The router redirects when a `redirect` is thrown. The thrown value is a
    // plain descriptor rather than an Error.
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw redirect({ to: readLastSettingsSection(), replace: true });
  },
});
