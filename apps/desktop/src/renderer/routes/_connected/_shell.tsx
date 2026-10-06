import { lazy, Suspense, useCallback, useEffect, useState, type JSX } from "react";
import { useQueries, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Outlet, redirect, useMatch, useNavigate } from "@tanstack/react-router";
import { decideThreadPose, isSeatedPose, listWaitingThreads } from "@hercule/client-core";
import { LOGIN_PATH } from "../../app/entry-guard";
import { useLiveConnection } from "../../app/live";
import { useSendOnChange } from "../../app/send-on-change";
import {
  askingSubagentQuery,
  ensureShellData,
  runnersQuery,
  threadsQuery,
} from "../../app/queries";
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
 * Go > Office (⌘⇧O) opens the Office, and Settings… (⌘,) opens Settings.
 *
 * While the user is signed in, the shell sends main the threads waiting on
 * the user whenever the thread list changes, for the dock badge and the
 * threads' notifications. It opens the thread main names when the user
 * chooses it in the Go menu or clicks its notification: in the Office's
 * drawer while the Office is open and the thread has a colleague there, and
 * on its own screen otherwise.
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

  // A notification names the subagent that asked a thread's newest Request,
  // so the shell reads the subagents of those threads only, once per asker.
  // The shell holds no `subagent` topic of its own (spec 17 §What subagents
  // cost).
  const askers = threads.flatMap((session) => {
    const subagentId = session.openRequests.at(-1)?.subagentId;
    return subagentId === undefined ? [] : [{ sessionId: session.id, subagentId }];
  });
  const askerReads = useQueries({
    queries: askers.map(({ sessionId, subagentId }) =>
      askingSubagentQuery(controller.client, sessionId, subagentId),
    ),
  });
  const subagentsBySession = new Map(
    askers.flatMap(({ sessionId }, index) => {
      const subagents = askerReads[index]?.data;
      return subagents === undefined ? [] : [[sessionId, subagents] as const];
    }),
  );

  // Main shows the badge and the notifications, and keeps which it has
  // shown, but only the page holds the thread list. Main shows a Request's
  // notification once and never changes its words, so the list waits until
  // every asking subagent has been read: sent sooner, its notification would
  // read "A subagent asks:" for good. A read that fails sends the list with
  // that name.
  const namesPending = askerReads.some((read) => read.isPending);
  useSendOnChange(
    namesPending ? null : listWaitingThreads(threads, subagentsBySession),
    (waiting) => (waiting === null ? Promise.resolve() : bridge.waitingThreads.set(waiting)),
    "Could not update the dock badge and the threads' notifications:",
  );

  // Only a signed-in user can start a thread, open the Office or open
  // Settings, so only the shell listens for File > New Thread, Go > Office and
  // the app menu's Settings. The Office and Settings, like a thread opened
  // from the menu, replace whatever the user was doing, the project picker
  // included.
  useEffect(
    () =>
      bridge.menu.onCommand((command) => {
        if (command === "newThread") openNewThread();
        if (command === "openOffice") {
          setDialog(null);
          void navigate({ to: "/office" });
        }
        if (command === "openSettings") {
          setDialog(null);
          void navigate({ to: "/settings" });
        }
      }),
    [bridge, navigate, openNewThread],
  );

  // A thread opened from the menu or a notification replaces whatever the
  // user was doing, the project picker included. While the Office is open, a
  // thread with a colleague there opens in the Office's drawer, as its
  // sidebar row does, and any other thread opens on its own screen. The
  // thread and its runner are read from the cache when the thread is opened,
  // so the listener is not replaced each time the threads change.
  const officeOpen =
    useMatch({ from: "/_connected/_shell/office", shouldThrow: false }) !== undefined;
  useEffect(
    () =>
      bridge.thread.onOpen(({ sessionId }) => {
        setDialog(null);
        const { client } = controller;
        const session = queryClient
          .getQueryData(threadsQuery(client).queryKey)
          ?.find((each) => each.id === sessionId);
        const runner = queryClient
          .getQueryData(runnersQuery(client).queryKey)
          ?.find((each) => each.id === session?.runnerId);
        if (
          officeOpen &&
          session !== undefined &&
          isSeatedPose(decideThreadPose(session, runner))
        ) {
          void navigate({ to: "/office", search: { session: sessionId } });
        } else {
          void navigate({ to: "/threads/$sessionId", params: { sessionId } });
        }
      }),
    [bridge, controller, navigate, officeOpen, queryClient],
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
