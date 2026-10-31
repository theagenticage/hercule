import { useId, useLayoutEffect, type JSX } from "react";
import { useMutation, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import {
  findProjectModelProfile,
  queryKeys,
  readErrorMessage,
  type HerculeClient,
} from "@hercule/client-core";
import { useDoneMoves } from "../app/done-moves";
import { modelProfilesQuery, projectsQuery } from "../app/queries";
import { CheckIcon } from "../icons/check";
import { usePopoverMenu } from "../screens/use-popover-menu";
import "../screens/thread/menus.css";
import "./project-profile-menu.css";

/** The space the menu keeps between itself and the window's edge, in CSS pixels. */
const WINDOW_MARGIN = 8;

/**
 * Renders a project's context menu, open, at the point (`x`, `y`) in the
 * window where the user right-clicked the project's heading. The menu holds
 * "Model profile" with a choice for each Model Profile and None. The choice
 * that is the project's profile today is checked, and None is checked while
 * the project names no profile or names one that was deleted.
 *
 * Taking a choice closes the menu, calls `onClose`, and writes
 * `project.update` with the profile's id, or with `null` for None. Taking the
 * choice that is already checked writes nothing. The write is not undone when
 * the menu is gone. When it succeeds the projects are read again, because
 * they have no live topic. When it fails the sidebar's toast shows the
 * error, as it does for a Done move that failed.
 *
 * The menu is a popover, so Esc and a click outside close it; both call
 * `onClose`. If the menu would run past the window's edge, it moves in.
 */
export function ProjectProfileMenu({
  projectId,
  x,
  y,
  onClose,
}: {
  readonly projectId: string;
  readonly x: number;
  readonly y: number;
  readonly onClose: () => void;
}): JSX.Element {
  const { controller } = useRouteContext({ from: "/_connected" });
  const { client } = controller;
  const projects = useSuspenseQuery(projectsQuery(client)).data;
  const profiles = useSuspenseQuery(modelProfilesQuery(client)).data;
  const current = findProjectModelProfile(projects, profiles, projectId);
  const { menuProps, buildItemProps, close } = usePopoverMenu();
  const headingId = useId();
  const setProfile = useSetProjectModelProfile(client);

  // Opens the menu where the user clicked, moved in if it would run past the
  // window's edge. The popover must be shown before its size can be measured.
  // React never sets `left` and `top`, so it never overwrites them.
  const menuId = menuProps.id;
  useLayoutEffect(() => {
    const menu = document.getElementById(menuId)!;
    menu.showPopover();
    const { width, height } = menu.getBoundingClientRect();
    const keepInside = (at: number, size: number, windowSize: number): string =>
      `${String(Math.max(WINDOW_MARGIN, Math.min(at, windowSize - size - WINDOW_MARGIN)))}px`;
    menu.style.left = keepInside(x, width, window.innerWidth);
    menu.style.top = keepInside(y, height, window.innerHeight);
  }, [menuId, x, y]);

  const choose = (modelProfileId: string | null): void => {
    close();
    onClose();
    if (modelProfileId !== (current?.id ?? null)) {
      setProfile.mutate({ projectId, modelProfileId });
    }
  };

  const item = (key: string, id: string | null, name: string): JSX.Element => {
    const checked = (current?.id ?? null) === id;
    return (
      <button
        key={key}
        type="button"
        {...buildItemProps(key, false, checked)}
        onClick={() => {
          choose(id);
        }}
      >
        <span className="project-menu-check">{checked ? <CheckIcon size={14} /> : null}</span>
        {name}
      </button>
    );
  };

  return (
    <div
      {...menuProps}
      popover="auto"
      role="menu"
      aria-label={projects.find((project) => project.id === projectId)?.name ?? "Project"}
      className="pop popover-menu project-menu"
      // The popover closes itself on Esc and on a click outside it.
      onToggle={(event) => {
        menuProps.onToggle(event);
        if (event.newState === "closed") onClose();
      }}
    >
      <div role="group" aria-labelledby={headingId}>
        <div className="q-h" id={headingId}>
          Model profile
        </div>
        {profiles.map((profile) => item(profile.id, profile.id, profile.name))}
        {item("none", null, "None")}
      </div>
    </div>
  );
}

/**
 * Returns the mutation that sets (an id) or clears (`null`) the Model Profile
 * of a project. It reads the projects again when it succeeds and shows the
 * error in the sidebar's toast when it fails.
 */
function useSetProjectModelProfile(client: HerculeClient) {
  const queryClient = useQueryClient();
  const { toasts } = useDoneMoves();
  return useMutation({
    mutationFn: ({
      projectId,
      modelProfileId,
    }: {
      readonly projectId: string;
      readonly modelProfileId: string | null;
    }) => client.project.update({ params: { id: projectId }, payload: { modelProfileId } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.projects() }),
    onError: (error) => {
      toasts.showFailure(`Couldn't set the model profile: ${readErrorMessage(error)}`, null);
    },
  });
}
