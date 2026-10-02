import { lazy, Suspense, useCallback, useEffect, useState, type JSX } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Outlet, redirect, useNavigate } from "@tanstack/react-router";
import { listWaitingThreads } from "@hercule/client-core";
import { LOGIN_PATH } from "../../app/entry-guard";
import { useLiveConnection } from "../../app/live";
import { useSendOnChange } from "../../app/send-on-change";
import { ensureShellData, threadsQuery } from "../../app/queries";
import { DRAFT_MESSAGE_ID } from "../../screens/new-thread/draft-composer";
import { Shell } from "../../shell";

// The project picker and the New project dialog are each loaded the first
// time they open, so their code is not part of the first screen's scripts
// (spec 17 §Performance).
const ProjectPicker = lazy(() =>
  import("../../screens/new-thread/project-picker").then((module) => ({
    default: module.ProjectPicker,
  })),
);
const NewProjectDialog = lazy(() =>
  import("../../screens/new-project").then((module) => ({ default: module.NewProjectDialog })),
);

/**
 * The shell's layout route. Every screen inside the app is a child of this
 * route, so the sidebar is mounted once and stays mounted across navigation.
 *
 * Its loader reads everything the sidebar shows before the shell renders, so
 * the first frame holds the whole sidebar and nothing in it waits. While the
 * shell is mounted, the live connection runs and keeps those reads current.
 *
 * The shell also owns the project picker, which File > New Thread (⌘N) and
 * the sidebar's New thread open, and the New project dialog that the
 * picker's last row opens. A project added there opens a Draft Thread in it.
 *
 * While the user is signed in, the shell sends main the threads waiting on
 * the user whenever the thread list changes, for the dock badge and the
 * threads' notifications. It opens the thread main names when the user
 * chooses it in the Go menu or clicks its notification.
 */
export const Route = createFileRoute("/_connected/_shell")({
  loader: async ({ context: { controller, queryClient } }) => {
    const { client } = controller;
    try {
      await ensureShellData(queryClient, client);
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
  const threads = useSuspenseQuery(threadsQuery(controller.client)).data;
  // The dialog New thread has open: the project picker, or the New project
  // dialog its last row opens.
  const [dialog, setDialog] = useState<"picker" | "new-project" | null>(null);

  // Opens the Draft Thread in `projectId`, or in no project when it is
  // `undefined`, with the focus in its message field. A draft that mounts
  // takes the focus itself, but the draft that is already open does not mount
  // again, and the focus would stay on the New thread button the user
  // pressed.
  const openDraft = useCallback(
    (projectId: string | undefined) => {
      const search = projectId === undefined ? {} : { project: projectId };
      void navigate({ to: "/", search }).then(() => {
        document.getElementById(DRAFT_MESSAGE_ID)?.focus();
      });
    },
    [navigate],
  );

  const openNewThread = useCallback(() => {
    setDialog("picker");
  }, []);

  // Main shows the badge and the notifications, and keeps which it has
  // shown, but only the page holds the thread list.
  useSendOnChange(
    listWaitingThreads(threads),
    bridge.waitingThreads.set,
    "Could not update the dock badge and the threads' notifications:",
  );

  // Only a signed-in user can start a thread, so only the shell listens for
  // File > New Thread.
  useEffect(
    () =>
      bridge.menu.onCommand((command) => {
        if (command === "newThread") openNewThread();
      }),
    [bridge, openNewThread],
  );

  // A thread opened from the menu or a notification replaces whatever the
  // user was doing, the project picker included.
  useEffect(
    () =>
      bridge.thread.onOpen(({ sessionId }) => {
        setDialog(null);
        void navigate({ to: "/threads/$sessionId", params: { sessionId } });
      }),
    [bridge, navigate],
  );

  return (
    <>
      <Shell onNewThread={openNewThread}>
        <Outlet />
      </Shell>
      {/* Without a boundary of their own, a dialog's load would suspend the
          shell behind it. */}
      <Suspense fallback={null}>
        {dialog === "picker" ? (
          <ProjectPicker
            onPick={openDraft}
            onNewProject={() => {
              setDialog("new-project");
            }}
            onClose={() => {
              // The picker's close event fires after New project has already
              // asked for the next dialog, which must stay.
              setDialog((current) => (current === "picker" ? null : current));
            }}
          />
        ) : null}
        {dialog === "new-project" ? (
          <NewProjectDialog
            onAdded={openDraft}
            onClose={() => {
              setDialog(null);
            }}
          />
        ) : null}
      </Suspense>
    </>
  );
}
