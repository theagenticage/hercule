import type { JSX } from "react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { buildEntryDeps, resolveFirstRunEntry } from "../../app/entry-guard";
import { ensureFirstRunData, macUserQuery, setupQuery, setupTokenQuery } from "../../app/queries";
import { ControllerFirstRun } from "./-office";
import { takeStartRequested } from "./-start-flag";
import { NoControllerFirstRun } from "./-welcome";

/**
 * The first run: the welcome, then the four steps that set Hercule up, then
 * All set (spec 17, The first run).
 *
 * The route is split into a chunk of its own, with the room and every step,
 * and only a first run loads it. Its guard and its loader stay in the main
 * chunk, so they import nothing but the app's wiring.
 *
 * The loader reads everything the screen shows before it renders, so no part
 * of it waits on a read:
 *
 * - with no controller saved, nothing: the welcome itself looks for Hercule
 *   on this Mac and shows that it is looking;
 * - before setup, the setup token and the Mac's account name, for the
 *   account step;
 * - after setup, every read of the steps and the room.
 */
export const Route = createFileRoute("/first-run")({
  beforeLoad: async ({ context: { bridge, controller, queryClient } }) => {
    const elsewhere = await resolveFirstRunEntry(
      controller === null ? null : buildEntryDeps(controller.client, bridge, queryClient),
    );
    // The router redirects when a `redirect` is thrown. The thrown value is a
    // plain descriptor rather than an Error.
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    if (elsewhere !== null) throw redirect({ ...elsewhere, replace: true });
  },
  loader: async ({ context: { bridge, controller, queryClient } }) => {
    if (controller === null) return { startRequested: false };
    const startRequested = takeStartRequested();
    const { client } = controller;
    const setup = await queryClient.ensureQueryData(setupQuery(client));
    if (setup.complete) {
      await ensureFirstRunData(queryClient, client, bridge);
    } else {
      await Promise.all([
        queryClient.ensureQueryData(setupTokenQuery(bridge)),
        queryClient.ensureQueryData(macUserQuery(bridge)),
      ]);
    }
    return { startRequested };
  },
  staticData: { title: "Welcome" },
  component: FirstRun,
});

function FirstRun(): JSX.Element {
  const { controller } = Route.useRouteContext();
  const { startRequested } = Route.useLoaderData();
  return controller === null ? (
    <NoControllerFirstRun />
  ) : (
    <ControllerFirstRun controller={controller} startRequested={startRequested} />
  );
}
