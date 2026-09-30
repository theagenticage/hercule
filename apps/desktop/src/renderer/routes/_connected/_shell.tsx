import { useCallback, useEffect, useState, type JSX } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Outlet, redirect, useNavigate } from "@tanstack/react-router";
import { LOGIN_PATH } from "../../app/entry-guard";
import { useLiveConnection } from "../../app/live";
import {
  projectsQuery,
  providersQuery,
  resourcesQuery,
  runnersQuery,
  threadsQuery,
  userQuery,
  workspacesQuery,
} from "../../app/queries";
import { ProjectPicker } from "../../screens/new-thread/project-picker";
import { Shell } from "../../shell";

/**
 * The shell's layout route. Every screen inside the app is a child of this
 * route, so the sidebar is mounted once and stays mounted across navigation.
 *
 * Its loader reads everything the sidebar shows before the shell renders, so
 * the first frame holds the whole sidebar and nothing in it waits. While the
 * shell is mounted, the live connection runs and keeps those reads current.
 *
 * The shell also owns the project picker, which File > New Thread (⌘N) and
 * the sidebar's New thread open. With no project to pick, both open a Draft
 * Thread in no project instead.
 */
export const Route = createFileRoute("/_connected/_shell")({
  loader: async ({ context: { controller, queryClient } }) => {
    const { client } = controller;
    try {
      await Promise.all([
        queryClient.ensureQueryData(threadsQuery(client)),
        queryClient.ensureQueryData(projectsQuery(client)),
        queryClient.ensureQueryData(workspacesQuery(client)),
        queryClient.ensureQueryData(resourcesQuery(client)),
        queryClient.ensureQueryData(runnersQuery(client)),
        queryClient.ensureQueryData(providersQuery(client)),
        queryClient.ensureQueryData(userQuery(client)),
      ]);
    } catch (error) {
      // The entry guard only checks that a token is saved. When the
      // controller rejects it, such as a token revoked from another device,
      // the client removes it (spec 17, Auth and the token), and the user
      // signs in again rather than seeing the failed read. Once the sign-in
      // screen shows, the router empties the caches (see `createAppRouter`).
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      if (client.getToken() === null) throw redirect({ to: LOGIN_PATH, replace: true });
      throw error;
    }
  },
  // The app starts on this route, so it is not split into a chunk of its own:
  // a split route costs two more requests (its script and its stylesheet)
  // before the first render.
  codeSplitGroupings: [],
  component: ShellLayout,
});

function ShellLayout(): JSX.Element {
  const { bridge, controller, queryClient } = Route.useRouteContext();
  const navigate = useNavigate();
  useLiveConnection(controller.live, queryClient);
  const hasProjects = useSuspenseQuery(projectsQuery(controller.client)).data.length > 0;
  const [picking, setPicking] = useState(false);

  const openNewThread = useCallback(() => {
    if (hasProjects) setPicking(true);
    else void navigate({ to: "/" });
  }, [hasProjects, navigate]);

  // Only a signed-in user can start a thread, so only the shell listens for
  // File > New Thread.
  useEffect(
    () =>
      bridge.menu.onCommand((command) => {
        if (command === "newThread") openNewThread();
      }),
    [bridge, openNewThread],
  );

  return (
    <>
      <Shell onNewThread={openNewThread}>
        <Outlet />
      </Shell>
      {picking ? (
        <ProjectPicker
          onClose={() => {
            setPicking(false);
          }}
        />
      ) : null}
    </>
  );
}
