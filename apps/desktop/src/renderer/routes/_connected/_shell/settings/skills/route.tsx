import type { JSX } from "react";
import { Outlet, createFileRoute } from "@tanstack/react-router";
import { SKILL_TOPICS, useScreenTopicsLive } from "../../../../../app/live";

/**
 * Settings > Skills, around both the list and a skill's page: holds the
 * `skill` topic while either is open, so a finished update check, or a
 * change made from the CLI, shows at once. The topic is held here rather
 * than by each screen, so going from the list to a page keeps the one
 * subscription instead of dropping it and subscribing again.
 */
export const Route = createFileRoute("/_connected/_shell/settings/skills")({
  component: SkillsLayout,
});

function SkillsLayout(): JSX.Element {
  const { controller, queryClient } = Route.useRouteContext();
  useScreenTopicsLive(controller.live, queryClient, SKILL_TOPICS);
  return <Outlet />;
}
