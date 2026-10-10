import { useCallback, useEffect, useState, type JSX } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Outlet, redirect, useNavigate } from "@tanstack/react-router";
import { listUrgentSignals } from "@hercule/client-core";
import { LOGIN_PATH } from "../../app/entry-guard";
import { useLiveConnection } from "../../app/live";
import { useSendOnChange } from "../../app/send-on-change";
import { ensureShellData, pluginsQuery, signalsToDoQuery } from "../../app/queries";
import { useWaiting } from "../../app/waiting";
import { DRAFT_MESSAGE_ID } from "../../screens/new-thread/draft-composer";
import { Shell } from "../../shell";
import { buildWaitingRequest, useOpenDestination } from "./-destinations";
import { NewThreadDialogs, type NewThreadDialog } from "./-new-thread-dialogs";

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
 * While the user is signed in, the shell sends main the threads and the
 * assistants waiting on the user whenever that list changes, for the dock
 * badge and the notifications. It opens the destination main names when the
 * user chooses it in the Go menu or clicks its notification, as
 * `useOpenDestination` describes.
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
  const waiting = useWaiting();
  const openDestination = useOpenDestination();
  const [dialog, setDialog] = useState<NewThreadDialog | null>(null);

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
  // shown, but only the page holds the threads and the assistants.
  useSendOnChange(
    waiting.map(buildWaitingRequest),
    bridge.waiting.set,
    "Could not update the dock badge and the notifications:",
  );

  // Main notifies each new Now signal, but only the page holds the To do
  // list. The shell sends it, not Intake, so a Now signal notifies while
  // Intake is closed.
  const signals = useSuspenseQuery(signalsToDoQuery(controller.client)).data;
  const plugins = useSuspenseQuery(pluginsQuery(controller.client)).data;
  useSendOnChange(
    listUrgentSignals(signals, plugins),
    bridge.urgentSignals.set,
    "Could not update the urgent signal notifications:",
  );

  // Only a signed-in user can start a thread, open the Office, Intake or
  // Settings, so only the shell listens for File > New Thread, Go > Office,
  // Go > Intake and the app menu's Settings. The Office, Intake and Settings,
  // like a thread opened from the menu, replace whatever the user was doing,
  // the project picker included.
  useEffect(
    () =>
      bridge.menu.onCommand((command) => {
        if (command === "newThread") openNewThread();
        if (command === "openOffice") {
          setDialog(null);
          void navigate({ to: "/office" });
        }
        if (command === "openIntake") {
          setDialog(null);
          void navigate({ to: "/intake" });
        }
        if (command === "openSettings") {
          setDialog(null);
          void navigate({ to: "/settings" });
        }
      }),
    [bridge, navigate, openNewThread],
  );

  // A thread or an assistant opened from the menu or a notification replaces
  // whatever the user was doing, the project picker included.
  useEffect(
    () =>
      bridge.destination.onOpen((destination) => {
        setDialog(null);
        openDestination(destination);
      }),
    [bridge, openDestination],
  );

  return (
    <>
      <Shell onNewThread={openNewThread}>
        <Outlet />
      </Shell>
      <NewThreadDialogs dialog={dialog} setDialog={setDialog} onDraft={openDraft} />
    </>
  );
}
